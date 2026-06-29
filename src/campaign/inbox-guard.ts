// Self-healing inbox reputation guard.
//
// Every campaign run, the guard inspects each sending inbox and AUTO-PAUSES any
// whose sending domain is on a DNSBL or whose lifetime bounce rate has crept past
// the threshold. A paused inbox is pulled from cold sending (it keeps warming, so
// its reputation recovers) for INBOX_PAUSE_DAYS, then AUTO-RESUMES when the pause
// expires. Pauses live in CampaignState (persisted), so they survive restarts.
//
// The evaluation is a pure function (easy to test); the only impure part is the
// best-effort DNSBL lookup, isolated in `checkDomainBlacklist`.
import { promises as dnsp } from "node:dns";
import type { AppConfig } from "../config.js";
import type { CampaignState } from "./store.js";

const DAY_MS = 86_400_000;
const emailDomain = (e: string): string => e.split("@")[1]?.toLowerCase() ?? "";

export interface InboxSample {
  inbox: string;
  sent: number; // lifetime first-touches+ from leads pinned to this inbox
  bounces: number; // lifetime hard bounces on those leads
}

/** Per-inbox lifetime sent/bounces, derived from the leads pinned to each inbox. */
export function inboxSamples(state: CampaignState, inboxEmails: string[]): InboxSample[] {
  const leads = Object.values(state.leads);
  return inboxEmails.map((inbox) => {
    const lc = inbox.toLowerCase();
    const pinned = leads.filter((l) => (l.inbox ?? "").toLowerCase() === lc);
    return {
      inbox,
      sent: pinned.filter((l) => l.step >= 1).length,
      bounces: pinned.filter((l) => l.status === "bounced").length,
    };
  });
}

export interface GuardResult {
  pausedNow: { inbox: string; reason: string }[]; // newly paused this run
  resumedNow: string[]; // pauses that expired this run
  activePaused: Set<string>; // lowercased inbox emails currently paused
}

/**
 * Pure guard evaluation. MUTATES `state.inbox_pauses`:
 *  - clears expired pauses (auto-resume),
 *  - adds new pauses for inboxes whose domain is blacklisted or whose bounce rate
 *    exceeds the configured threshold (only once a meaningful sample exists).
 * Returns what changed plus the set of inbox emails to exclude from sending.
 */
export function evaluateInboxGuard(
  state: CampaignState,
  inboxEmails: string[],
  blacklistedDomains: Set<string>,
  cfg: AppConfig,
  now: Date,
): GuardResult {
  const pauses = (state.inbox_pauses ??= {});
  const nowMs = now.getTime();

  // 1) auto-resume any pause that has expired
  const resumedNow: string[] = [];
  for (const [inbox, p] of Object.entries(pauses)) {
    if (new Date(p.until).getTime() <= nowMs) {
      delete pauses[inbox];
      resumedNow.push(inbox);
    }
  }

  // 2) auto-pause inboxes that breach a reputation threshold
  const pausedNow: { inbox: string; reason: string }[] = [];
  if (cfg.INBOX_GUARD_ENABLED) {
    for (const s of inboxSamples(state, inboxEmails)) {
      const key = s.inbox.toLowerCase();
      if (pauses[key]) continue; // already paused — don't extend
      const dom = emailDomain(s.inbox);
      let reason = "";
      if (blacklistedDomains.has(dom)) {
        reason = `domain ${dom} on DNSBL`;
      } else if (s.sent >= cfg.INBOX_BOUNCE_MIN_SENT) {
        const rate = s.bounces / s.sent;
        if (rate > cfg.INBOX_BOUNCE_PAUSE_RATE) {
          reason = `bounce rate ${(rate * 100).toFixed(1)}% > ${(cfg.INBOX_BOUNCE_PAUSE_RATE * 100).toFixed(0)}% (${s.bounces}/${s.sent})`;
        }
      }
      if (reason) {
        pauses[key] = { until: new Date(nowMs + cfg.INBOX_PAUSE_DAYS * DAY_MS).toISOString(), reason };
        pausedNow.push({ inbox: s.inbox, reason });
      }
    }
  }

  return { pausedNow, resumedNow, activePaused: new Set(Object.keys(pauses)) };
}

/**
 * Best-effort Spamhaus DBL (domain blacklist) check. Returns the subset of
 * domains that are listed. Fail-OPEN: NXDOMAIN or any lookup error is treated as
 * "not listed" (we never pause an inbox just because a lookup failed). Spamhaus
 * returns 127.0.1.x for a real listing and 127.255.255.x for query errors/blocks,
 * which we ignore.
 */
export async function checkDomainBlacklist(domains: string[]): Promise<Set<string>> {
  const listed = new Set<string>();
  const uniq = [...new Set(domains.map((d) => d.toLowerCase()).filter(Boolean))];
  await Promise.all(
    uniq.map(async (d) => {
      try {
        const recs = await dnsp.resolve4(`${d}.dbl.spamhaus.org`);
        if (recs.some((r) => r.startsWith("127.0.1."))) listed.add(d);
      } catch {
        /* not listed / lookup failed — fail open */
      }
    }),
  );
  return listed;
}
