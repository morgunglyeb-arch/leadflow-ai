import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer } from "node:http";
import { google } from "googleapis";
import type { AppConfig } from "../config.js";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

const LOOPBACK_PORT = 42813;

// gmail.modify lets peer-warmup rescue messages from Spam and mark them
// read/important (it supersedes readonly). Existing send+readonly tokens keep
// working for the cold path; re-auth is only needed to enable warmup.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

/** One sending mailbox: its address and the OAuth token file backing it. */
export interface Inbox {
  email: string;
  tokenPath: string;
}

function sanitizeEmail(e: string): string {
  return e.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
}

function tokenPathFor(cfg: AppConfig, email: string): string {
  const base = cfg.GMAIL_TOKEN_PATH.replace(/\.json$/i, "");
  return `${base}_${sanitizeEmail(email)}.json`;
}

/**
 * The sending inboxes to rotate across. With GMAIL_ACCOUNTS set, each address
 * gets its own token file (so 3 accounts ≈ 3× the daily cap). The account that
 * matches GMAIL_SENDER keeps the legacy token path, so existing auth still
 * works. With GMAIL_ACCOUNTS empty, it's the single legacy inbox — unchanged.
 */
export function gmailInboxes(cfg: AppConfig): Inbox[] {
  const list = (cfg.GMAIL_ACCOUNTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) {
    return [{ email: cfg.GMAIL_SENDER ?? "me", tokenPath: cfg.GMAIL_TOKEN_PATH }];
  }
  return list.map((email) =>
    email === cfg.GMAIL_SENDER
      ? { email, tokenPath: cfg.GMAIL_TOKEN_PATH }
      : { email, tokenPath: tokenPathFor(cfg, email) },
  );
}

/** Find the inbox a lead was sent from (so follow-ups/replies use the same one). */
export function inboxByEmail(cfg: AppConfig, email?: string): Inbox | undefined {
  if (!email) return undefined;
  return gmailInboxes(cfg).find((b) => b.email.toLowerCase() === email.toLowerCase());
}

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

/**
 * Modern loopback OAuth flow (the deprecated copy-paste "OOB" flow no longer
 * works). Spins up a local server, prints the consent URL, and captures the
 * redirect with the code automatically — then saves the token.
 */
export async function authorizeInteractive(cfg: AppConfig, inbox?: Inbox): Promise<string> {
  const creds = await loadClientCreds(cfg.GMAIL_CREDENTIALS_PATH);
  const tokenPath = inbox?.tokenPath ?? cfg.GMAIL_TOKEN_PATH;
  const redirectUri = `http://localhost:${LOOPBACK_PORT}`;
  const client = new google.auth.OAuth2(creds.client_id, creds.client_secret, redirectUri);
  const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });

  console.log(
    `\n1. Open this URL, sign in with ${inbox ? `the inbox ${inbox.email}` : "your SENDING Gmail"}, and click Allow:\n`,
  );
  console.log(url + "\n");
  console.log("2. After you approve, this window captures the code automatically…\n");

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", redirectUri);
      const c = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<html><body style="font-family:sans-serif;padding:40px"><h2>${c ? "✓ Authorized — you can close this tab." : "Authorization failed."}</h2></body></html>`,
      );
      server.close();
      if (c) resolve(c);
      else reject(new Error(err ?? "no code returned"));
    });
    server.on("error", reject);
    server.listen(LOOPBACK_PORT);
    setTimeout(() => {
      server.close();
      reject(new Error("auth timed out after 5 min"));
    }, 300_000);
  });

  const { tokens } = await client.getToken(code);
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, JSON.stringify(tokens, null, 2), "utf8");
  return tokenPath;
}

export async function getGmailClient(cfg: AppConfig, inbox?: Inbox): Promise<OAuth2Client> {
  const client = makeOAuthClient(await loadClientCreds(cfg.GMAIL_CREDENTIALS_PATH));
  const tokenPath = inbox?.tokenPath ?? cfg.GMAIL_TOKEN_PATH;
  let token: unknown;
  try {
    token = JSON.parse(await readFile(tokenPath, "utf8"));
  } catch {
    throw new Error(
      `Gmail not authorized for ${inbox?.email ?? "the sender"} (no token at ${tokenPath}). Run: npm run campaign -- --auth`,
    );
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
    // Deliverability: a one-click unsubscribe header is a strong positive signal
    // for Gmail/Outlook bulk-sender heuristics (and surfaces a native unsubscribe
    // button). mailto points at the sending inbox; the honored opt-out channel
    // stays the in-thread "reply no" line in the body. No HTTPS endpoint, so no
    // List-Unsubscribe-Post One-Click (that would require a POST receiver).
    `List-Unsubscribe: <mailto:${opts.from}?subject=unsubscribe>`,
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
  inbox?: Inbox,
): Promise<SendResult> {
  const auth = await getGmailClient(cfg, inbox);
  const gmail = google.gmail({ version: "v1", auth });
  const from = inbox?.email ?? cfg.GMAIL_SENDER ?? "me";
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
function addressFromHeader(header: string): string | undefined {
  const m = header.match(/<([^>]+)>/) ?? header.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? (m[1] ?? m[0]) : undefined;
}

/**
 * Sweep an inbox for List-Unsubscribe mailto requests. The header we set
 * (`List-Unsubscribe: <mailto:from?subject=unsubscribe>`) makes a recipient's
 * native unsubscribe button send a FRESH email to the sending inbox with subject
 * "unsubscribe" — NOT a thread reply, so pollReplies (thread-scoped) never sees
 * it. This sweeps those out so the opt-out is honored. Returns the sender
 * addresses found and marks the messages read so they aren't reprocessed.
 */
export async function sweepUnsubscribes(cfg: AppConfig, inbox: Inbox): Promise<string[]> {
  const auth = await getGmailClient(cfg, inbox);
  const gmail = google.gmail({ version: "v1", auth });
  const q = "subject:unsubscribe is:unread newer_than:14d";
  const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 50 });
  const messages = list.data.messages ?? [];
  const senders: string[] = [];
  for (const m of messages) {
    if (!m.id) continue;
    try {
      const meta = await gmail.users.messages.get({
        userId: "me",
        id: m.id,
        format: "metadata",
        metadataHeaders: ["From"],
      });
      const fromHeader =
        meta.data.payload?.headers?.find((h) => /^from$/i.test(h.name ?? ""))?.value ?? "";
      const addr = addressFromHeader(fromHeader);
      if (addr && addr.toLowerCase() !== inbox.email.toLowerCase()) senders.push(addr.toLowerCase());
      await gmail.users.messages.modify({
        userId: "me",
        id: m.id,
        requestBody: { removeLabelIds: ["UNREAD"] },
      });
    } catch (err) {
      console.warn(`[unsub-sweep] ${inbox.email} msg ${m.id} failed: ${(err as Error).message}`);
    }
  }
  return senders;
}

export async function getThreadReply(
  cfg: AppConfig,
  threadId: string,
  senderEmail: string,
  inbox?: Inbox,
): Promise<ThreadReplyInfo | null> {
  const auth = await getGmailClient(cfg, inbox);
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
