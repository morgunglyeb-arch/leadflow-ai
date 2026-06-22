/**
 * Peer warmup — free, in-house inbox warming. Our own sending inboxes email
 * each other a small, ramping volume of short, human-looking messages, then the
 * receiving side rescues them from Spam, marks them read/important, and replies
 * to a fraction. Two-way conversation between aged, engaged mailboxes is exactly
 * the signal mailbox providers reward, so cold mail later lands in the inbox.
 *
 * SAFETY: does NOTHING unless WARMUP_ENABLED=true. It also needs the
 * `gmail.modify` scope, so every inbox must be RE-authorized
 * (`npm run campaign -- --auth`) before this can rescue mail from Spam.
 * Best-effort throughout: a failure on one message never aborts the pass.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { google } from "googleapis";
import type { AppConfig } from "../config.js";
import { getGmailClient, gmailInboxes, type Inbox } from "./gmail.js";

export interface WarmupState {
  day: number; // 1-based; ramps the daily volume
  last_run_date?: string; // YYYY-MM-DD — advance the day once per calendar day
  // per-inbox warmup sends today, keyed by inbox email
  sent?: Record<string, { date: string; count: number }>;
}

const EMPTY: WarmupState = { day: 1, sent: {} };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function loadWarmupState(path: string): Promise<WarmupState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as WarmupState;
    return { day: parsed.day ?? 1, last_run_date: parsed.last_run_date, sent: parsed.sent ?? {} };
  } catch {
    return { ...EMPTY, sent: {} };
  }
}

async function saveWarmupState(path: string, state: WarmupState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
}

/** The current warmup day (for the cold-ramp gate). 1 if warmup hasn't run. */
export async function warmupDay(cfg: AppConfig): Promise<number> {
  const state = await loadWarmupState(cfg.WARMUP_STATE_PATH);
  return state.day;
}

/** Today's per-inbox warmup volume: linear ramp DAILY → DAILY_MAX over RAMP_DAYS. */
export function warmupDailyTarget(state: WarmupState, cfg: AppConfig): number {
  const span = cfg.WARMUP_DAILY_MAX - cfg.WARMUP_DAILY;
  const frac = cfg.WARMUP_RAMP_DAYS <= 1 ? 1 : Math.min(1, (state.day - 1) / (cfg.WARMUP_RAMP_DAYS - 1));
  return Math.round(cfg.WARMUP_DAILY + span * frac);
}

function warmupSentToday(state: WarmupState, email: string): number {
  const rec = state.sent?.[email];
  return rec && rec.date === today() ? rec.count : 0;
}

function recordWarmupSend(state: WarmupState, email: string): void {
  if (!state.sent) state.sent = {};
  const rec = state.sent[email];
  if (!rec || rec.date !== today()) state.sent[email] = { date: today(), count: 1 };
  else rec.count += 1;
}

// Short, innocuous, human chatter. Kept generic and free of links/CTAs so it
// reads as normal internal mail, never as marketing.
const SUBJECTS = [
  "quick note",
  "re: earlier",
  "the doc",
  "following up",
  "small thing",
  "notes",
  "fyi",
  "thoughts?",
  "this week",
  "quick q",
];

const BODIES = [
  "Got it, thanks — will take a look later today.",
  "Sounds good. Let's pick this up tomorrow.",
  "Thanks for sending that over, all clear on my end.",
  "Makes sense. I'll sort out my part and get back to you.",
  "Noted — nothing urgent, just wanted to keep you in the loop.",
  "Appreciate it. I'll review and share notes shortly.",
  "All good here. Talk soon.",
  "Cheers, that's helpful. Will follow up if anything comes up.",
];

const REPLIES = [
  "Perfect, thanks!",
  "Great, appreciate it.",
  "Got it — thanks for the quick turnaround.",
  "Sounds good to me.",
  "Thanks, that works.",
  "Noted, cheers.",
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
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
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`);
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${opts.body}`).toString("base64url");
}

export interface WarmupFlags {
  mock: boolean;
  dryRun: boolean;
}

/**
 * One warmup pass: SEND a ramping volume between our inboxes, then PROCESS each
 * inbox (rescue peer mail from Spam, mark read/important, reply to a fraction).
 */
