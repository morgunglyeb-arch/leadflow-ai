import type { AppConfig } from "../config.js";
import { runProspecting, roiScore as roiScoreOf } from "../prospect.js";
import { loadBankLeads, segmentOf } from "./bank.js";
import { acquireRunLock } from "./lock.js";
import {
  loadState,
  saveState,
  enqueueLeads,
  logEvent,
  type CampaignLead,
  type CampaignState,
} from "./store.js";
import {
  advanceWarmup,
  coldRampReady,
  inboxRemaining,
  recordInboxSend,
  selectDueFollowups,
  selectFirstTouches,
  warmupCap,
} from "./policy.js";
import { warmupDay } from "./warmup.js";
import {
  getThreadReply,
  sendEmail,
  gmailInboxes,
  inboxByEmail,
  sweepUnsubscribes,
  sweepInboundReplies,
  markInboundProcessed,
  type InboundMsg,
  markUnsubProcessed,
  type Inbox,
  type UnsubRequest,
} from "./gmail.js";
import {
  classifyReply,
  classifyRejectionReason,
  isStopReply,
  isBounce,
  parseReturnDate,
} from "./classify.js";
import { summarizeAndLearn } from "./learn.js";
import { addToSuppression, isSuppressed, loadSuppression } from "./suppression.js";
import { passingSendingDomains, domainOf } from "./deliverability.js";
import { formatVariantForDomain } from "../outreach.js";
import { evaluateInboxGuard, checkDomainBlacklist } from "./inbox-guard.js";
import { isEmailableEntity } from "../compliance.js";
import { suggestReply } from "../ai.js";
import { verifyEmail } from "../verify-email.js";
import { spamLint } from "../spamlint.js";
import {
  emitReply,
  emitEvent,
  emitDraftSent,
  emitInboxHealth,
  emitSuppress,
  fetchSuppression,
  emitRunStart,
  emitRunEnd,
  emitError,
  emitStateBackup,
  fetchRemoteState,
  fetchActiveVerticals,
  replayFailedTelemetry,
} from "../ops-emit.js";
import { verticalFromQuery } from "../vertical.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Current hour (0-23) and weekday (0=Sun..6=Sat) in the given IANA timezone. */
function nowIn(tz: string): { hour: number; weekday: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
      weekday: "short",
    }).formatToParts(new Date());
    const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
    const wkStr = parts.find((p) => p.type === "weekday")?.value ?? "";
    const wkMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    // "24" can appear at midnight in some environments — normalise to 0.
    const hour = Number.parseInt(hourStr, 10) % 24;
    return { hour, weekday: wkMap[wkStr] ?? new Date().getDay() };
  } catch {
    const d = new Date();
    return { hour: d.getHours(), weekday: d.getDay() };
  }
}

/**
 * True when NOW (in the prospect's timezone) is inside a SEND_WINDOW hour range
 * — the time-of-day gate, shared by all leads. The day-of-week gate is per-lead
 * (see isWorkingDayNow) so cold mail lands on the business's OWN working days.
 */
function inSendHours(cfg: AppConfig): boolean {
  const { hour } = nowIn(cfg.SEND_TZ);
  const ranges = cfg.SEND_WINDOW.split(",")
    .map((r) => r.split("-").map((s) => Number.parseInt(s.trim(), 10)))
    .filter(([a, b]) => a !== undefined && b !== undefined && !Number.isNaN(a) && !Number.isNaN(b));
  if (ranges.length === 0) return true; // misconfigured window → don't block
  return ranges.some(([a, b]) => hour >= (a as number) && hour < (b as number));
}

/**
 * True when TODAY (prospect tz) is a working day for THIS lead. Uses the days
 * parsed from the business's own website (owner rule: "Maps lies, read the
 * site"); falls back to the global SEND_DAYS when the site didn't tell us.
 */
function isWorkingDayNow(cfg: AppConfig, workingDays?: string): boolean {
  const { weekday } = nowIn(cfg.SEND_TZ);
  const spec = (workingDays && workingDays.trim()) || cfg.SEND_DAYS;
  const days = spec
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));
  if (days.length === 0) return true; // unconfigured → don't block
  return days.includes(weekday);
}

export interface CampaignFlags {
  mock: boolean;
  dryRun: boolean; // compute + log what it WOULD send, don't actually send
  topUp: boolean; // discover + enqueue fresh leads before sending
  pollOnly?: boolean; // ONLY poll replies + sweep opt-outs + notify — never send.
  coldOnly?: boolean; // send ONLY cold first-touches this run (skip due follow-ups)
  // Runs on a frequent cron (every ~30m) so reply notifications are near-immediate
  // and KEEP WORKING while cold sending is paused (deliverability hold, nights, weekends).
  concurrency?: number;
}

// Post-send generation is best-effort; never let it hang the process (holding the
// run-lock, blocking the next cron). 2026-07-02: throttled providers made it spin
// ~80min, so the send crons queued behind the lock. Cap it — the send is already recorded.
const REFILL_TIMEOUT_MS = 20 * 60_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
        ms,
      );
      // don't let the timeout timer itself keep the process alive
      (t as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
}

export async function runCampaign(cfg: AppConfig, flags: CampaignFlags): Promise<void> {
  // R2: bookend the campaign/send run so it shows up in the hub and can't zombie as
  // `running` forever on a hard kill (prospect.ts already does this; campaign never
  // did → every real send-run would otherwise hang `running`).
  // Single-writer lock: never let two campaign runs (cron + manual, or overlapping
  // crons) send concurrently — that double-emails the same prospects and clobbers
  // state.json. If another LIVE run holds it, skip this one entirely.
  const release = acquireRunLock();
  if (!release) {
    console.warn("[campaign] another campaign run is active (lock held) — skipping this run");
    return;
  }
  // A graceful kill (launchctl kill / deploy / Ctrl-C) must NOT leave the lock held or
  // the run stuck "running": release the lock + best-effort fail the run on the way
  // out. (A hard SIGKILL can't run this — the hub-side watchdog reaps those.)
  let activeRunId: string | null = null;
  const onSignal = (sig: NodeJS.Signals): void => {
    console.error(`[campaign] ${sig} — releasing lock + marking run failed, exiting`);
    if (activeRunId) void emitRunEnd(activeRunId, { status: "failed" }).catch(() => {});
    try {
      release();
    } catch {
      /* already released */
    }
    process.exit(1);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    // Poll-only: reply-check pass on a frequent cron. Shares the run-lock (so it never
    // races a real send on state.json) but does NOT record a leadflow_run (would spam
    // the run log ~48×/day) — reply notifications fire inside pollReplies via emitReply.
    if (flags.pollOnly) {
      await runCampaignBody(cfg, flags);
      return;
    }
    const runId = await emitRunStart("campaign");
    activeRunId = runId;
    try {
      const { sent, refill } = await runCampaignBody(cfg, flags);
      // Record the run (sent count → hub / Mini App "отправлено сегодня") BEFORE the
      // slow, killable bank refill — so a throttled/interrupted generation can't lose
      // the send count. The refill is best-effort after reporting.
      await emitRunEnd(runId, { status: "done", sent });
      // Cap the best-effort refill so a throttled generation can't hang the run and
      // hold the lock (2026-07-02 incident) — the send is already recorded above.
      await withTimeout(refill(), REFILL_TIMEOUT_MS, "post-send refill").catch((e) =>
        console.warn(`[campaign] refill capped/failed: ${(e as Error).message}`),
      );
    } catch (err) {
      await emitRunEnd(runId, { status: "failed" });
      await emitError(err);
      throw err;
    }
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    release();
  }
}

