import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { google } from "googleapis";
import type { AppConfig } from "../config.js";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
];

interface OAuthCreds {
  client_id: string;
  client_secret: string;
  redirect_uris?: string[];
}

async function loadClientCreds(path: string): Promise<OAuthCreds> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, OAuthCreds>;
  const creds = raw.installed ?? raw.web;
  if (!creds?.client_id || !creds?.client_secret) {
    throw new Error(`${path} is not a valid OAuth client (need installed/web client_id+secret).`);
  }
  return creds;
}

function makeOAuthClient(creds: OAuthCreds): OAuth2Client {
  const redirect = creds.redirect_uris?.[0] ?? "urn:ietf:wg:oauth:2.0:oob";
  return new google.auth.OAuth2(creds.client_id, creds.client_secret, redirect);
}

/** Step 1 of auth: a URL the user opens to grant Gmail send+read access. */
export async function getAuthUrl(cfg: AppConfig): Promise<string> {
  const client = makeOAuthClient(await loadClientCreds(cfg.GMAIL_CREDENTIALS_PATH));
  return client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });
}

/** Step 2: exchange the pasted code for a token and persist it. */
export async function saveTokenFromCode(cfg: AppConfig, code: string): Promise<void> {
  const client = makeOAuthClient(await loadClientCreds(cfg.GMAIL_CREDENTIALS_PATH));
  const { tokens } = await client.getToken(code.trim());
  await mkdir(dirname(cfg.GMAIL_TOKEN_PATH), { recursive: true });
  await writeFile(cfg.GMAIL_TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf8");
}

export async function getGmailClient(cfg: AppConfig): Promise<OAuth2Client> {
  const client = makeOAuthClient(await loadClientCreds(cfg.GMAIL_CREDENTIALS_PATH));
  let token: unknown;
  try {
    token = JSON.parse(await readFile(cfg.GMAIL_TOKEN_PATH, "utf8"));
  } catch {
    throw new Error("Gmail not authorized yet. Run: npm run campaign -- --auth");
  }
  client.setCredentials(token as Record<string, unknown>);
  return client;
}

function buildMime(opts: {
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
}): string {
  const headers = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "MIME-Version: 1.0",
  ];
  if (opts.inReplyTo) {
    headers.push(`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`);
  }
  const mime = `${headers.join("\r\n")}\r\n\r\n${opts.body}`;
  return Buffer.from(mime).toString("base64url");
}

export interface SendResult {
  id: string;
  threadId: string;
  rfcMessageId?: string;
}

export async function sendEmail(
  cfg: AppConfig,
  opts: { to: string; subject: string; body: string; threadId?: string; inReplyTo?: string },
): Promise<SendResult> {
  const auth = await getGmailClient(cfg);
  const gmail = google.gmail({ version: "v1", auth });
  const from = cfg.GMAIL_SENDER ?? "me";
  const raw = buildMime({ from, ...opts });
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, ...(opts.threadId ? { threadId: opts.threadId } : {}) },
  });
  const id = res.data.id!;
  const threadId = res.data.threadId ?? opts.threadId ?? id;
  // fetch the RFC822 Message-ID so follow-ups can thread correctly
  let rfcMessageId: string | undefined;
  try {
    const meta = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["Message-ID"],
    });
    rfcMessageId = meta.data.payload?.headers?.find((h) => /message-id/i.test(h.name ?? ""))?.value ?? undefined;
  } catch {
    /* non-fatal */
  }
  return { id, threadId, ...(rfcMessageId ? { rfcMessageId } : {}) };
}

export interface ThreadReply {
  snippet: string;
  fromMe: boolean;
}

export interface ThreadReplyInfo {
  from: string;
  snippet: string;
}

/** Look for a reply in the thread from someone other than us. */
export async function getThreadReply(
  cfg: AppConfig,
  threadId: string,
  senderEmail: string,
): Promise<ThreadReplyInfo | null> {
  const auth = await getGmailClient(cfg);
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.threads.get({ userId: "me", id: threadId, format: "metadata" });
  const messages = res.data.messages ?? [];
  for (const m of messages) {
    const from = m.payload?.headers?.find((h) => /^from$/i.test(h.name ?? ""))?.value ?? "";
    const isFromMe = senderEmail && from.toLowerCase().includes(senderEmail.toLowerCase());
    if (!isFromMe && from) {
      return { from, snippet: (m.snippet ?? "(reply received)").slice(0, 400) };
    }
  }
  return null;
}
