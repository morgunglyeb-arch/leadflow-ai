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
import { classifyReply, isStopReply } from "./classify.js";
import { summarizeAndLearn } from "./learn.js";

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

  // 1) POLL replies on everything awaiting a response → stop sequences
  if (live) await pollReplies(cfg, state);

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
      const added = enqueueLeads(state, rows, roiScoreOf, cfg);
      console.log(`[campaign] enqueued ${added} new leads (queue was ${queued}, cap ${cap})`);
    }
  }

  // 3) SEND first touches — the strongest queued leads, up to today's cap
  const firstTouches = selectFirstTouches(state, cfg);
  console.log(`[campaign] first-touches to send: ${firstTouches.length}`);
  for (const lead of firstTouches) {
    await sendStep(cfg, lead, "initial", live);
  }

  // 4) SEND due follow-ups (only to non-repliers, after the gap)
  const followups = selectDueFollowups(state, cfg);
  console.log(`[campaign] follow-ups due: ${followups.length}`);
  for (const lead of followups) {
    const which = lead.step === 1 ? "followup_1" : "followup_2";
    await sendStep(cfg, lead, which, live);
  }

  // 5) LEARN from outcomes
  await summarizeAndLearn(state);

  await saveState(cfg.CAMPAIGN_STATE_PATH, state);
  const flagged = Object.values(state.leads).filter((l) => l.flagged).length;
  console.log(
    `[campaign] done. ${flagged > 0 ? `${flagged} flagged for manual review. ` : ""}state → ${cfg.CAMPAIGN_STATE_PATH}`,
  );
}

async function pollReplies(cfg: AppConfig, state: CampaignState): Promise<void> {
  const sender = cfg.GMAIL_SENDER ?? "";
  const awaiting = Object.values(state.leads).filter(
    (l) => l.threadId && ["sent", "followup_1", "followup_2"].includes(l.status),
  );
  for (const lead of awaiting) {
    try {
      const reply = await getThreadReply(cfg, lead.threadId!, sender);
      if (reply) {
        const sentiment = classifyReply(reply);
        lead.reply = { at: new Date().toISOString(), snippet: reply, sentiment };
        if (isStopReply(sentiment)) {
          lead.status = sentiment === "not_interested" ? "opted_out" : "replied";
          logEvent(lead, "reply", sentiment);
          console.log(`[campaign] reply from ${lead.company} (${sentiment}) — sequence stopped`);
        }
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