export async function runWarmup(cfg: AppConfig, flags: WarmupFlags): Promise<void> {
  if (!cfg.WARMUP_ENABLED) {
    console.log("[warmup] WARMUP_ENABLED=false — nothing to do.");
    return;
  }
  const inboxes = gmailInboxes(cfg);
  if (inboxes.length < 2) {
    console.warn("[warmup] need at least 2 inboxes (GMAIL_ACCOUNTS) for peer warmup — skipping.");
    return;
  }

  const state = await loadWarmupState(cfg.WARMUP_STATE_PATH);
  // advance the warmup day at most once per calendar day
  if (state.last_run_date !== today()) {
    if (state.last_run_date) state.day += 1;
    state.last_run_date = today();
  }
  const target = warmupDailyTarget(state, cfg);
  console.log(
    `[warmup] day ${state.day} · target ${target}/inbox · ${inboxes.length} inboxes · ${flags.dryRun ? "dry-run" : "live"}`,
  );

  // 1) SEND — each inbox sends up to (target - alreadySentToday) to random peers.
  let sent = 0;
  for (const from of inboxes) {
    const remaining = Math.max(0, target - warmupSentToday(state, from.email));
    const peers = shuffle(inboxes.filter((b) => b.email !== from.email));
    for (let i = 0; i < remaining; i++) {
      const to = peers[i % peers.length]!;
      if (flags.dryRun || flags.mock) {
        sent++;
        recordWarmupSend(state, from.email);
        continue;
      }
      try {
        await sendWarmup(cfg, from, to.email, pick(SUBJECTS), pick(BODIES));
        recordWarmupSend(state, from.email);
        sent++;
        await sleep(jitter());
      } catch (err) {
        console.warn(`[warmup] send ${from.email}→${to.email} failed: ${(err as Error).message}`);
      }
    }
  }

  // 2) PROCESS — rescue peer mail from Spam, mark read/important, reply to some.
  let rescued = 0;
  let replied = 0;
  if (!flags.dryRun && !flags.mock) {
    const peerEmails = inboxes.map((b) => b.email);
    for (const box of inboxes) {
      try {
        const res = await processInbox(cfg, box, peerEmails, cfg.WARMUP_REPLY_RATE);
        rescued += res.rescued;
        replied += res.replied;
      } catch (err) {
        console.warn(`[warmup] process ${box.email} failed: ${(err as Error).message}`);
      }
    }
  }

  await saveWarmupState(cfg.WARMUP_STATE_PATH, state);
  console.log(`[warmup] done — sent ${sent}, rescued ${rescued}, replied ${replied}.`);
}

async function sendWarmup(
  cfg: AppConfig,
  from: Inbox,
  to: string,
  subject: string,
  body: string,
): Promise<void> {
  const auth = await getGmailClient(cfg, from);
  const gmail = google.gmail({ version: "v1", auth });
  const raw = buildMime({ from: from.email, to, subject, body });
  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
}

async function processInbox(
  cfg: AppConfig,
  box: Inbox,
  peerEmails: string[],
  replyRate: number,
): Promise<{ rescued: number; replied: number }> {
  const auth = await getGmailClient(cfg, box);
  const gmail = google.gmail({ version: "v1", auth });
  const fromQuery = peerEmails
    .filter((e) => e.toLowerCase() !== box.email.toLowerCase())
    .map((e) => `from:${e}`)
    .join(" OR ");
  const q = `(${fromQuery}) is:unread newer_than:3d`;
  const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 25 });
  const messages = list.data.messages ?? [];

  let rescued = 0;
  let replied = 0;
  for (const m of messages) {
    if (!m.id) continue;
    try {
      // Rescue from Spam + mark read + flag important (the engagement signal).
      await gmail.users.messages.modify({
        userId: "me",
        id: m.id,
        requestBody: { removeLabelIds: ["SPAM", "UNREAD"], addLabelIds: ["IMPORTANT"] },
      });
      rescued++;

      if (Math.random() < replyRate) {
        const meta = await gmail.users.messages.get({
          userId: "me",
          id: m.id,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Message-ID"],
        });
        const headers = meta.data.payload?.headers ?? [];
        const fromHeader = headers.find((h) => /^from$/i.test(h.name ?? ""))?.value ?? "";
        const subjHeader = headers.find((h) => /^subject$/i.test(h.name ?? ""))?.value ?? "";
        const msgId = headers.find((h) => /message-id/i.test(h.name ?? ""))?.value ?? undefined;
        const toAddr = extractEmail(fromHeader);
        if (toAddr) {
          const replySubject = /^re:/i.test(subjHeader) ? subjHeader : `Re: ${subjHeader}`;
          const raw = buildMime({
            from: box.email,
            to: toAddr,
            subject: replySubject,
            body: pick(REPLIES),
            ...(msgId ? { inReplyTo: msgId } : {}),
          });
          await gmail.users.messages.send({
            userId: "me",
            requestBody: { raw, ...(m.threadId ? { threadId: m.threadId } : {}) },
          });
          replied++;
          await sleep(jitter());
        }
      }
    } catch (err) {
      console.warn(`[warmup] message ${m.id} in ${box.email} failed: ${(err as Error).message}`);
    }
  }
  return { rescued, replied };
}

function extractEmail(header: string): string | undefined {
  const m = header.match(/<([^>]+)>/) ?? header.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? (m[1] ?? m[0]) : undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function jitter(): number {
  return 2000 + Math.floor(Math.random() * 6000);
}
