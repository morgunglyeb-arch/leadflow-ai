import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { authorizeInteractive, gmailInboxes } from "./campaign/gmail.js";
import { runCampaign, type CampaignFlags } from "./campaign/run.js";
import { runWarmup } from "./campaign/warmup.js";
import { loadState } from "./campaign/store.js";
import { emitError } from "./ops-emit.js";

type Mode = "run" | "auth" | "status" | "warmup";

function parseFlags(argv: string[]): { mode: Mode; flags: CampaignFlags } {
  const flags: CampaignFlags = { mock: false, dryRun: false, topUp: false };
  let mode: Mode = "run";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--auth") mode = "auth";
    else if (a === "--status") mode = "status";
    else if (a === "--warmup") mode = "warmup";
    else if (a === "--mock") flags.mock = true;
    else if (a === "--dry-run" || a === "--dry") flags.dryRun = true;
    else if (a === "--top-up") flags.topUp = true;
    else if (a === "--concurrency") flags.concurrency = Number.parseInt(argv[++i] ?? "0", 10);
    else if (a.startsWith("--concurrency=")) flags.concurrency = Number.parseInt(a.slice(14), 10);
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return { mode, flags };
}

function printHelp(): void {
  console.log(`LeadFlow AI — autonomous campaign (Gmail send + follow-up + learn)

Usage:
  npm run campaign -- --auth          One-time Google OAuth (paste the code)
  npm run campaign -- --top-up --dry  Discover+enqueue, show what it WOULD send
  npm run campaign -- --top-up        Discover, send (needs SENDING_ENABLED=true + auth)
  npm run campaign -- --status        Show campaign state summary
  npm run campaign -- --warmup        Run one peer-warmup pass (needs WARMUP_ENABLED=true + re-auth)

The agent decides HOW MANY to send: today's warmup cap × leads above the
quality bar (SEND_MIN_SCORE). It polls replies first (stops sequences on a
reply), sends the strongest queued leads, then due follow-ups, then learns.`);
}

async function doAuth(): Promise<void> {
  const cfg = loadConfig();
  const inboxes = gmailInboxes(cfg);
  // Authorize each inbox that isn't already authorized (skip ones with a token).
  for (const inbox of inboxes) {
    let hasToken = false;
    try {
      await readFile(inbox.tokenPath, "utf8");
      hasToken = true;
    } catch {
      hasToken = false;
    }
    if (hasToken) {
      console.log(`✓ ${inbox.email} already authorized (${inbox.tokenPath}) — skipping.`);
      continue;
    }
    console.log(`\n=== Authorizing ${inbox.email} ===`);
    const path = await authorizeInteractive(cfg, inbox);
    console.log(`✓ Token saved to ${path}.`);
  }
  console.log(`\nAll ${inboxes.length} inbox(es) ready. You can now run the campaign.`);
}

async function doStatus(): Promise<void> {
  const cfg = loadConfig();
  const state = await loadState(cfg.CAMPAIGN_STATE_PATH);
  const leads = Object.values(state.leads);
  const by: Record<string, number> = {};
  for (const l of leads) by[l.status] = (by[l.status] ?? 0) + 1;
  const inboxes = gmailInboxes(cfg);
  console.log(
    `Campaign — warmup day ${state.warmup_day}, ${leads.length} leads total, ${inboxes.length} inbox(es)`,
  );
  for (const [k, v] of Object.entries(by)) console.log(`  ${k}: ${v}`);
  const flagged = leads.filter((l) => l.flagged).length;
  if (flagged) console.log(`  (${flagged} spam-flagged → manual review)`);
  const today = new Date().toISOString().slice(0, 10);
  for (const b of inboxes) {
    const rec = state.inbox_sent?.[b.email];
    const sent = rec && rec.date === today ? rec.count : 0;
    console.log(`  inbox ${b.email}: ${sent} sent today`);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { mode, flags } = parseFlags(process.argv.slice(2));
  const run =
    mode === "auth"
      ? doAuth()
      : mode === "status"
        ? doStatus()
        : mode === "warmup"
          ? runWarmup(loadConfig(), { mock: flags.mock, dryRun: flags.dryRun })
          : runCampaign(loadConfig(), flags);
  run.catch(async (err) => {
    console.error("[campaign] fatal:", err);
    await emitError(err);
    process.exit(1);
  });
}
