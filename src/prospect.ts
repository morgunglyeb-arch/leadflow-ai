import type { AppConfig } from "./config.js";
import { assertDiscoveryReady, assertLLMReady, digestReady } from "./config.js";
import { discoverLeads } from "./discover/index.js";
import { loadExistingKeys } from "./output.js";
import { finalizeOutput, printTable, processLeads } from "./pipeline.js";
import { sendDigest, writeDigestFile } from "./digest.js";
import type { OutputRow } from "./types.js";

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

export async function runProspecting(cfg: AppConfig, flags: ProspectFlags): Promise<OutputRow[]> {
  const concurrency = flags.concurrency ?? cfg.CONCURRENCY;
  console.log(
    `[prospect] starting (discovery=${cfg.DISCOVERY_SOURCE}, provider=${cfg.LLM_PROVIDER}, ` +
      `mock=${flags.mock}, dry=${flags.dry}, force=${flags.force}, concurrency=${concurrency})`,
  );

  let llmReady = true;
  try {
    assertLLMReady(cfg);
  } catch (err) {
    console.warn(`[prospect] ${(err as Error).message} — every lead will use the fallback opener.`);
    llmReady = false;
  }

  assertDiscoveryReady(cfg, flags.mock);

  // 1. DISCOVER
  const maxLeads = flags.limit && flags.limit > 0 ? flags.limit : cfg.MAX_LEADS;
  const { leads: discovered, icp } = await discoverLeads(cfg, {
    mock: flags.mock,
    maxLeads,
  });
  console.log(`[prospect] discovered ${discovered.length} unique leads across ${icp.segments.length} segment(s)`);

  let leads = discovered;

  // 2. idempotency vs existing output
  if (!flags.force && !flags.dry) {
    const existing = await loadExistingKeys(cfg.OUTPUT_CSV_PATH);
    const before = leads.length;
    leads = leads.filter((l) => {
      const emailDup = l.email && existing.emails.has(l.email.toLowerCase());
      const domainDup = existing.domains.has(l.domain.toLowerCase());
      return !emailDup && !domainDup;
    });
    const skipped = before - leads.length;
    if (skipped > 0) {
      console.log(`[prospect] skipping ${skipped} already-processed leads (use --force to re-run)`);
    }
  }

  if (leads.length === 0) {
    console.log("[prospect] nothing to do");
    return [];
  }

  // 3. ENRICH + PITCH (shared pipeline)
  let rows = await processLeads(cfg, leads, {
    mock: flags.mock,
    force: flags.force,
    concurrency,
    llmReady,
    ...(icp.note ? { icpNote: icp.note } : {}),
    label: "prospect",
  });

  // 4. optional fit gate
  if (flags.minFit !== undefined && flags.minFit > 1) {
    const before = rows.length;
    const kept = rows.filter((r) => (r.fit_score ?? 0) >= flags.minFit!);
    const dropped = before - kept.length;
    rows = rows.map((r) =>
      (r.fit_score ?? 0) >= flags.minFit! ? r : { ...r, status: "skipped" as const },
    );
    console.log(
      `[prospect] fit gate >=${flags.minFit}: ${kept.length} pass, ${dropped} marked 'skipped'`,
    );
  }

  // 5. sort by fit desc for review convenience
  rows.sort((a, b) => (b.fit_score ?? 0) - (a.fit_score ?? 0));

  if (flags.dry) {
    console.log("\n--- DRY RUN OUTPUT ---\n");
    printTable(rows);
    console.log("\n--- END ---\n");
    return rows;
  }

  // 6. write enriched CSV + draft queue (drafts for review — no auto-send)
  await finalizeOutput(cfg, rows, {
    force: flags.force,
    sendTest: flags.sendTest,
    label: "prospect",
    writeDraftsQueue: true,
  });

  // 7. digest: always write a local preview file; email it if --digest
  const toSend = flags.minFit !== undefined && flags.minFit > 1
    ? rows.filter((r) => (r.fit_score ?? 0) >= flags.minFit!)
    : rows;
  const previewPath = await writeDigestFile(cfg, toSend);
  console.log(`[prospect] digest preview → ${previewPath}`);

  if (flags.digest) {
    if (!digestReady(cfg)) {
      console.warn(
        "[prospect] --digest requested but RESEND_API_KEY / EMAIL_FROM / EMAIL_DIGEST_TO not all set — skipping",
      );
    } else {
      const r = await sendDigest(cfg, toSend);
      if (r.ok) console.log(`[prospect] digest emailed to ${r.recipients} recipient(s) (id=${r.id})`);
      else console.error(`[prospect] digest FAILED: ${r.error}`);
    }
  }

  return rows;
}