async function runCampaignBody(
  cfg: AppConfig,
  flags: CampaignFlags,
): Promise<{ sent: number; refill: () => Promise<void> }> {
  let state = await loadState(cfg.CAMPAIGN_STATE_PATH);
  // Cloud/replaced-Mac RESTORE: a fresh runner has no local state.json → loadState
  // returns an empty day-1 state. If STATE_REMOTE is on, pull the last off-Mac backup
  // from the hub and persist it locally, so warmup/sequencing resume instead of
  // resetting (which would re-warm from day 1 and re-send suppressed leads). Default
  // off → the Mac (local file present) never hits this.
  if (cfg.STATE_REMOTE && state.warmup_day <= 1 && Object.keys(state.leads).length === 0) {
    const remote = await fetchRemoteState();
    if (remote && typeof remote === "object") {
      await saveState(cfg.CAMPAIGN_STATE_PATH, remote as CampaignState);
      state = await loadState(cfg.CAMPAIGN_STATE_PATH); // re-shape via the loader
      console.log(
        `[state] restored from hub backup (STATE_REMOTE) — warmup day ${state.warmup_day}, ${Object.keys(state.leads).length} leads`,
      );
    } else {
      console.warn("[state] STATE_REMOTE on but no hub backup available — starting fresh");
    }
  }
  let sentCount = 0;
  // Cold-send ramp counter (warmup_day) must only advance on days we actually
  // send cold mail — otherwise it climbs during the dry-run/peer-warmup window
  // and the cold ramp starts mid-curve (e.g. day 14 = full cap) instead of low
  // on the first live day. Peer-warmup uses its own counter, untouched by this.
  const live = cfg.SENDING_ENABLED && !flags.dryRun;
  if (live) advanceWarmup(state);
  const cap = warmupCap(state, cfg);
  let inboxes = gmailInboxes(cfg);
  // Manual kill-switch: let the owner pull a specific inbox out of sending without
  // de-authing it (e.g. one stuck in spam placement) via SEND_EXCLUDE_INBOXES.
  if (cfg.SEND_EXCLUDE_INBOXES.length > 0) {
    const excluded = new Set(cfg.SEND_EXCLUDE_INBOXES.map((e) => e.toLowerCase()));
    const before = inboxes.length;
    inboxes = inboxes.filter((b) => !excluded.has(b.email.toLowerCase()));
    if (inboxes.length < before)
      console.warn(
        `[campaign] SEND_EXCLUDE_INBOXES pulled ${before - inboxes.length} inbox(es): ${[...excluded].join(", ")}`,
      );
  }
  // Auto inbox-health guard — self-healing reputation protection. Pauses an inbox
  // (DNSBL hit / high bounce rate) for INBOX_PAUSE_DAYS so it recovers, and auto-
  // resumes it when the pause expires. Runs every campaign run = a daily check.
  if (cfg.INBOX_GUARD_ENABLED) {
    const blacklisted = flags.mock
      ? new Set<string>()
      : await checkDomainBlacklist(inboxes.map((b) => domainOf(b.email)));
    const guard = evaluateInboxGuard(state, inboxes.map((b) => b.email), blacklisted, cfg, new Date());
    if (guard.activePaused.size > 0) {
      const before = inboxes.length;
      inboxes = inboxes.filter((b) => !guard.activePaused.has(b.email.toLowerCase()));
      if (inboxes.length < before)
        console.warn(`[inbox-guard] ${before - inboxes.length} inbox(es) paused for reputation recovery`);
    }
    for (const p of guard.pausedNow) {
      console.warn(`[inbox-guard] PAUSED ${p.inbox} for ${cfg.INBOX_PAUSE_DAYS}d — ${p.reason}`);
      // Self-healing event, NOT a bug: the guard auto-resumes the inbox, so routing
      // this to the bugs table (via emitError) just leaves a permanent "open" ghost.
      // Emit as an event instead (deduped per inbox/day) — visible, not alarming.
      await emitEvent(
        "inbox_pause",
        { inbox: p.inbox, days: cfg.INBOX_PAUSE_DAYS, reason: p.reason },
        `inbox_pause:${p.inbox}:${new Date().toISOString().slice(0, 10)}`,
      );
    }
    for (const r of guard.resumedNow) console.log(`[inbox-guard] RESUMED ${r} (reputation pause expired)`);
  }
  // Deliverability gate — drop inboxes whose sending domain fails SPF/DKIM/DMARC
  // (warmup is pointless if auth is broken; sending from one burns reputation).
  if (cfg.DELIVERABILITY_GATE && !flags.mock && inboxes.length > 0) {
    const { passing, report } = await passingSendingDomains(inboxes.map((b) => b.email));
    for (const r of report) {
      if (!r.pass)
        console.warn(
          `[deliverability] ${r.domain} FAIL (spf:${r.spf} dkim:${r.dkim} dmarc:${r.dmarc}) — its inboxes will NOT send until fixed`,
        );
    }
    inboxes = inboxes.filter((b) => passing.has(domainOf(b.email)));
    if (inboxes.length === 0)
      console.warn("[deliverability] no sending domain passed — no first-touches will be sent this run");
  }
  const combinedCap = cap * inboxes.length;
  console.log(
    `[campaign] day ${state.warmup_day} · cap ${cap}/inbox × ${inboxes.length} inbox(es) = ${combinedCap}/day · ` +
      `sending=${live ? "LIVE" : "dry-run"} · queued=${
        Object.values(state.leads).filter((l) => l.status === "queued").length
      }`,
  );
  // FOOTGUN GUARD: with peer-warmup OFF, coldRampReady() is a no-op (fail-open) —
  // cold mail goes out on the send-side ramp alone, with NO reputation built by
  // two-way inbox traffic. Warn loudly every live run so this is never silent.
  if (live && !cfg.WARMUP_ENABLED) {
    console.warn(
      "[campaign] ⚠️ WARMUP_ENABLED=false while sending LIVE — peer-warmup is OFF and the cold-ramp gate is a no-op. " +
        "Inboxes build reputation from the send ramp only. To protect deliverability set WARMUP_ENABLED=true and schedule the `--warmup` pass.",
    );
  }

  const suppression = await loadSuppression(cfg.SUPPRESSION_PATH);

  // D1: merge the hub's cross-channel suppression (contacts.suppressed in Supabase —
  // opt-outs from the site, manual outreach, or replies the ops hub recorded). The
  // local file is per-machine; the hub is the single source of truth across channels,
  // so an opt-out on ANY channel blocks the cold machine. Best-effort: if the hub is
  // unreachable we fall back to the local file rather than block the run.
  const hubSuppressed = await fetchSuppression();
  if (hubSuppressed) for (const e of hubSuppressed) suppression.add(e.toLowerCase());

  // 0) Drain outcome telemetry that failed to reach the hub earlier (e.g. a reply/
  //    bounce recorded during a Mac-offline window) — best-effort, so it isn't lost.
  await replayFailedTelemetry().catch(() => 0);

  // 1) POLL replies on everything awaiting a response → stop sequences,
  //    handle bounces, and draft suggested responses to interested leads.
  //    Runs on a live send-run AND on the poll-only reply cron (so replies are still
  //    detected + notified while cold sending is paused).
  const newBounces = live || flags.pollOnly ? await pollReplies(cfg, state, suppression) : 0;

  // 1b) SWEEP List-Unsubscribe mailto requests across every sending inbox.
  //     These arrive as fresh emails (not thread replies), so pollReplies misses
  //     them — sweep + suppress so the one-click unsubscribe is genuinely honored.
  if ((live || flags.pollOnly) && !flags.mock)
    await sweepUnsubscribeRequests(cfg, state, suppression, inboxes);

  // Poll-only cron stops here: replies checked + opt-outs swept, persist the updated
  // reply/bounce statuses, then return WITHOUT sending or generating.
  if (flags.pollOnly) {
    await saveState(cfg.CAMPAIGN_STATE_PATH, state);
    await emitBankDepth(cfg, state); // refresh «Годных к отправке» every poll (~30 min)
    console.log("[campaign] poll-only: replies checked + opt-outs swept + state saved (no send)");
    return { sent: 0, refill: async () => {} };
  }

  // 2) FILL THE SEND QUEUE — fast, LLM-free, BEFORE sending. Fresh generation
  //    (slow: LLM + discovery, and crawls when free keys are RPM-throttled) is
  //    DEFERRED to step 5c, AFTER the day's ceiling is sent, so a rate-limited
  //    generation day can never starve the send. Today's room is filled here from
  //    the deep already-written bank (data/out/leads_enriched.csv), zero LLM.
  //    See step 5c for the post-send buffer refill.

  // 2b) BANK BACKFILL — owner policy: if fresh generation couldn't fill the buffer
  //     (LLM keys rate-limited/banned, verify down, slow free-tier, or a pure send
  //     run with no --top-up), top the queue up from already-WRITTEN banked leads
  //     (data/out/leads_enriched.csv) with ZERO LLM calls, so sending NEVER stalls
  //     behind generation. Freshest banked leads first (newest subjects). enqueueLeads
  //     dedups by email, so nothing already sent/queued re-enters. Runs every campaign.
  {
    const bankTarget = cfg.MAX_LEADS;
    const queuedNow = Object.values(state.leads).filter((l) => l.status === "queued").length;
    const gap = bankTarget - queuedNow;
    if (gap > 0) {
      // Order: proserv first, then trade, then other. Professional-services leads are
      // more often LIMITED COMPANIES, which the PECR corporate-only gate lets us send;
      // trades skew sole-trader (PECR-held → wasted slots). The email machine is also
      // proserv-leaning by strategy (trades go via manual channels). Within a segment,
      // freshest first. When supply < cap nothing is dropped — this only sets priority.
      const SEG_PRIORITY: Record<string, number> = { proserv: 0, trade: 1, other: 2, clinic: 3 };
      const bank = loadBankLeads()
        .reverse() // newest rows last in the append-only CSV → freshest first
        .filter((r) => !isSuppressed(suppression, r.domain, r.email))
        .sort(
          (a, b) =>
            (SEG_PRIORITY[segmentOf(a.discovery_query ?? "")] ?? 9) -
            (SEG_PRIORITY[segmentOf(b.discovery_query ?? "")] ?? 9),
        )
        .slice(0, gap);
      if (bank.length) {
        const added = enqueueLeads(state, bank, roiScoreOf, cfg);
        if (added > 0) {
          await saveState(cfg.CAMPAIGN_STATE_PATH, state);
          console.log(
            `[campaign] bank-backfill: enqueued ${added} banked lead(s) (queue was ${queuedNow}/${bankTarget}, ZERO LLM) — generation shortfall covered from stock`,
          );
        }
      }
    }
  }

  // 3) SEND first touches — strongest queued leads, rotated across inboxes
  //    (each inbox limited to its own warmup cap), up to the combined cap.
  // Hours gate is global; the working-DAY gate is applied per-lead at send time.
  const sendableNow = live && inSendHours(cfg);
  if (live && !sendableNow) {
    console.log(
      `[campaign] outside send hours (${cfg.SEND_WINDOW}h, ${cfg.SEND_TZ}) — skipping sends this run`,
    );
  }
  // Per-inbox remaining capacity today; round-robin pick the next inbox with room.
  const remaining = new Map(inboxes.map((b) => [b.email, inboxRemaining(state, cfg, b.email)]));
  const totalRoom = [...remaining.values()].reduce((a, b) => a + b, 0);
  // Per-DOMAIN remaining cold capacity today — caps total volume per sending
  // domain over the per-inbox cap (3 inboxes × 25 = 75/domain is too hot for
  // fresh domains). Sums today's sends across all inboxes sharing a domain.
  const sendDay = new Date().toISOString().slice(0, 10);
  const domainUsed = new Map<string, number>();
  for (const [email, rec] of Object.entries(state.inbox_sent ?? {})) {
    if (rec.date === sendDay) {
      const d = domainOf(email);
      domainUsed.set(d, (domainUsed.get(d) ?? 0) + rec.count);
    }
  }
  const domainRoom = new Map<string, number>();
  for (const b of inboxes) {
    const d = domainOf(b.email);
    if (!domainRoom.has(d))
      domainRoom.set(d, Math.max(0, cfg.SEND_DOMAIN_DAILY_CAP - (domainUsed.get(d) ?? 0)));
  }
  // Peer-warmup cold-ramp gate — hold first-touches until warmup has matured
  // (follow-ups to already-contacted leads continue regardless).
  let coldAllowed = true;
  if (cfg.WARMUP_ENABLED && !flags.mock) {
    const wday = await warmupDay(cfg);
    coldAllowed = coldRampReady(cfg, wday);
    if (!coldAllowed)
      console.log(
        `[warmup] cold first-touches paused — warmup day ${wday} < ${cfg.WARMUP_COLD_AFTER_DAYS}; follow-ups continue.`,
      );
  } else if (live && !cfg.WARMUP_ENABLED && !cfg.SEND_WITHOUT_WARMUP && !flags.mock) {
    // FAIL-CLOSED (audit #24): peer-warmup OFF + sending LIVE = no reputation base.
    // Previously this only warned and then sent — torching fresh domains. Now we HOLD
    // cold first-touches (follow-ups to already-contacted leads still go). A deliberate
    // send-ramp-only strategy must be opted into explicitly via SEND_WITHOUT_WARMUP=true.
    coldAllowed = false;
    console.error(
      "[campaign] ⛔ HOLDING cold first-touches — WARMUP_ENABLED=false and SEND_WITHOUT_WARMUP is not set. " +
        "Enable peer-warmup, or set SEND_WITHOUT_WARMUP=true to send on the ramp alone (deliberately).",
    );
  }
  // EMERGENCY STOP (brain-audit #5): if THIS run's reply-poll surfaced a burst of
  // fresh hard bounces from prior sends, stop digging — hold cold first-touches this
  // run and alert. Follow-ups (to already-contacted, non-bouncing leads) still go.
  if (coldAllowed && cfg.EMERGENCY_BOUNCE_STOP > 0 && newBounces >= cfg.EMERGENCY_BOUNCE_STOP) {
    coldAllowed = false;
    console.error(
      `[campaign] ⛔ EMERGENCY STOP — ${newBounces} fresh bounces this poll (≥${cfg.EMERGENCY_BOUNCE_STOP}); holding cold first-touches this run.`,
    );
    await emitEvent(
      "bounce_emergency_stop",
      { new_bounces: newBounces, threshold: cfg.EMERGENCY_BOUNCE_STOP },
      `bounce_emergency_stop:${new Date().toISOString().slice(0, 13)}`,
    );
  }
  // Optional per-run sub-cap spreads the daily volume across hourly runs in the
  // send window (anti-burst). 0 = off → use the full remaining room.
  const runRoom =
    cfg.SEND_PER_RUN_CAP > 0 ? Math.min(totalRoom, cfg.SEND_PER_RUN_CAP) : totalRoom;
  // Over-select candidates, then enforce PECR WHILE filling the day's room — so a
  // sole-trader caught by the PECR gate doesn't WASTE a send slot. The slot is
  // backfilled by the next clearly-incorporated lead in the queue. PECR stays
  // strict (held leads are never sent); we just don't leave the cap unfilled when
  // eligible incorporated leads are still queued. is_ltd is resolved lazily (and
  // cached on the lead) only until the room is filled, to bound Companies House calls.
  let firstTouches: CampaignLead[] = [];
  if (coldAllowed) {
    // EXPERIMENT sphere filter (E1): when EXPERIMENT_VERTICALS is set, restrict cold
    // first-touches to leads whose discovery_query matches — so the send population is
    // a clean experiment cohort even while the deep mixed bank holds other segments.
    // Over-select (all queued) before filtering so we can still fill the day's room.
    // When EXPERIMENT_REMOTE is on, the hub's experiment tracker (which advances the
    // wave autonomously by delivered-count) is the source of truth — fetch the active
    // segment's terms so a wave-advance re-aims sending with no .env edit; fall back to
    // the local env list on any miss so a hub outage never stops the send.
    let exp = cfg.EXPERIMENT_VERTICALS;
    if (cfg.EXPERIMENT_REMOTE) {
      const remote = await fetchActiveVerticals();
      if (remote) {
        exp = remote;
        console.log(`[experiment] active segment terms from hub: [${remote.join(", ")}]`);
      } else {
        console.warn("[experiment] hub terms unavailable — using local EXPERIMENT_VERTICALS");
      }
    }
    const rawPool = selectFirstTouches(state, cfg, exp.length ? 100_000 : runRoom * 5);
    const pool = exp.length
      ? rawPool.filter((l) => {
          const q = (l.snapshot?.discovery_query ?? "").toLowerCase();
          return exp.some((v) => q.includes(v));
        })
      : rawPool;
    if (exp.length)
      console.log(
        `[experiment] cold sends restricted to [${exp.join(", ")}] — ${pool.length}/${rawPool.length} queued match`,
      );
    let pecrHeld = 0;
    for (const l of pool) {
      if (firstTouches.length >= runRoom) break;
      if (cfg.SEND_CORPORATE_ONLY) {
        if (l.is_ltd === undefined && !flags.mock) {
          l.is_ltd = await isEmailableEntity(cfg, l.company);
        }
        if (!l.is_ltd) {
          pecrHeld++;
          continue; // held — backfill the slot from the next eligible lead
        }
      }
      firstTouches.push(l);
    }
    if (pecrHeld > 0)
      console.log(
        `[compliance] ${pecrHeld} sole-trader(s) held (PECR: need consent) — room backfilled with incorporated leads. SEND_CORPORATE_ONLY=false to override.`,
      );
  }
  console.log(
    `[campaign] first-touches to send: ${firstTouches.length} (room left today: ${totalRoom})`,
  );
  // 3b) SEND due follow-ups FIRST — warm threads to already-contacted leads are
  //     higher-value AND safer than new cold mail, so they get first claim on the
  //     day's capacity. They count against the SAME per-inbox + per-domain caps
  //     (F2: otherwise the ramp is fiction — a heavy follow-up day silently
  //     over-sends from an inbox). Cap reached → defer the follow-up to a later run.
  const followups = flags.coldOnly ? [] : selectDueFollowups(state, cfg);
  if (flags.coldOnly) console.log("[campaign] --cold-only: skipping due follow-ups this run (cold first-touches only)");
  // Reserve a share of the day's room for cold first-touches so a follow-up surge
  // can't consume the whole cap and starve new outbound (2026-07-06: 115 follow-ups
  // → ~0 cold). Cap TOTAL follow-ups this run so `coldGuarantee` slots stay for cold.
  // Reserve only as many as there are cold leads (never waste room when cold is dry).
  const coldGuarantee = Math.min(
    firstTouches.length,
    Math.floor(totalRoom * cfg.SEND_COLD_RESERVE_FRAC),
  );
  const fuBudget = Math.max(0, totalRoom - coldGuarantee);
  // Per-DOMAIN follow-up budget: reserve a cold share in EACH domain so a follow-up
  // backlog can't fill a domain's daily cap and starve cold first-touches. The global
  // fuBudget above is domain-blind — when SEND_DOMAIN_DAILY_CAP binds (not per-inbox),
  // follow-ups exhausted a domain's room before the cold loop ran, so a heavy
  // follow-up day sent 0 cold even with cold leads waiting (observed 2026-07-13).
  const fuDomainBudget = new Map<string, number>();
  for (const [d, room] of domainRoom) {
    const reserve = firstTouches.length > 0 ? Math.floor(room * cfg.SEND_COLD_RESERVE_FRAC) : 0;
    fuDomainBudget.set(d, Math.max(0, room - reserve));
  }
  const fuSentByDomain = new Map<string, number>();
  let fuSent = 0;
  console.log(
    `[campaign] follow-ups due: ${followups.length} · fu budget ${fuBudget}/${totalRoom} (reserving ${coldGuarantee} for cold)`,
  );
  for (const lead of followups) {
    if (fuSent >= fuBudget) break; // leave the rest of the room for cold this run
    const which = lead.step === 1 ? "followup_1" : "followup_2";
    const box = inboxByEmail(cfg, lead.inbox);
    if (box) {
      const d = domainOf(box.email);
      if ((remaining.get(box.email) ?? 0) <= 0 || (domainRoom.get(d) ?? 0) <= 0) continue;
      // keep each domain's cold reserve free even under a follow-up backlog
      if ((fuSentByDomain.get(d) ?? 0) >= (fuDomainBudget.get(d) ?? 0)) continue;
    }
    const sendLead = sendableNow && isWorkingDayNow(cfg, lead.working_days);
    const sent = await sendStep(cfg, lead, which, sendLead, box);
    if (sent && box) {
      recordInboxSend(state, box.email);
      remaining.set(box.email, (remaining.get(box.email) ?? 1) - 1);
      const d = domainOf(box.email);
      domainRoom.set(d, (domainRoom.get(d) ?? 1) - 1);
      sentCount++;
      fuSent++; // counts toward this run's follow-up budget (cold-reserve)
      fuSentByDomain.set(d, (fuSentByDomain.get(d) ?? 0) + 1); // per-domain cold reserve
      // R5: persist the 'sent' status BEFORE the next send so a crash can't replay
      // it (re-sending the same mail = reputation + PECR risk). State machine alone
      // left a window between sendEmail() and the end-of-run saveState().
      await saveState(cfg.CAMPAIGN_STATE_PATH, state);
      // Emit a distinct followup.sent event so the hub can split cold vs follow-up
      // over any range (cold first-touches emit draft.sent below; follow-ups had NO
      // event → the owner couldn't see how many of a day's sends were follow-ups).
      await emitEvent("followup.sent", {
        step: lead.step,
        which,
        email: lead.email,
        domain: lead.domain,
        inbox: box.email,
      });
    }
    if (sendLead) await sleep(jitterMs(cfg));
  }

  // 4) SEND first touches — strongest queued leads, across inboxes that still
  //    have BOTH per-inbox and per-domain room (F5) after follow-ups took theirs.
  let rr = 0;
  for (const lead of firstTouches) {
    let chosen: Inbox | undefined;
    for (let i = 0; i < inboxes.length; i++) {
      const cand = inboxes[(rr + i) % inboxes.length]!;
      if ((remaining.get(cand.email) ?? 0) > 0 && (domainRoom.get(domainOf(cand.email)) ?? 0) > 0) {
        chosen = cand;
        rr = rr + i + 1;
        break;
      }
    }
    if (!chosen) break; // every inbox hit a per-inbox OR per-domain cap
    // gate this lead to ITS own working days (from its website), not a global list
    const sendLead = sendableNow && isWorkingDayNow(cfg, lead.working_days);
    const sent = await sendStep(cfg, lead, "initial", sendLead, chosen);
    if (sent) {
      recordInboxSend(state, chosen.email);
      remaining.set(chosen.email, (remaining.get(chosen.email) ?? 1) - 1);
      const d = domainOf(chosen.email);
      domainRoom.set(d, (domainRoom.get(d) ?? 1) - 1);
      sentCount++;
      await saveState(cfg.CAMPAIGN_STATE_PATH, state); // R5: persist before next send
      // Record the SENT first-touch to the hub → "Контакты" shows who/when + the
      // email. Best-effort (postTo never throws); only real sends reach here.
      await emitDraftSent({
        email: lead.email,
        business: lead.company,
        domain: lead.domain,
        ...(lead.subject ? { subject: lead.subject } : {}),
        message: lead.emails.initial,
        sent_at: new Date().toISOString(),
        sent_via: chosen.email,
      });
    }
    if (sendableNow) await sleep(jitterMs(cfg));
  }

  // 4b) CAP-SHORTFALL VISIBILITY (owner policy: hit the daily ceiling EXACTLY). When
  //     we're live in send hours with cold sending allowed but couldn't fill this
  //     run's cold allowance, the limiter is SUPPLY — the queue ran dry of
  //     PECR-eligible (incorporated) leads — NOT the warmup ramp. Surface it loudly:
  //     otherwise a 0/few-lead day sends silently and looks like a healthy small ramp,
  //     hiding that generation (Gemini billing / verify credits) is the real blocker.
  if (live && sendableNow && coldAllowed) {
    const shortfall = runRoom - firstTouches.length;
    if (shortfall > 0) {
      const stillQueued = Object.values(state.leads).filter((l) => l.status === "queued").length;
      console.warn(
        `[campaign] CAP SHORTFALL: filled ${firstTouches.length}/${runRoom} cold slot(s) — out of PECR-eligible leads (${stillQueued} held/queued, bank empty of fresh). SUPPLY is the limiter, not the ramp → need generation (Gemini billing / verify credits).`,
      );
      // Self-healing / informational, NOT a bug — the next discovery run refills the
      // bank. Emit as an event (deduped per hour) instead of a permanent "open" bug.
      await emitEvent(
        "cap_shortfall",
        { filled: firstTouches.length, room: runRoom, queued: stillQueued },
        `cap_shortfall:${new Date().toISOString().slice(0, 13)}`,
      );
    }
  }

  // NOTE: the SLOW post-send buffer refill (generation) runs at the VERY END of the
  // run (step 6 below), AFTER learn + emits + state backup — so a throttled/killed
  // generation can never skip the learn step (which kept `learnings.md` stale) or
  // the inbox-health/backup emits. Send → learn → emit → THEN best-effort refill.

  // 5) LEARN + write replies-to-action for the operator
  await summarizeAndLearn(state, cfg);
  await writeRepliesToAction(cfg, state);

  await saveState(cfg.CAMPAIGN_STATE_PATH, state);
  const all = Object.values(state.leads);
  const flagged = all.filter((l) => l.flagged).length;

  // Per-inbox deliverability snapshot → Opero Ops inbox_health (best-effort).
  // One row per inbox, from leads pinned to it; lifetime sent/bounces/replies so
  // the hub can compute meaningful bounce/reply rates + status. Plus TODAY's split
  // (new first-touches vs follow-ups) so the Mini App shows how each inbox's daily
  // cap divided — follow-ups take first claim, cold fills the remainder.
  const todayStr = new Date().toISOString().slice(0, 10);
  const isToday = (at?: string): boolean => (at ?? "").startsWith(todayStr);
  await emitInboxHealth(
    inboxes.map((b) => {
      const pinned = all.filter((l) => l.inbox === b.email);
      const countEv = (pred: (ev: string) => boolean): number =>
        pinned.reduce(
          (n, l) => n + (l.history ?? []).filter((h) => isToday(h.at) && pred(h.event)).length,
          0,
        );
      // Report reputation SINCE the recovery baseline (same basis the send-guard
      // judges on), so a one-off incident (e.g. 2026-07-02) can't pin a recovered
      // inbox at "critical" on its LIFETIME rate forever. No baseline (never paused)
      // → lifetime == recent. A genuine NEW bounce after recovery still shows.
      const bl = state.inbox_reputation_baseline?.[b.email];
      const sentLife = pinned.filter((l) => l.step >= 1).length;
      const bounceLife = pinned.filter((l) => l.status === "bounced").length;
      return {
        domain: domainOf(b.email),
        inbox: b.email,
        warmup_day: state.warmup_day,
        sent: bl ? Math.max(0, sentLife - bl.sent) : sentLife,
        bounces: bl ? Math.max(0, bounceLife - bl.bounces) : bounceLife,
        replies: pinned.filter((l) => l.status === "replied" || l.status === "opted_out").length,
        sent_today: countEv((e) => e === "sent"),
        followups_today: countEv((e) => e === "followup_1" || e === "followup_2"),
      };
    }),
  );

  const needAction = all.filter(
    (l) => l.status === "replied" && l.reply?.sentiment === "interested",
  ).length;
  console.log(
    `[campaign] done.${needAction > 0 ? ` ${needAction} INTERESTED replies need your reply (see data/campaign/replies.md).` : ""}` +
      `${flagged > 0 ? ` ${flagged} flagged for manual review.` : ""} state → ${cfg.CAMPAIGN_STATE_PATH}`,
  );
  await emitStateBackup(state); // R4: off-Mac backup so warmup state survives a dead machine

  // Bank-depth snapshot → Mini App «Полка» tile. queued = the immediate send buffer;
  // ready = deeper enriched stock (in the CSV bank, not yet pulled into the pipeline);
  // active_ready = of that stock, how many match the active experiment wave (i.e. what
  // can actually send under the current EXPERIMENT_VERTICALS). No dedup_key → each run
  // appends a fresh row and the read side takes the newest. Best-effort; never blocks.
  await emitBankDepth(cfg, state);

  // 6) REFILL THE BANK — returned as a DEFERRED thunk, not run here. The caller
  //    (runCampaign) records the run via emitRunEnd(sent) FIRST, then awaits this.
  //    So the sent count reaches the hub (Mini App "отправлено сегодня") even when
  //    this SLOW step (LLM + discovery; crawls when Gemini is RPM-throttled, and
  //    gets killed on a manual/cron overlap) never finishes. Best-effort: a
  //    failure/limit just leaves the deep bank as-is for tomorrow's backfill.
  const refill = async (): Promise<void> => {
    if (!flags.topUp) return;
    const queued = Object.values(state.leads).filter((l) => l.status === "queued").length;
    const bufferTarget = cfg.MAX_LEADS;
    if (queued >= bufferTarget) return;
    try {
      const rows = await runProspecting(cfg, {
        dry: false,
        mock: flags.mock,
        force: false,
        sendTest: false,
        digest: false,
        limit: bufferTarget - queued,
        minFit: cfg.MIN_FIT,
        ...(flags.concurrency ? { concurrency: flags.concurrency } : {}),
      });
      const fresh = rows.filter((r) => !isSuppressed(suppression, r.domain, r.email));
      const added = enqueueLeads(state, fresh, roiScoreOf, cfg);
      console.log(
        `[campaign] post-send buffer refill: enqueued ${added} new lead(s) (queue was ${queued}/${bufferTarget}` +
          `${rows.length - fresh.length > 0 ? `, ${rows.length - fresh.length} suppressed` : ""})`,
      );
      await saveState(cfg.CAMPAIGN_STATE_PATH, state);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      console.warn(
        `[campaign] post-send buffer refill hit a limit (${msg}) — deep bank stays for tomorrow's backfill`,
      );
      await emitError(new Error(`post-send buffer refill failed (non-blocking; ceiling already sent): ${msg}`));
    }
  };

  return { sent: sentCount, refill };
}

