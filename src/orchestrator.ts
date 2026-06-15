import type { AppConfig } from "./config.js";
import { assertLLMReady } from "./config.js";
import { fetchLeads } from "./sources/index.js";
import { loadExistingKeys } from "./output.js";
import { finalizeOutput, printTable, processLeads } from "./pipeline.js";
import type { DiscoveredLead, Lead, OutputRow } from "./types.js";

export interface RunFlags {
  dry: boolean;
  mock: boolean;
  force: boolean;
  sendTest: boolean;
  input?: string;
  limit?: number;
  concurrency?: number;
}

function asDiscovered(lead: Lead): DiscoveredLead {
  return { ...lead, discovery_source: "csv" };
}

export async function runEnrichment(cfg: AppConfig, flags: RunFlags): Promise<OutputRow[]> {
  const concurrency = flags.concurrency ?? cfg.CONCURRENCY;
  console.log(
    `[leadflow] starting (provider=${cfg.LLM_PROVIDER}, source=${cfg.LEADS_SOURCE}, ` +
      `mock=${flags.mock}, dry=${flags.dry}, force=${flags.force}, concurrency=${concurrency})`,
  );

  let llmReady = true;
  try {
    assertLLMReady(cfg);
  } catch (err) {
    console.warn(`[leadflow] ${(err as Error).message} — every lead will use the fallback opener.`);
    llmReady = false;
  }

  const allLeads = await fetchLeads(cfg, flags.input);
  console.log(`[leadflow] fetched ${allLeads.length} leads`);

  let leads: DiscoveredLead[] = allLeads.map(asDiscovered);

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
      console.log(`[leadflow] skipping ${skipped} already-processed leads (use --force to re-run)`);
    }
  }

  if (flags.limit !== undefined && flags.limit > 0) {
    leads = leads.slice(0, flags.limit);
    console.log(`[leadflow] limited to first ${leads.length} leads`);
  }

  if (leads.length === 0) {
    console.log("[leadflow] nothing to do");
    return [];
  }

  const rows = await processLeads(cfg, leads, {
    mock: flags.mock,
    force: flags.force,
    concurrency,
    llmReady,
    label: "leadflow",
  });

  if (flags.dry) {
    console.log("\n--- DRY RUN OUTPUT ---\n");
    printTable(rows);
    console.log("\n--- END ---\n");
    return rows;
  }

  await finalizeOutput(cfg, rows, {
    force: flags.force,
    sendTest: flags.sendTest,
    label: "leadflow",
    writeDraftsQueue: true,
  });

  return rows;
}
