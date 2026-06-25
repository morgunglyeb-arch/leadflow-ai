import type { AppConfig } from "../config.js";
import { runProspecting, roiScore as roiScoreOf } from "../prospect.js";
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
  type Inbox,
} from "./gmail.js";
import { classifyReply, isStopReply, isBounce } from "./classify.js";
import { summarizeAndLearn } from "./learn.js";
import { addToSuppression, isSuppressed, loadSuppression } from "./suppression.js";
import { passingSendingDomains, domainOf } from "./deliverability.js";
import { isEmailableEntity } from "../compliance.js";
import { suggestReply } from "../ai.js";
import { verifyEmail } from "../verify-email.js";
import { spamLint } from "../spamlint.js";
import { emitReply, emitEvent, emitInboxHealth } from "../ops-emit.js";
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
  concurrency?: number;
}

export async function runCampaign(cfg: AppConfig, flags: CampaignFlags): Promise<void> {
  const state = await loadState(cfg.CAMPAIGN_STATE_PATH);
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

  // 1) POLL replies on everything awaiting a response → stop sequences,
  //    handle bounces, and draft suggested responses to interested leads.
  if (live) await pollReplies(cfg, state, suppression);

  // 1b) SWEEP List-Unsubscribe mailto requests across every sending inbox.
  //     These arrive as fresh emails (not thread replies), so pollReplies misses
  //     them — sweep + suppress so the one-click unsubscribe is genuinely honored.
  if (live && !flags.mock) await sweepUnsubscribeRequests(cfg, state, suppression, inboxes);

  // 2) TOP UP the queue with fresh qualified leads (agent decides volume by
  //    sending pace, so we keep a backlog rather than a fixed count)
  if (flags.topUp) {
    const queued = Object.values(state.leads).filter((l) => l.status === "queued").length;
    if (queued < combinedCap * 2) {
      const rows = await runProspecting(cfg, {
        dry: false,
        mock: flags.mock,
        force: false,
        sendTest: false,
        digest: false,
        limit: combinedCap * 3,
        minFit: cfg.MIN_FIT,
        ...(flags.concurrency ? { concurrency: flags.concurrency } : {}),
      });
      const fresh = rows.filter((r) => !isSuppressed(suppression, r.domain, r.email));
      const added = enqueueLeads(state, fresh, roiScoreOf, cfg);
      console.log(
        `[campaign] enqueued ${added} new leads (queue was ${queued}, cap ${cap}` +
          `${rows.length - fresh.length > 0 ? `, ${rows.length - fresh.length} suppressed` : ""})`,
      );
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
  // Optional per-run sub-cap spreads the daily volume across hourly runs in the
  // send window (anti-burst). 0 = off → use the full remaining room.
  const runRoom =
    cfg.SEND_PER_RUN_CAP > 0 ? Math.min(totalRoom, cfg.SEND_PER_RUN_CAP) : totalRoom;
  let firstTouches = coldAllowed ? selectFirstTouches(state, cfg, runRoom) : [];
  // Compliance gate (PECR) — only auto-send to clearly-incorporated entities.
  // Prefer the flag resolved at enqueue (Companies House / heuristic); resolve +
  // cache it on the lead for any older queued lead that predates the flag.
  if (cfg.SEND_CORPORATE_ONLY) {
    const before = firstTouches.length;
    const kept: CampaignLead[] = [];
    for (const l of firstTouches) {
      if (l.is_ltd === undefined && !flags.mock) {
        l.is_ltd = await isEmailableEntity(cfg, l.company);
      }
      if (l.is_ltd) kept.push(l);
    }
    firstTouches = kept;
    const held = before - firstTouches.length;
    if (held > 0)
      console.log(
        `[compliance] ${held} first-touch(es) held — not clearly incorporated (PECR: sole traders need consent). Set SEND_CORPORATE_ONLY=false to override.`,
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
  const followups = selectDueFollowups(state, cfg);
  console.log(`[campaign] follow-ups due: ${followups.length}`);
  for (const lead of followups) {
    const which = lead.step === 1 ? "followup_1" : "followup_2";
    const box = inboxByEmail(cfg, lead.inbox);
    if (box) {
      const d = domainOf(box.email);
      if ((remaining.get(box.email) ?? 0) <= 0 || (domainRoom.get(d) ?? 0) <= 0) continue;
    }
    const sendLead = sendableNow && isWorkingDayNow(cfg, lead.working_days);
    const sent = await sendStep(cfg, lead, which, sendLead, box);
    if (sent && box) {
      recordInboxSend(state, box.email);
      remaining.set(box.email, (remaining.get(box.email) ?? 1) - 1);
      const d = domainOf(box.email);
      domainRoom.set(d, (domainRoom.get(d) ?? 1) - 1);
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
    }
    if (sendableNow) await sleep(jitterMs(cfg));
  }

  // 5) LEARN + write replies-to-action for the operator
  await summarizeAndLearn(state);
  await writeRepliesToAction(cfg, state);

  await saveState(cfg.CAMPAIGN_STATE_PATH, state);
  const all = Object.values(state.leads);
  const flagged = all.filter((l) => l.flagged).length;

  // Per-inbox deliverability snapshot → Opero Ops inbox_health (best-effort).
  // One row per inbox, from leads pinned to it; lifetime sent/bounces/replies so
  // the hub can compute meaningful bounce/reply rates + status.
  await emitInboxHealth(
    inboxes.map((b) => {
      const pinned = all.filter((l) => l.inbox === b.email);
      return {
        domain: domainOf(b.email),
        inbox: b.email,
        warmup_day: state.warmup_day,
        sent: pinned.filter((l) => l.step >= 1).length,
        bounces: pinned.filter((l) => l.status === "bounced").length,
        replies: pinned.filter((l) => l.status === "replied" || l.status === "opted_out").length,
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

async function pollReplies(
  cfg: AppConfig,
  state: CampaignState,
  suppression: Set<string>,
): Promise<void> {
  // Poll leads mid-sequence (sent/fu1/fu2) AND leads in a LIVE conversation —
  // F2: once a lead is "replied" with an interested/objection sentiment the deal
  // is still open, so keep watching the thread for their NEXT message and keep
  // drafting. Opt-outs/bounces/soft-declines/done are terminal and not re-polled.
  const isLiveConversation = (l: CampaignLead): boolean =>
    l.status === "replied" &&
    (l.reply?.sentiment === "interested" || l.reply?.sentiment === "objection");
  const awaiting = Object.values(state.leads).filter(
    (l) =>
      l.threadId &&
      (["sent", "followup_1", "followup_2"].includes(l.status) || isLiveConversation(l)),
  );
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
        logEvent(lead, "bounced", reply.from);
        await addToSuppression(cfg.SUPPRESSION_PATH, lead.email, "bounce");
        suppression.add(lead.email.toLowerCase());
        console.log(`[campaign] bounce for ${lead.company} — suppressed`);
        continue;
      }

      const sentiment = classifyReply(reply.snippet);
      lead.reply = {
        at: new Date().toISOString(),
        snippet: reply.snippet,
        sentiment,
        ...(reply.id ? { lastInboundId: reply.id } : {}),
      };
      if (!isStopReply(sentiment)) continue; // auto-replies: ignore, keep sequence

      // F7: only an EXPLICIT opt-out earns the permanent, irreversible suppress.
      // A soft "no thanks" stops the sequence but routes to the soft bucket —
      // the operator confirms in Telegram before any permanent ban.
      if (sentiment === "not_interested") {
        lead.status = "opted_out";
        await addToSuppression(cfg.SUPPRESSION_PATH, lead.email, "opt-out");
        suppression.add(lead.email.toLowerCase());
      } else {
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
      });
    } catch (err) {
      console.warn(`[campaign] reply check failed for ${lead.domain}: ${(err as Error).message}`);
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
    let senders: string[] = [];
    try {
      senders = await sweepUnsubscribes(cfg, inbox);
    } catch (err) {
      console.warn(`[unsub-sweep] ${inbox.email} failed: ${(err as Error).message}`);
      continue;
    }
    for (const email of senders) {
      if (suppression.has(email)) continue;
      await addToSuppression(cfg.SUPPRESSION_PATH, email, "unsubscribe-header");
      suppression.add(email);
      for (const lead of Object.values(state.leads)) {
        if (lead.email.toLowerCase() === email && lead.status !== "opted_out") {
          lead.status = "opted_out";
          logEvent(lead, "reply", "not_interested");
        }
      }
      console.log(`[unsub-sweep] honored unsubscribe from ${email} — suppressed`);
    }
  }
}

async function sendStep(
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
  if (which === "initial" && live && cfg.EMAIL_VERIFY) {
    const v = await verifyEmail(cfg, lead.email);
    if (!v.ok) {
      lead.flagged = true;
      logEvent(lead, "verify_fail", v.reason);
      console.warn(
        `[campaign] held first-touch → ${lead.company} <${lead.email}> — failed re-verify (${v.reason})`,
      );
      return false;
    }
  }

  // A/B: on the first touch, randomly pick subject A or B and record it so the
  // learning loop can compare reply rates by variant.
  if (which === "initial" && !lead.variant) {
    if (lead.subjectB && Math.random() < 0.5) {
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
