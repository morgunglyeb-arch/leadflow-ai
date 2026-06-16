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
  selectDueFollowups,
  selectFirstTouches,
  warmupCap,
} from "./policy.js";
import { getThreadReply, sendEmail } from "./gmail.js";
import { classifyReply, isStopReply, isBounce } from "./classify.js";
import { summarizeAndLearn } from "./learn.js";
import { addToSuppression, isSuppressed, loadSuppression } from "./suppression.js";
import { suggestReply } from "../ai.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function inSendWindow(cfg: AppConfig): boolean {
  const [a, b] = cfg.SEND_WINDOW.split("-").map((s) => Number.parseInt(s.trim(), 10));
  if (a === undefined || b === undefined || Number.isNaN(a) || Number.isNaN(b)) return true;
  const h = new Date().getHours();
  return h >= a && h < b;
}

export interface CampaignFlags {
  mock: boolean;
  dryRun: boolean; // compute + log what it WOULD send, don't actually send
  topUp: boolean; // discover + enqueue fresh leads before sending
  concurrency?: number;
}

export async function runCampaign(cfg: AppConfig, flags: CampaignFlags): Promise<void> {
  const state = await loadState(cfg.CAMPAIGN_STATE_PATH);
  advanceWarmup(state);
  const cap = warmupCap(state, cfg);
  const live = cfg.SENDING_ENABLED && !flags.dryRun;
  console.log(
    `[campaign] day ${state.warmup_day} · cap ${cap}/day · sending=${live ? "LIVE" : "dry-run"} · queued=${
      Object.values(state.leads).filter((l) => l.status === "queued").length
    }`,
  );

  const suppression = await loadSuppression(cfg.SUPPRESSION_PATH);

  // 1) POLL replies on everything awaiting a response → stop sequences,
  //    handle bounces, and draft suggested responses to interested leads.
  if (live) await pollReplies(cfg, state, suppression);

  // 2) TOP UP the queue with fresh qualified leads (agent decides volume by
  //    sending pace, so we keep a backlog rather than a fixed count)
  if (flags.topUp) {
    const queued = Object.values(state.leads).filter((l) => l.status === "queued").length;
    if (queued < cap * 2) {
      const rows = await runProspecting(cfg, {
        dry: false,
        mock: flags.mock,
        force: false,
        sendTest: false,
        digest: false,
        limit: cap * 3,
        minFit: 3,
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

  // 3) SEND first touches — strongest queued leads, up to today's cap, in window
  const sendableNow = live && inSendWindow(cfg);
  if (live && !sendableNow) {
    console.log(`[campaign] outside send window (${cfg.SEND_WINDOW}) — skipping sends this run`);
  }
  const firstTouches = selectFirstTouches(state, cfg);
  console.log(`[campaign] first-touches to send: ${firstTouches.length}`);
  for (const lead of firstTouches) {
    await sendStep(cfg, lead, "initial", sendableNow);
    if (sendableNow) await sleep(jitterMs(cfg));
  }

  // 4) SEND due follow-ups (only to non-repliers, after the gap)
  const followups = selectDueFollowups(state, cfg);
  console.log(`[campaign] follow-ups due: ${followups.length}`);
  for (const lead of followups) {
    const which = lead.step === 1 ? "followup_1" : "followup_2";
    await sendStep(cfg, lead, which, sendableNow);
    if (sendableNow) await sleep(jitterMs(cfg));
  }

  // 5) LEARN + write replies-to-action for the operator
  await summarizeAndLearn(state);
  await writeRepliesToAction(cfg, state);

  await saveState(cfg.CAMPAIGN_STATE_PATH, state);
  const flagged = Object.values(state.leads).filter((l) => l.flagged).length;
  const needAction = Object.values(state.leads).filter(
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
  const sender = cfg.GMAIL_SENDER ?? "";
  const awaiting = Object.values(state.leads).filter(
    (l) => l.threadId && ["sent", "followup_1", "followup_2"].includes(l.status),
  );
  for (const lead of awaiting) {
    try {
      const reply = await getThreadReply(cfg, lead.threadId!, sender);
      if (!reply) continue;

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
      lead.reply = { at: new Date().toISOString(), snippet: reply.snippet, sentiment };
      if (isStopReply(sentiment)) {
        lead.status = sentiment === "not_interested" ? "opted_out" : "replied";
        logEvent(lead, "reply", sentiment);
        if (sentiment === "not_interested") {
          await addToSuppression(cfg.SUPPRESSION_PATH, lead.email, "opt-out");
          suppression.add(lead.email.toLowerCase());
        }
        // Draft a suggested response for interested / objection replies
        if (cfg.REPLY_ASSIST && (sentiment === "interested" || sentiment === "objection")) {
          try {
            lead.reply.suggested = await suggestReply(cfg, {
              company: lead.company,
              ourOffer: cfg.OUR_OFFER,
              ...(lead.snapshot.process ? { pitchedProcess: lead.snapshot.process } : {}),
              ...(lead.snapshot.automation ? { pitchedAutomation: lead.snapshot.automation } : {}),
              theirReply: reply.snippet,
            });
          } catch (err) {
            console.warn(`[campaign] reply draft failed for ${lead.domain}: ${(err as Error).message}`);
          }
        }
        console.log(
          `[campaign] reply from ${lead.company} (${sentiment})${sentiment === "interested" ? " ⭐ — drafted a response" : ""} — sequence stopped`,
        );
      }
    } catch (err) {
      console.warn(`[campaign] reply check failed for ${lead.domain}: ${(err as Error).message}`);
    }
  }
}

async function sendStep(
  cfg: AppConfig,
  lead: CampaignLead,
  which: "initial" | "followup_1" | "followup_2",
  live: boolean,
): Promise<void> {
  const body = lead.emails[which];
  if (!body) return;

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

  if (!live) {
    console.log(`[campaign] (dry) would send ${which} → ${lead.company} <${lead.email}>`);
    return;
  }
  try {
    const res = await sendEmail(cfg, {
      to: lead.email,
      subject,
      body,
      ...(lead.threadId ? { threadId: lead.threadId } : {}),
      ...(lead.lastMessageId ? { inReplyTo: lead.lastMessageId } : {}),
    });
    lead.threadId = res.threadId;
    if (res.rfcMessageId) lead.lastMessageId = res.rfcMessageId;
    lead.step = which === "initial" ? 1 : which === "followup_1" ? 2 : 3;
    lead.status = which === "initial" ? "sent" : which === "followup_1" ? "followup_1" : "followup_2";
    logEvent(lead, which === "initial" ? "sent" : which, `to ${lead.email}`);
    console.log(`[campaign] sent ${which} → ${lead.company} <${lead.email}>`);
  } catch (err) {
    logEvent(lead, "send_error", (err as Error).message);
    console.error(`[campaign] send failed for ${lead.company}: ${(err as Error).message}`);
  }
}
