import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppConfig } from "../config.js";
import type { OutputRow } from "../types.js";
import { assembleSequence } from "../outreach.js";
import { spamLint } from "../spamlint.js";

export type CampaignStatus =
  | "queued" // qualified, waiting to send
  | "sent" // first email sent
  | "followup_1" // first follow-up sent
  | "followup_2" // second follow-up sent
  | "replied" // they replied — sequence stopped
  | "bounced" // hard bounce
  | "opted_out" // asked to stop
  | "done"; // sequence exhausted, no reply

export interface ReplyRecord {
  at: string;
  snippet: string;
  sentiment?: "interested" | "not_interested" | "soft_decline" | "objection" | "auto" | "unclear";
  suggested?: string; // a drafted response for the operator to send
  reason?: string; // #1 learn-from-no: bucketed rejection reason (already_have/price/timing/not_relevant/opt_out)
  lastInboundId?: string; // Gmail message id of the inbound we last processed
  // (so multi-turn polling re-processes only NEW messages in the thread)
}

export interface CampaignLead {
  domain: string;
  company: string;
  email: string;
  status: CampaignStatus;
  step: number; // 0=none sent, 1=initial, 2=fu1, 3=fu2
  inbox?: string; // sending mailbox (multi-inbox): pinned on first send
  threadId?: string; // Gmail thread for reply detection + threading
  lastMessageId?: string; // RFC822 Message-ID for threading follow-ups
  subject?: string;
  subjectB?: string; // A/B alternative subject line
  variant?: "A" | "B"; // which subject was actually sent (for learning)
  score: number; // ROI/quality score at enqueue time
  flagged?: boolean; // spam-risk → held back from auto-send for manual review
  is_ltd?: boolean; // PECR: clearly-incorporated entity (heuristic / Companies House)
  working_days?: string; // weekday nums (0=Sun..6=Sat) the business is open, from its site
  history: Array<{ at: string; event: string; detail?: string }>;
  reply?: ReplyRecord;
  // the generated copy, frozen at enqueue so sending is deterministic
  emails: { initial: string; followup_1: string; followup_2: string };
  // snapshot for the learning loop
  snapshot: {
    fit_score?: number;
    process?: string;
    automation?: string;
    discovery_query?: string;
    subject?: string;
    opener?: string;
  };
}

export interface CampaignState {
  warmup_day: number; // 1-based; ramps the daily cap
  last_run_date?: string; // YYYY-MM-DD — to advance warmup once/day
  // per-inbox sends today (multi-inbox daily cap), keyed by inbox email
  inbox_sent?: Record<string, { date: string; count: number }>;
  // inbox email → reputation pause (auto-set by the inbox-guard on a DNSBL hit or
  // high bounce rate; auto-cleared when `until` passes). A paused inbox is pulled
  // from cold sending but keeps warming, so its reputation recovers, then it
  // auto-resumes. Keyed by lowercased inbox email.
  inbox_pauses?: Record<string, { until: string; reason: string }>;
  // inbox email → reputation baseline snapshot taken when a pause auto-resumes.
  // The guard then judges the bounce rate on activity SINCE the baseline (not
  // lifetime), so a fixed-cause incident (e.g. a bad batch of addresses) can't
  // keep an inbox paused forever: after resuming it only re-pauses on NEW bounces.
  inbox_reputation_baseline?: Record<string, { sent: number; bounces: number }>;
  leads: Record<string, CampaignLead>; // keyed by domain
}

const EMPTY: CampaignState = { warmup_day: 1, leads: {} };

export async function loadState(path: string): Promise<CampaignState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as CampaignState;
    return {
      warmup_day: parsed.warmup_day ?? 1,
      last_run_date: parsed.last_run_date,
      inbox_sent: parsed.inbox_sent ?? {},
      inbox_pauses: parsed.inbox_pauses ?? {},
      inbox_reputation_baseline: parsed.inbox_reputation_baseline ?? {},
      leads: parsed.leads ?? {},
    };
  } catch {
    return { ...EMPTY, inbox_sent: {}, leads: {} };
  }
}

export async function saveState(path: string, state: CampaignState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
}

export function logEvent(lead: CampaignLead, event: string, detail?: string): void {
  lead.history.push({ at: new Date().toISOString(), event, ...(detail ? { detail } : {}) });
}

/** Add newly-qualified leads to the campaign (skips ones already tracked). */
export function enqueueLeads(
  state: CampaignState,
  rows: OutputRow[],
  scoreOf: (r: OutputRow) => number,
  cfg: AppConfig,
): number {
  let added = 0;
  for (const r of rows) {
    if (!r.email) continue;
    const key = r.domain.toLowerCase();
    if (state.leads[key]) continue;
    const seq = assembleSequence(r, cfg);
    const spam = spamLint(seq.initial);
    state.leads[key] = {
      domain: r.domain,
      company: r.company,
      email: r.email,
      status: "queued",
      step: 0,
      score: scoreOf(r),
      ...(spam.risky ? { flagged: true } : {}),
      ...(r.is_ltd !== undefined ? { is_ltd: r.is_ltd } : {}),
      ...(r.working_days ? { working_days: r.working_days } : {}),
      ...(seq.subject ? { subject: seq.subject } : {}),
      ...(r.subject_b ? { subjectB: r.subject_b } : {}),
      history: [
        {
          at: new Date().toISOString(),
          event: "queued",
          ...(spam.risky ? { detail: `spam-flagged: ${spam.hits.join(", ")}` } : {}),
        },
      ],
      emails: {
        initial: seq.initial,
        followup_1: seq.followup_1,
        followup_2: seq.followup_2,
      },
      snapshot: {
        ...(r.fit_score !== undefined ? { fit_score: r.fit_score } : {}),
        ...(r.process ? { process: r.process } : {}),
        ...(r.automation ? { automation: r.automation } : {}),
        ...(r.discovery_query ? { discovery_query: r.discovery_query } : {}),
        ...(r.subject ? { subject: r.subject } : {}),
        ...(r.opener ? { opener: r.opener } : {}),
      },
    };
    added++;
  }
  return added;
}
