// Bridge already-WRITTEN banked leads (leads_enriched.csv) into the campaign send
// queue WITHOUT any LLM/Gemini call. The copy was generated in earlier runs; here we
// only enqueue it so the machine can SEND it. Sending needs no Gemini.
//   npx tsx scripts/enqueue-banked.ts            # new-ICP (trade+proserv), verified
//   SEGMENTS=trade,proserv,clinic ... to include clinics
//
// NOTE: the SAME backfill now runs AUTOMATICALLY inside every `campaign` run (run.ts
// step 2b) — if generation underfills the queue (key limits/bans/verify down), the
// run tops up from the bank itself. This script remains for manual/one-off enqueues.
import { loadConfig } from "../src/config";
import { loadState, saveState, enqueueLeads } from "../src/campaign/store";
import { loadBankLeads, allowedSegments } from "../src/campaign/bank";

(async () => {
  const cfg = loadConfig();
  const allow = allowedSegments();
  const out = loadBankLeads(allow);
  if (!out.length) throw new Error("no sendable banked leads (empty/missing CSV or all filtered)");

  const state = await loadState(cfg.CAMPAIGN_STATE_PATH);
  const before = Object.keys(state.leads).length;
  const added = enqueueLeads(state, out, (r) => (r.fit_score ?? 0) * 10, cfg);
  await saveState(cfg.CAMPAIGN_STATE_PATH, state);
  const queued = Object.values(state.leads).filter((l) => l.status === "queued").length;
  console.log(`parsed ${out.length} banked leads (segments: ${allow.join(",")})`);
  console.log(
    `enqueued ${added} new (queue ${before} -> ${Object.keys(state.leads).length}, queued=${queued}) — ZERO LLM calls`,
  );
})();
