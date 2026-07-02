// Self-healing inbox reputation guard.
//
// Every campaign run, the guard inspects each sending inbox and AUTO-PAUSES any
// whose sending domain is on a DNSBL or whose bounce rate has crept past the
// threshold. The rate is measured on activity SINCE the inbox last recovered (a
// baseline snapshot taken on resume), NOT lifetime — otherwise a one-off bad batch
// of addresses would keep an inbox paused forever (its old bounces never age out).
// A paused inbox is pulled from cold sending (it keeps warming, so its reputation
// recovers) for INBOX_PAUSE_DAYS, then AUTO-RESUMES when the pause expires. Pauses
// + baselines live in CampaignState (persisted), so they survive restarts.
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
  const baselines = (state.inbox_reputation_baseline ??= {});
  const nowMs = now.getTime();

  // Lifetime sent/bounces per inbox, computed once.
  const samples = inboxSamples(state, inboxEmails);
  const sampleByKey = new Map(samples.map((s) => [s.inbox.toLowerCase(), s]));

  // 1) auto-resume any pause that has expired. Snapshot a reputation BASELINE at the
  //    moment of resume so the guard next judges only bounces that occur AFTER
  //    recovery — a fixed-cause incident (e.g. a bad batch of guessed addresses) can
  //    no longer keep an inbox paused forever via a stuck lifetime rate.
  const resumedNow: string[] = [];
  for (const [inbox, p] of Object.entries(pauses)) {
    if (new Date(p.until).getTime() <= nowMs) {
      delete pauses[inbox];
      const s = sampleByKey.get(inbox);
      if (s) baselines[inbox] = { sent: s.sent, bounces: s.bounces };
      resumedNow.push(inbox);
    }
  }

  // 2) auto-pause inboxes that breach a reputation threshold — judged on activity
  //    SINCE the last resume baseline (lifetime for inboxes that were never paused).
  const pausedNow: { inbox: string; reason: string }[] = [];
  if (cfg.INBOX_GUARD_ENABLED) {
    for (const s of samples) {
      const key = s.inbox.toLowerCase();
      if (pauses[key]) continue; // already paused — don't extend
      const dom = emailDomain(s.inbox);
      const base = baselines[key] ?? { sent: 0, bounces: 0 };
      const sentSince = s.sent - base.sent;
      const bouncesSince = s.bounces - base.bounces;
      let reason = "";
      if (blacklistedDomains.has(dom)) {
        reason = `domain ${dom} on DNSBL`;
      } else if (sentSince >= cfg.INBOX_BOUNCE_MIN_SENT) {
        const rate = bouncesSince / sentSince;
        if (rate > cfg.INBOX_BOUNCE_PAUSE_RATE) {
          reason = `bounce rate ${(rate * 100).toFixed(1)}% > ${(cfg.INBOX_BOUNCE_PAUSE_RATE * 100).toFixed(0)}% (${bouncesSince}/${sentSince})`;
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
