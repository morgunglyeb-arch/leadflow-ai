// One-off: resolve is_ltd for banked leads where it's UNKNOWN, so the PECR gate can
// send the ones that ARE Ltd (unlocks already-enriched leads without new discovery).
// Reuses the SAME isRegisteredCompany check the pipeline uses — never reimplement the
// PECR-legality decision. Free (Companies House search API). Batches of 5 to stay
// well under CH's 600-req/5-min limit.
import { loadConfig } from "../src/config.js";
import { loadState, saveState } from "../src/campaign/store.js";
import { isRegisteredCompany } from "../src/companies-house.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const path = cfg.CAMPAIGN_STATE_PATH;
  const state = await loadState(path);
  const targets = Object.entries(state.leads).filter(
    ([, l]) => (l.is_ltd === undefined || l.is_ltd === null) && l.status === "queued",
  );
  console.log(`[backfill] ${targets.length} queued leads with UNKNOWN is_ltd`);
  if (targets.length === 0) return;

  let ltd = 0;
  let notLtd = 0;
  let unresolved = 0;
  let done = 0;
  const CONC = 5;
  for (let i = 0; i < targets.length; i += CONC) {
    const batch = targets.slice(i, i + CONC);
    await Promise.all(
      batch.map(async ([, l]) => {
        const r = await isRegisteredCompany(cfg, l.company);
        if (r === true) {
          l.is_ltd = true;
          ltd++;
        } else if (r === false) {
          l.is_ltd = false;
          notLtd++;
        } else {
          unresolved++;
        }
        done++;
      }),
    );
    if (done % 25 === 0 || done === targets.length) {
      console.log(`[backfill] ${done}/${targets.length} · Ltd ${ltd} · not-Ltd ${notLtd} · unresolved ${unresolved}`);
      await saveState(path, state); // periodic checkpoint so a kill doesn't lose progress
    }
  }
  await saveState(path, state);
  console.log(
    `[backfill] DONE — newly sendable (is_ltd=true): ${ltd} · not-Ltd: ${notLtd} · unresolved: ${unresolved}. State saved.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
