import type { AppConfig } from "./config.js";
import { assertDiscoveryReady, assertLLMReady, digestReady } from "./config.js";
import { discoverLeads } from "./discover/index.js";
import { loadExistingKeys } from "./output.js";
import { finalizeOutput, printTable, processLeads } from "./pipeline.js";
import { sendDigest, writeDigestFile } from "./digest.js";
import type { DiscoveredLead, OutputRow } from "./types.js";

export interface ProspectFlags {
  dry: boolean;
  mock: boolean;
  force: boolean;
  sendTest: boolean;
  digest: boolean;
  limit?: number;
  concurrency?: number;
  minFit?: number;
}

/** A lead worth selling automation to: has an email AND a real automation gap. */
function isQualified(row: OutputRow, cfg: AppConfig, minFit: number): boolean {
  if (row.status === "skipped") return false;
  if (cfg.REQUIRE_EMAIL && !row.email) return false;
  if (cfg.REQUIRE_AUTOMATION) {
    const p = (row.process ?? "").trim().toLowerCase();
    if (!p || p === "unclear from site") return false;
    if (!row.automation) return false;
  }
  if ((row.fit_score ?? 0) < minFit) return false;
  return true;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function runProspecting(cfg: AppConfig, flags: ProspectFlags): Promise<OutputRow[]> {
  const concurrency = flags.concurrency ?? cfg.CONCURRENCY;
  const target = flags.limit && flags.limit > 0 ? flags.limit : cfg.MAX_LEADS;
  const minFit = flags.minFit ?? 1;
  console.log(
    `[prospect] starting (discovery=${cfg.DISCOVERY_SOURCE}, provider=${cfg.LLM_PROVIDER}, ` +
      `target=${target} qualified, min-fit=${minFit}, mock=${flags.mock}, dry=${flags.dry})`,
  );

  let llmReady = true;
  try {
    assertLLMReady(cfg);
  } catch (err) {
    console.warn(`[prospect] ${(err as Error).message} — every lead will use the fallback opener.`);
    llmReady = false;
  }
  assertDiscoveryReady(cfg, flags.mock);

  // 1. DISCOVER an over-fetched candidate pool (we'll drop no-email / no-gap).
  const poolSize = Math.ceil(target * cfg.OVERFETCH);
  const { leads: discovered, icp } = await discoverLeads(cfg, {
    mock: flags.mock,
    maxLeads: poolSize,
  });
  console.log(
    `[prospect] discovered ${discovered.length} candidates (pool target ${poolSize}) ` +
      `across ${icp.segments.length} segment(s)`,
  );

  // 2. idempotency vs existing output
  let pool: DiscoveredLead[] = discovered;
  if (!flags.force && !flags.dry) {
    const existing = await loadExistingKeys(cfg.OUTPUT_CSV_PATH);
    const before = pool.length;
    pool = pool.filter((l) => {
      const emailDup = l.email && existing.emails.has(l.email.toLowerCase());
      return !emailDup && !existing.domains.has(l.domain.toLowerCase());
    });
    if (before - pool.length > 0) {
      console.log(`[prospect] skipping ${before - pool.length} already-processed (use --force)`);
    }
  }

  if (pool.length === 0) {
    console.log("[prospect] nothing to do");
    return [];
  }

  // 3. ENRICH + PITCH in chunks; stop once we have `target` QUALIFIED leads
  //    (email present + a real automation gap). Email is checked before the
  //    LLM call, so we don't spend tokens on leads we'd drop anyway.
  const qualified: OutputRow[] = [];
  const allRows: OutputRow[] = [];
  let processed = 0;
  const chunkSize = Math.max(concurrency * 2, 6);

  for (const batch of chunk(pool, chunkSize)) {
    if (qualified.length >= target) break;
    const rows = await processLeads(cfg, batch, {
      mock: flags.mock,
      force: flags.force,
      concurrency,
      llmReady,
      requireEmail: cfg.REQUIRE_EMAIL,
      ...(icp.note ? { icpNote: icp.note } : {}),
      label: "prospect",
    });
    processed += batch.length;
    for (const r of rows) {
      allRows.push(r);
      if (isQualified(r, cfg, minFit)) qualified.push(r);
    }
    console.log(
      `[prospect] processed ${processed}/${pool.length} · qualified ${qualified.length}/${target}`,
    );
  }

  if (qualified.length < target) {
    console.warn(
      `[prospect] pool exhausted: only ${qualified.length} qualified leads found ` +
        `(wanted ${target}). Add more ICP queries or raise OVERFETCH for more.`,
    );
  }

  // 4. final set: qualified, best fit first, capped to target
  const rows = qualified.sort((a, b) => (b.fit_score ?? 0) - (a.fit_score ?? 0)).slice(0, target);

  if (flags.dry) {
    console.log("\n--- DRY RUN OUTPUT ---\n");
    printTable(rows);
    console.log("\n--- END ---\n");
    return rows;
  }

  // 5. write enriched CSV + draft queue (drafts for review — no auto-send)
  await finalizeOutput(cfg, rows, {
    force: flags.force,
    sendTest: flags.sendTest,
    label: "prospect",
    writeDraftsQueue: true,
  });

  // 6. digest: always write a local preview file; email it if --digest
  const previewPath = await writeDigestFile(cfg, rows);
  console.log(`[prospect] digest preview → ${previewPath} (${rows.length} qualified leads)`);

  if (flags.digest) {
    if (!digestReady(cfg)) {
      console.warn(
        "[prospect] --digest requested but RESEND_API_KEY / EMAIL_FROM / EMAIL_DIGEST_TO not all set — skipping",
      );
    } else {
      const r = await sendDigest(cfg, rows);
      if (r.ok) console.log(`[prospect] digest emailed to ${r.recipients} recipient(s) (id=${r.id})`);
      else console.error(`[prospect] digest FAILED: ${r.error}`);
    }
  }

  return rows;
}