function jitterMs(cfg: AppConfig): number {
  return Math.floor(Math.random() * cfg.SEND_JITTER_SEC * 1000);
}

async function writeRepliesToAction(cfg: AppConfig, state: CampaignState): Promise<void> {
  const interested = Object.values(state.leads).filter(
    (l) => l.reply && (l.reply.sentiment === "interested" || l.reply.sentiment === "objection"),
  );
  if (interested.length === 0) return;
  const path = "data/campaign/replies.md";
  const blocks = interested.map((l) => {
    return [
      `## ${l.company} <${l.email}> — ${l.reply?.sentiment}`,
      ``,
      `**They replied:** ${l.reply?.snippet}`,
      ``,
      l.reply?.suggested ? `**Suggested response (review & send):**\n\n${l.reply.suggested}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `# Replies needing your action\n\nUpdated ${new Date().toISOString()}\n\n${blocks.join("\n\n---\n\n")}\n`,
    "utf8",
  );
}

/** Emit the «Полка» bank-depth snapshot (incl. the TRUE sendable count) for the Mini
 * App. Runs at the end of every send AND poll pass, so «Годных к отправке» refreshes
 * ~every 30 min, not only on the 4 daily sends. Best-effort — never breaks the run. */
async function emitBankDepth(cfg: AppConfig, state: CampaignState): Promise<void> {
  try {
    const all = Object.values(state.leads);
    const bankStock = loadBankLeads();
    const inPipeline = new Set(all.map((l) => (l.email ?? "").toLowerCase()).filter(Boolean));
    const ready = bankStock.filter((r) => !inPipeline.has((r.email ?? "").toLowerCase()));
    const exp = (cfg.EXPERIMENT_VERTICALS ?? []).map((v) => v.toLowerCase());
    const matchesActive = (q?: string): boolean => {
      if (!exp.length) return true;
      const s = (q ?? "").toLowerCase();
      return exp.some((v) => s.includes(v));
    };
    const queuedLeads = all.filter((l) => l.status === "queued");
    const activeSupply =
      queuedLeads.filter((l) => matchesActive(l.snapshot?.discovery_query)).length +
      ready.filter((r) => matchesActive(r.discovery_query)).length;
    // The TRUE "ready to send" number the owner cares about: queued leads passing EVERY
    // send gate (not flagged, above the score bar, PECR-eligible, matching the wave).
    const sendableCold = queuedLeads.filter(
      (l) =>
        !l.flagged &&
        l.score >= cfg.SEND_MIN_SCORE &&
        l.is_ltd !== false &&
        matchesActive(l.snapshot?.discovery_query),
    ).length;
    // Cold leads sitting in the CSV bank (not yet enqueued) that WILL be pulled into
    // the queue at the next send — active-vertical + not a known sole-trader. Added so
    // the Mini App can show the SAME "ready today" number as the evening report
    // (queued-sendable + bank-that-enqueues), instead of only the already-queued slice.
    const bankCold = ready.filter(
      (r) => matchesActive(r.discovery_query) && r.is_ltd !== false,
    ).length;
    const followupsDue = selectDueFollowups(state, cfg).length;
    await emitEvent("bank_depth", {
      queued: queuedLeads.length,
      ready: ready.length,
      total: queuedLeads.length + ready.length,
      active_ready: activeSupply,
      sendable_cold: sendableCold,
      bank_cold: bankCold,
      followups_due: followupsDue,
      active_verticals: cfg.EXPERIMENT_VERTICALS ?? [],
      at: new Date().toISOString(),
    });
  } catch {
    /* bank-depth telemetry is best-effort — never break the run */
  }
}

async function pollReplies(
  cfg: AppConfig,
  state: CampaignState,
  suppression: Set<string>,
): Promise<number> {
  // Poll leads mid-sequence (sent/fu1/fu2) AND leads in a LIVE conversation —
  // F2: once a lead is "replied" with an interested/objection sentiment the deal
  // is still open, so keep watching the thread for their NEXT message and keep
  // drafting. Opt-outs/bounces/soft-declines/done are terminal and not re-polled.
  const isLiveConversation = (l: CampaignLead): boolean =>
    l.status === "replied" &&
    (l.reply?.sentiment === "interested" || l.reply?.sentiment === "objection");
  // Also re-check leads whose sequence has FINISHED ("done") — a prospect can reply
  // LATE, after the last follow-up, and we must still catch it (owner: never miss a
  // reply, even one that lands after we stopped chasing). Bounded to the last 60 days
  // so we don't re-poll ancient threads forever. Downtime is already covered: this
  // poll re-reads every open thread each run (every 30 min on the VPS, Mac-independent),
  // so a reply that arrived while the runner was off is caught on the next pass — and
  // getThreadReply keys on lastInboundId, so nothing is re-notified twice.
  const REPOLL_WINDOW_MS = 60 * 86_400_000;
  const lastActivityMs = (l: CampaignLead): number => {
    const h = l.history;
    return h.length ? new Date(h[h.length - 1]!.at).getTime() : 0;
  };
  const awaiting = Object.values(state.leads).filter(
    (l) =>
      l.threadId &&
      Date.now() - lastActivityMs(l) < REPOLL_WINDOW_MS &&
      (["sent", "followup_1", "followup_2", "done"].includes(l.status) ||
        isLiveConversation(l)),
  );
  let newBounces = 0; // brain-audit #5: a burst of fresh bounces → emergency-stop cold sends this run
  for (const lead of awaiting) {
    try {
      const sender = lead.inbox ?? cfg.GMAIL_SENDER ?? "";
      const reply = await getThreadReply(cfg, lead.threadId!, sender, inboxByEmail(cfg, lead.inbox));
      if (!reply) continue;

      // F2 turn-dedup: skip a message we already processed (otherwise every run
      // re-drafts + re-pushes the same reply). Only NEW inbound ids proceed.
      if (reply.id && reply.id === lead.reply?.lastInboundId) continue;

      // Bounce → stop + suppress the address (protects sender reputation)
      if (isBounce(reply.from, reply.snippet)) {
        lead.status = "bounced";
        newBounces += 1;
        logEvent(lead, "bounced", reply.from);
        await addToSuppression(cfg.SUPPRESSION_PATH, lead.email, "bounce");
        suppression.add(lead.email.toLowerCase());
        await emitSuppress(lead.email, "bounce"); // D1: write-through to the hub
        // Brain-audit #1b: emit a distinct BOUNCE outcome event (not just the
        // suppress) so the hub can compute bounce rate over time + attribute it to
        // inbox/vertical — the raw signal anomaly-detection (#4) reads. Idempotent.
        await emitEvent(
          "bounce",
          {
            email: lead.email,
            domain: lead.domain,
            inbox: lead.inbox ?? null,
            query: lead.snapshot?.discovery_query ?? null,
          },
          `bounce:${lead.email.toLowerCase()}`,
        );
        console.log(`[campaign] bounce for ${lead.company} — suppressed`);
        continue;
      }

      const sentiment = classifyReply(reply.snippet);
      // #1 learn-from-no: bucket WHY a negative reply declined, so the brain can
      // learn rejection reasons per segment. Only meaningful for negatives; a
      // positive/auto reply gets no reason. Pure capture — never triggers a send.
      const isNegative =
        sentiment === "not_interested" ||
        sentiment === "soft_decline" ||
        sentiment === "objection" ||
        sentiment === "unclear";
      const reason = isNegative ? classifyRejectionReason(reply.snippet) : undefined;
      lead.reply = {
        at: new Date().toISOString(),
        snippet: reply.snippet,
        sentiment,
        ...(reason ? { reason } : {}),
        ...(reply.id ? { lastInboundId: reply.id } : {}),
      };
      if (!isStopReply(sentiment)) {
        // Auto-reply: if it names a return date (a real holiday), pause follow-ups
        // until then; a standing auto-responder (no date) keeps its normal schedule.
        if (sentiment === "auto") {
          const back = parseReturnDate(reply.snippet);
          if (back) lead.followup_snooze_until = back.toISOString();
        }
        continue; // not a human answer — keep the sequence
      }

      // F7: only an EXPLICIT opt-out earns the permanent, irreversible suppress.
      // A soft "no thanks" stops the sequence but routes to the soft bucket —
      // the operator confirms in Telegram before any permanent ban.
      if (sentiment === "not_interested") {
        lead.status = "opted_out";
        await addToSuppression(cfg.SUPPRESSION_PATH, lead.email, "opt-out");
        suppression.add(lead.email.toLowerCase());
        await emitSuppress(lead.email, "opt-out"); // D1: write-through to the hub
      } else if (sentiment === "soft_decline") {
        // A clear "no" (no opt-out request): stop the sequence and CLOSE it as a soft
        // decline. NOT "replied" — that bucket is the owner's action queue («N ждут
        // ответа»), and a plain "no" needs no reply, so it must not sit there forever.
        // The reply still surfaces in the «Ответы» tab via the emitted event below.
        lead.status = "soft_decline";
      } else {
        // interested / objection / unclear → the owner's action queue.
        lead.status = "replied";
      }
      logEvent(lead, "reply", sentiment);

      // Draft a suggested reply for live conversations (interested/objection/
      // unclear). NOT for opt-outs (nothing to say) and NOT for soft declines
      // (don't counter-pitch a "no" — the operator decides whether to suppress).
      const shouldDraft =
        cfg.REPLY_ASSIST && sentiment !== "not_interested" && sentiment !== "soft_decline";
      if (shouldDraft) {
        try {
          lead.reply.suggested = await suggestReply(cfg, {
            company: lead.company,
            ourOffer: cfg.OUR_OFFER,
            ...(lead.snapshot.process ? { pitchedProcess: lead.snapshot.process } : {}),
            ...(lead.snapshot.automation ? { pitchedAutomation: lead.snapshot.automation } : {}),
            theirReply: reply.snippet,
          });
        } catch (err) {
          // F3: the most valuable moment to lose the LLM — alert the operator's
          // phone so a dead key pool never silently leaves a warm lead un-drafted.
          console.warn(`[campaign] reply draft failed for ${lead.domain}: ${(err as Error).message}`);
          await emitEvent("llm_exhausted", {
            context: "reply_draft",
            company: lead.company,
            provider: cfg.LLM_PROVIDER,
            note: "LLM failed while drafting a reply to a warm lead — operator got no draft. Rotate/replenish keys.",
          });
        }
      }
      console.log(
        `[campaign] reply from ${lead.company} (${sentiment})${lead.reply.suggested ? " ⭐ — drafted a response" : ""} — sequence stopped`,
      );
      // Push the reply + human draft to the owner's phone (Telegram via hub).
      // Best-effort, owner-only, never auto-sends — the operator decides.
      await emitReply({
        company: lead.company,
        sentiment: sentiment ?? "unclear",
        email: lead.email,
        ...(reply.id ? { replyId: reply.id } : {}),
        ...(reply.snippet ? { snippet: reply.snippet } : {}),
        ...(lead.reply.suggested ? { suggested: lead.reply.suggested } : {}),
        // F5 — angle attribution so the hub can learn per vertical × angle on WON.
        ...(verticalFromQuery(lead.snapshot.discovery_query)
          ? { vertical: verticalFromQuery(lead.snapshot.discovery_query) }
          : {}),
        ...(lead.variant ? { variant: lead.variant } : {}),
        ...(lead.snapshot.opener ? { opener: lead.snapshot.opener } : {}),
        ...(lead.subject ? { subject: lead.subject } : {}),
        ...(reason ? { reason } : {}),
      });
    } catch (err) {
      console.warn(`[campaign] reply check failed for ${lead.domain}: ${(err as Error).message}`);
    }
  }

  // Second pass — catch replies that broke threading (a prospect writes a FRESH email
  // instead of hitting Reply, or their client strips In-Reply-To). The thread-scoped
  // loop above never sees those, so a warm lead could answer and the owner never hear.
  try {
    await sweepUnthreadedReplies(cfg, state, suppression);
  } catch (err) {
    console.warn(`[reply-sweep] pass failed: ${(err as Error).message}`);
  }
  return newBounces;
}

/**
 * Second reply pass — catch replies that broke threading. A prospect sometimes
 * answers with a FRESH email (or a client strips In-Reply-To/References), so the
 * message never lands in the tracked thread and the thread-scoped pollReplies misses
 * it — a warm lead could reply and never reach the owner. This sweeps each inbox for
 * recent unread inbound, matches the sender to a known lead, and processes+notifies
 * any NEW message. Keyed on msgId (so a threaded reply pollReplies already handled is
 * not re-notified) and one message per lead per run. Mirrors sweepUnsubscribeRequests.
 */
async function sweepUnthreadedReplies(
  cfg: AppConfig,
  state: CampaignState,
  suppression: Set<string>,
): Promise<void> {
  const byEmail = new Map<string, CampaignLead>();
  for (const l of Object.values(state.leads)) {
    if (l.email) byEmail.set(l.email.toLowerCase(), l);
  }
  const handled = new Set<string>(); // at most one swept message per lead per run
  for (const inbox of gmailInboxes(cfg)) {
    let inbound: InboundMsg[] = [];
    try {
      inbound = await sweepInboundReplies(cfg, inbox);
    } catch (err) {
      console.warn(`[reply-sweep] ${inbox.email} failed: ${(err as Error).message}`);
      continue;
    }
    for (const msg of inbound) {
      const lead = byEmail.get(msg.email);
      if (!lead || handled.has(msg.email)) continue;
      // Terminal-negative leads stay closed; a message pollReplies already handled has
      // a matching lastInboundId (so we don't double-notify a normal threaded reply).
      if (lead.status === "opted_out" || lead.status === "bounced") continue;
      if (msg.msgId === lead.reply?.lastInboundId) continue;
      handled.add(msg.email);
      // Mark this swept message read so the next `is:unread` sweep can't re-catch it.
      // Two unread messages from one sender otherwise flip the single lastInboundId
      // A↔B and re-notify forever (observed: Arkwright ~15× in a day). Best-effort.
      await markInboundProcessed(cfg, inbox, msg.msgId).catch((e) =>
        console.warn(`[reply-sweep] mark-read ${msg.msgId} failed: ${(e as Error).message}`),
      );

      const sentiment = classifyReply(msg.snippet);
      const isNegative =
        sentiment === "not_interested" ||
        sentiment === "soft_decline" ||
        sentiment === "objection" ||
        sentiment === "unclear";
      const reason = isNegative ? classifyRejectionReason(msg.snippet) : undefined;
      lead.reply = {
        at: new Date().toISOString(),
        snippet: msg.snippet,
        sentiment,
        ...(reason ? { reason } : {}),
        lastInboundId: msg.msgId,
      };
      if (!isStopReply(sentiment)) {
        if (sentiment === "auto") {
          const back = parseReturnDate(msg.snippet);
          if (back) lead.followup_snooze_until = back.toISOString();
        }
        continue; // auto-reply: record, keep the sequence
      }

      if (sentiment === "not_interested") {
        lead.status = "opted_out";
        await addToSuppression(cfg.SUPPRESSION_PATH, lead.email, "opt-out");
        suppression.add(lead.email.toLowerCase());
        await emitSuppress(lead.email, "opt-out");
      } else if (sentiment === "soft_decline") {
        lead.status = "soft_decline";
      } else {
        lead.status = "replied";
      }
      logEvent(lead, "reply", sentiment);

      const shouldDraft =
        cfg.REPLY_ASSIST && sentiment !== "not_interested" && sentiment !== "soft_decline";
      if (shouldDraft) {
        try {
          lead.reply.suggested = await suggestReply(cfg, {
            company: lead.company,
            ourOffer: cfg.OUR_OFFER,
            ...(lead.snapshot.process ? { pitchedProcess: lead.snapshot.process } : {}),
            ...(lead.snapshot.automation ? { pitchedAutomation: lead.snapshot.automation } : {}),
            theirReply: msg.snippet,
          });
        } catch (err) {
          console.warn(`[reply-sweep] draft failed for ${lead.domain}: ${(err as Error).message}`);
        }
      }
      console.log(
        `[reply-sweep] OUT-OF-THREAD reply from ${lead.company} (${sentiment}) — caught + notified`,
      );
      await emitReply({
        company: lead.company,
        sentiment: sentiment ?? "unclear",
        email: lead.email,
        replyId: msg.msgId,
        ...(msg.snippet ? { snippet: msg.snippet } : {}),
        ...(lead.reply.suggested ? { suggested: lead.reply.suggested } : {}),
        ...(verticalFromQuery(lead.snapshot.discovery_query)
          ? { vertical: verticalFromQuery(lead.snapshot.discovery_query) }
          : {}),
        ...(lead.variant ? { variant: lead.variant } : {}),
        ...(lead.snapshot.opener ? { opener: lead.snapshot.opener } : {}),
        ...(lead.subject ? { subject: lead.subject } : {}),
        ...(reason ? { reason } : {}),
      });
    }
  }
}

/**
 * Honor List-Unsubscribe mailto requests: sweep each sending inbox for fresh
 * "unsubscribe" emails (the native one-click button sends one), suppress the
 * sender, and stop any in-flight sequence for that address.
 */
async function sweepUnsubscribeRequests(
  cfg: AppConfig,
  state: CampaignState,
  suppression: Set<string>,
  inboxes: Inbox[],
): Promise<void> {
  for (const inbox of inboxes) {
    let requests: UnsubRequest[] = [];
    try {
      requests = await sweepUnsubscribes(cfg, inbox);
    } catch (err) {
      console.warn(`[unsub-sweep] ${inbox.email} failed: ${(err as Error).message}`);
      continue;
    }
    for (const { email, msgId } of requests) {
      try {
        if (!suppression.has(email)) {
          // Persist FIRST (D5: only mark the message read once the opt-out is durable).
          await addToSuppression(cfg.SUPPRESSION_PATH, email, "unsubscribe-header");
          suppression.add(email);
          await emitSuppress(email, "unsubscribe-header"); // D1: write-through to the hub
          for (const lead of Object.values(state.leads)) {
            if (lead.email.toLowerCase() === email && lead.status !== "opted_out") {
              lead.status = "opted_out";
              logEvent(lead, "reply", "not_interested");
            }
          }
          console.log(`[unsub-sweep] honored unsubscribe from ${email} — suppressed`);
        }
        await markUnsubProcessed(cfg, inbox, msgId);
      } catch (err) {
        // Leave the message UNREAD so the next sweep retries — never lose an opt-out.
        console.warn(`[unsub-sweep] ${email} not finalized (will retry): ${(err as Error).message}`);
      }
    }
  }
}

export async function sendStep(
  cfg: AppConfig,
  lead: CampaignLead,
  which: "initial" | "followup_1" | "followup_2",
  live: boolean,
  inbox?: Inbox,
): Promise<boolean> {
  const body = lead.emails[which];
  if (!body) return false;

  // Spam gate (spam-doctor skill, enforced in code): a risky body hurts inbox
  // placement for the whole sending domain — never auto-send it. Flag the lead
  // for manual review and notify the operator instead.
  const lint = spamLint(body);
  if (lint.risky) {
    lead.flagged = true;
    logEvent(lead, "spam_flag", `${which}: ${lint.hits.join(", ")}`);
    console.warn(
      `[campaign] spam gate held ${which} → ${lead.company}: ${lint.hits.join(", ")} (flagged for review)`,
    );
    await emitEvent("spam_flag", {
      company: lead.company,
      email: lead.email,
      step: which,
      hits: lint.hits,
      score: lint.score,
    });
    return false;
  }

  // C1: re-verify the address right before the FIRST touch — it may have gone
  // dead since enrichment, and a hard bounce on a warming inbox is expensive.
  // Held (flagged) not suppressed: a transient DNS/MX blip shouldn't burn a lead.
  // SKIP when the address already passed a strong verifier recently (bank time): the
  // pipeline verifies every address once, so re-verifying here just double-spends the
  // Reoon daily quota (→ it runs out → fresh leads wrongly held on "verify degraded").
  const reverifyMaxAgeMs = cfg.SEND_REVERIFY_MAX_AGE_H * 3_600_000;
  const freshlyVerified =
    reverifyMaxAgeMs > 0 &&
    !!lead.verified_at &&
    Date.now() - new Date(lead.verified_at).getTime() < reverifyMaxAgeMs;
  if (which === "initial" && live && cfg.EMAIL_VERIFY && !freshlyVerified) {
    const v = await verifyEmail(cfg, lead.email);
    if (!v.ok) {
      // "verify-unavailable" (strict #3) is TRANSIENT — every verifier was down, not a
      // bad address. Don't flag (that would permanently bench the lead); just skip this
      // run so it retries once a verifier recovers. Real bad-address reasons (no-mx,
      // mx-only-role, bad-syntax) still flag the lead out.
      const transient = v.reason === "verify-unavailable";
      if (!transient) lead.flagged = true;
      logEvent(lead, "verify_fail", v.reason);
      console.warn(
        `[campaign] held first-touch → ${lead.company} <${lead.email}> — ` +
          (transient ? "verify degraded, will retry when a verifier is back" : `failed re-verify (${v.reason})`),
      );
      return false;
    }
  }

  // A/B: on the first touch, record which variant was sent so the learning loop
  // can compare reply rates by variant. When the FORMAT A/B is active, the tracked
  // variant MUST be the body-format one (formatVariantForDomain — the same
  // deterministic-by-domain selector that baked lead.emails), so reply-rate-by-
  // variant measures the format test (locked menu vs open variant), not the
  // subject. Otherwise fall back to the subject A/B.
  if (which === "initial" && !lead.variant) {
    if (cfg.EMAIL_FORMAT_AB) {
      lead.variant = formatVariantForDomain(lead.domain, cfg);
    } else if (lead.subjectB && Math.random() < 0.5) {
      lead.variant = "B";
      lead.subject = lead.subjectB;
    } else {
      lead.variant = "A";
    }
  }
  const subject =
    which === "initial" ? (lead.subject ?? `quick idea for ${lead.company}`) : `Re: ${lead.subject ?? lead.company}`;

  const via = inbox?.email ? ` via ${inbox.email}` : "";
  if (!live) {
    console.log(`[campaign] (dry) would send ${which} → ${lead.company} <${lead.email}>${via}`);
    return false;
  }
  try {
    const res = await sendEmail(
      cfg,
      {
        to: lead.email,
        subject,
        body,
        ...(lead.threadId ? { threadId: lead.threadId } : {}),
        ...(lead.lastMessageId ? { inReplyTo: lead.lastMessageId } : {}),
      },
      inbox,
    );
    lead.threadId = res.threadId;
    if (res.rfcMessageId) lead.lastMessageId = res.rfcMessageId;
    if (inbox?.email && which === "initial") lead.inbox = inbox.email; // pin the inbox to the thread
    lead.step = which === "initial" ? 1 : which === "followup_1" ? 2 : 3;
    lead.status = which === "initial" ? "sent" : which === "followup_1" ? "followup_1" : "followup_2";
    logEvent(lead, which === "initial" ? "sent" : which, `to ${lead.email}${via}`);
    console.log(`[campaign] sent ${which} → ${lead.company} <${lead.email}>${via}`);
    return true;
  } catch (err) {
    logEvent(lead, "send_error", (err as Error).message);
    console.error(`[campaign] send failed for ${lead.company}: ${(err as Error).message}`);
    return false;
  }
}
