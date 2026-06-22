import type { AppConfig } from "../config.js";
import type { CampaignLead, CampaignState } from "./store.js";

/** Today's send ceiling PER INBOX — ramps with warmup, capped at SEND_DAILY_CAP. */
export function warmupCap(state: CampaignState, cfg: AppConfig): number {
  const ramped = cfg.SEND_WARMUP_START + (state.warmup_day - 1) * cfg.SEND_WARMUP_STEP;
  return Math.min(cfg.SEND_DAILY_CAP, ramped);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** How many more first-touches this inbox may send today (per-inbox warmup cap). */
export function inboxRemaining(state: CampaignState, cfg: AppConfig, email: string): number {
  const cap = warmupCap(state, cfg);
  const rec = state.inbox_sent?.[email];
  const used = rec && rec.date === today() ? rec.count : 0;
  return Math.max(0, cap - used);
}

/** Record one send against an inbox's daily counter (resets each calendar day). */
export function recordInboxSend(state: CampaignState, email: string): void {
  if (!state.inbox_sent) state.inbox_sent = {};
  const rec = state.inbox_sent[email];
  if (!rec || rec.date !== today()) state.inbox_sent[email] = { date: today(), count: 1 };
  else rec.count += 1;
}

export function followupGaps(cfg: AppConfig): number[] {
  return cfg.FOLLOWUP_GAP_DAYS.split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function eventTime(lead: CampaignLead, event: string): number | undefined {
  const hit = lead.history.find((h) => h.event === event);
  return hit ? new Date(hit.at).getTime() : undefined;
}

function daysSince(ms: number | undefined): number {
  if (ms === undefined) return Infinity;
  return (Date.now() - ms) / 86_400_000;
}

/**
 * The agent decides HOW MANY to send: the strongest queued leads (score >=
 * SEND_MIN_SCORE), best first, up to today's warmup cap. Quality gates volume —
 * if there aren't enough strong leads, it sends fewer. Never blasts.
 */
export function selectFirstTouches(
  state: CampaignState,
  cfg: AppConfig,
  max?: number,
): CampaignLead[] {
  const limit = max ?? warmupCap(state, cfg);
  const queued = Object.values(state.leads)
    .filter((l) => l.status === "queued" && !l.flagged && l.score >= cfg.SEND_MIN_SCORE)
    .sort((a, b) => b.score - a.score);
  return queued.slice(0, limit);
}

/** Leads due for their next follow-up: sent, no reply, enough days elapsed. */
export function selectDueFollowups(state: CampaignState, cfg: AppConfig): CampaignLead[] {
  const gaps = followupGaps(cfg);
  const initialAtOf = (l: CampaignLead): number | undefined => eventTime(l, "sent");
  const due: CampaignLead[] = [];
  for (const l of Object.values(state.leads)) {
    if (l.status === "replied" || l.status === "opted_out" || l.status === "bounced") continue;
    const initialAt = initialAtOf(l);
    if (initialAt === undefined) continue; // not sent yet
    const elapsed = daysSince(initialAt);
    // step 1 (initial sent) → due for followup_1 after gaps[0]
    // step 2 (fu1 sent)     → due for followup_2 after gaps[1]
    if (l.step === 1 && gaps[0] !== undefined && elapsed >= gaps[0]) due.push(l);
    else if (l.step === 2 && gaps[1] !== undefined && elapsed >= gaps[1]) due.push(l);
  }
  return due;
}

/**
 * Cold-send readiness gate. When peer-warmup is ON, hold COLD first-touches
 * until warmup has run `WARMUP_COLD_AFTER_DAYS` days, so every inbox has a real
 * sending/receiving history before a stranger ever sees it. When warmup is OFF
 * this is a no-op (returns true) — the cold path is unchanged.
 */
export function coldRampReady(cfg: AppConfig, warmupDay: number): boolean {
  if (!cfg.WARMUP_ENABLED) return true;
  return warmupDay >= cfg.WARMUP_COLD_AFTER_DAYS;
}

/** Advance the warmup day at most once per calendar day. */
export function advanceWarmup(state: CampaignState): void {
  const today = new Date().toISOString().slice(0, 10);
  if (state.last_run_date !== today) {
    if (state.last_run_date) state.warmup_day += 1;
    state.last_run_date = today;
  }
}
