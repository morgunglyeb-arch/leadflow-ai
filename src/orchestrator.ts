import type { AppConfig } from "./config.js";
import { assertLLMReady, sheetsOutputReady, emailTestReady } from "./config.js";
import { fetchLeads } from "./sources/index.js";
import { enrichLead } from "./enrich.js";
import { personalize, fallbackPersonalization } from "./ai.js";
import { pLimit } from "./pLimit.js";
import {
  appendToSheets,
  loadExistingKeys,
  overwriteCsv,
  sendTestEmail,
  writeCsv,
} from "./output.js";
import type { Lead, OutputRow } from "./types.js";

export interface RunFlags {
  dry: boolean;
  mock: boolean;
  force: boolean;
  sendTest: boolean;
  input?: string;
  limit?: number;
  concurrency?: number;
}

interface KeyedLead extends Lead {
  _key: string;
}

function leadKey(lead: Lead): string {
  return (lead.email ?? lead.domain).toLowerCase();
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

  let leads: KeyedLead[] = allLeads.map((l) => ({ ...l, _key: leadKey(l) }));

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

  const limit = pLimit(concurrency);
  let done = 0;
  const rows = await Promise.all(
    leads.map((lead) =>
      limit(async () => {
        const enrichment = await enrichLead(lead.domain, cfg, {
          mock: flags.mock,
          force: flags.force,
        });

        let personalized;
        let provider: "anthropic" | "groq" | "fallback";
        if (!llmReady) {
          personalized = fallbackPersonalization(lead, enrichment);
          provider = "fallback";
        } else {
          const r = await personalize(cfg, lead, enrichment);
          personalized = r.personalized;
          provider = r.provider;
        }

        const row: OutputRow = {
          company: lead.company,
          domain: lead.domain,
          ...(lead.name !== undefined ? { name: lead.name } : {}),
          ...(lead.role !== undefined ? { role: lead.role } : {}),
          ...(lead.linkedin !== undefined ? { linkedin: lead.linkedin } : {}),
          ...(lead.email !== undefined ? { email: lead.email } : {}),
          enriched: enrichment.ok,
          enrichment_source: enrichment.source,
          signals: enrichment.signals.join("|"),
          ai_provider: provider,
          opener: personalized.opener,
          icebreaker: personalized.icebreaker,
          subject: personalized.subject,
          fit_score: personalized.fit_score,
          reason: personalized.reason,
        };
        done++;
        const fit = personalized.fit_score;
        console.log(
          `[leadflow] (${done}/${leads.length}) ${lead.company.padEnd(28).slice(0, 28)} ` +
            `enriched=${enrichment.ok ? "✓" : "✗"} src=${enrichment.source} ` +
            `ai=${provider} fit=${fit}`,
        );
        return row;
      }),
    ),
  );

  if (flags.dry) {
    console.log("\n--- DRY RUN OUTPUT ---\n");
    printTable(rows);
    console.log("\n--- END ---\n");
    return rows;
  }

  if (flags.force) {
    await overwriteCsv(cfg.OUTPUT_CSV_PATH, rows);
    console.log(`[leadflow] wrote ${rows.length} rows → ${cfg.OUTPUT_CSV_PATH} (overwritten)`);
  } else {
    await writeCsv(cfg.OUTPUT_CSV_PATH, rows);
    console.log(`[leadflow] appended ${rows.length} rows → ${cfg.OUTPUT_CSV_PATH}`);
  }

  if (sheetsOutputReady(cfg)) {
    try {
      await appendToSheets(cfg, rows);
      console.log(`[leadflow] appended ${rows.length} rows to Google Sheets`);
    } catch (err) {
      console.error(`[leadflow] sheets append failed: ${(err as Error).message}`);
    }
  }

  if (flags.sendTest) {
    if (!emailTestReady(cfg)) {
      console.warn(
        "[leadflow] --send-test requested but RESEND_API_KEY / EMAIL_FROM / EMAIL_TEST_TO not all set — skipping",
      );
    } else {
      const first = rows[0];
      if (first) {
        const result = await sendTestEmail(cfg, first);
        if (result.ok) console.log(`[leadflow] test email sent (id=${result.id})`);
        else console.error(`[leadflow] test email FAILED: ${result.error}`);
      }
    }
  }

  return rows;
}

function printTable(rows: OutputRow[]): void {
  for (const r of rows) {
    console.log(
      `\n· ${r.company} (${r.domain})  fit=${r.fit_score ?? "-"}  ` +
        `[${r.ai_provider}/${r.enrichment_source}]`,
    );
    if (r.subject) console.log(`  subject:    ${r.subject}`);
    if (r.opener) console.log(`  opener:     ${r.opener}`);
    if (r.icebreaker) console.log(`  icebreaker: ${r.icebreaker}`);
    if (r.reason) console.log(`  reason:     ${r.reason}`);
    if (r.signals) console.log(`  signals:    ${r.signals}`);
  }
}
