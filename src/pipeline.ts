import type { AppConfig } from "./config.js";
import { emailTestReady, sheetsOutputReady } from "./config.js";
import { detectWorkingDays, enrichLead, isRoleInbox } from "./enrich.js";
import { personalize, fallbackPersonalization } from "./ai.js";
import { pLimit } from "./pLimit.js";
import {
  appendToSheets,
  overwriteCsv,
  sendTestEmail,
  writeCsv,
} from "./output.js";
import { writeDrafts } from "./outreach.js";
import { fetchReviewDigest } from "./discover/reviews.js";
import { verifyEmail, hunterDomainSearch, guessDomainEmail, normalizeEmail } from "./verify-email.js";
import { isCorporateEntity, isEmailableEntity } from "./compliance.js";
import { searchBusinessContext, searchBusinessNews } from "./web-search.js";
import type { DiscoveredLead, Enrichment, OutputRow } from "./types.js";

/** A row for a lead we dropped before pitching (no email / disqualified). */
function buildSkippedRow(
  lead: DiscoveredLead,
  enrichment: Enrichment,
  reason: string,
): OutputRow {
  return {
    company: lead.company,
    domain: lead.domain,
    discovery_source: lead.discovery_source,
    ...(lead.discovery_query !== undefined ? { discovery_query: lead.discovery_query } : {}),
    ...(lead.name !== undefined ? { name: lead.name } : {}),
    ...(lead.phone !== undefined ? { phone: lead.phone } : {}),
    ...(lead.rating !== undefined ? { rating: lead.rating } : {}),
    ...(lead.reviews !== undefined ? { reviews: lead.reviews } : {}),
    ...(lead.location !== undefined ? { location: lead.location } : {}),
    enriched: enrichment.ok,
    enrichment_source: enrichment.source,
    signals: enrichment.signals.join("|"),
    ai_provider: "fallback",
    status: "skipped",
    email_source: "none",
    reason,
  };
}

export interface ProcessOptions {
  mock: boolean;
  force: boolean;
  concurrency: number;
  llmReady: boolean;
  icpNote?: string;
  label: string; // log prefix, e.g. "leadflow" or "prospect"
  // If set, leads with no discoverable email are marked 'skipped' and the
  // (expensive) LLM pitch is NOT called for them.
  requireEmail?: boolean;
}

/**
 * The per-lead core, shared by the CSV-in (runEnrichment) and discover-in
 * (runProspecting) orchestrators: enrich → personalize (LLM, single zod schema)
 * → assemble OutputRow. Resilient: one bad lead never drops the batch.
 */
export async function processLeads(
  cfg: AppConfig,
  leads: DiscoveredLead[],
  opts: ProcessOptions,
): Promise<OutputRow[]> {
  const limit = pLimit(opts.concurrency);
  let done = 0;
  return Promise.all(
    leads.map((lead) =>
      limit(async () => {
        const enrichment = await enrichLead(lead.domain, cfg, {
          mock: opts.mock,
          force: opts.force,
        });

        let email = lead.email ?? enrichment.emails[0];

        // If scraping found no email, ask Hunter.io to find one (large business-
        // email database — catches many sites where the address isn't on-page).
        if (!email && !opts.mock && cfg.HUNTER_API_KEY) {
          const hunterEmails = await hunterDomainSearch(cfg, lead.domain);
          if (hunterEmails.length > 0) {
            const merged = [...new Set([...hunterEmails, ...enrichment.emails])];
            enrichment.emails = merged;
            email = merged[0];
          }
        }

        // FREE fallback — Hunter unavailable/empty (429/quota) shouldn't cost us the
        // lead: if the domain accepts mail (free MX check), guess the universal UK-SMB
        // role inbox `info@<domain>`. Keeps reach up while paid finders are throttled.
        // PECR Ltd-gate still filters sole-traders downstream.
        if (!email && !opts.mock && cfg.EMAIL_GUESS_ROLE_FALLBACK) {
          const guessed = await guessDomainEmail(lead.domain);
          if (guessed) {
            enrichment.emails = [...new Set([guessed, ...enrichment.emails])];
            email = guessed;
            console.log(`[mx-guess] ${lead.domain}: no findable email → ${guessed} (MX ok)`);
          }
        }

        // Verify the email (Hunter SMTP-level → ZeroBounce → MX fallback) so we
        // don't waste a send / risk a bounce on a dead address. Walk the
        // candidate emails and keep the first that verifies.
        if (email && cfg.EMAIL_VERIFY && !opts.mock) {
          const candidates = [email, ...enrichment.emails.filter((e) => e !== email)];
          email = undefined;
          for (const cand of candidates) {
            if ((await verifyEmail(cfg, cand)).ok) {
              email = normalizeEmail(cand) || cand; // store the clean form we verified
              break;
            }
          }
        }

        // Email gate: no (valid) email + requireEmail → skip the LLM entirely.
        if (opts.requireEmail && !email) {
          done++;
          console.log(
            `[${opts.label}] (${done}/${leads.length}) ${lead.company.padEnd(28).slice(0, 28)} ` +
              `skipped — no valid email`,
          );
          return buildSkippedRow(lead, enrichment, "no-valid-email");
        }

        let personalized;
        let provider: "anthropic" | "groq" | "openai" | "openrouter" | "fallback";
        if (!opts.llmReady) {
          personalized = fallbackPersonalization(lead, enrichment, cfg.DIGEST_LANG);
          provider = "fallback";
        } else {
          // Mine real Google reviews (pain points, what customers value) for
          // hand-researched personalization — only for qualified, live leads.
          const reviews =
            !opts.mock && lead.cid ? await fetchReviewDigest(lead.cid, cfg) : undefined;

          // Web search for recent news/events (awards, expansions, complaints) —
          // context the site crawler misses. Quick, optional, never blocks.
          let webContext: string | undefined;
          if (!opts.mock) {
            const ctx = await searchBusinessContext(lead.company, lead.domain);
            const news = ctx ? "" : await searchBusinessNews(lead.company, lead.domain);
            webContext = ctx || news || undefined;
          }

          const r = await personalize(cfg, lead, enrichment, opts.icpNote, reviews, webContext);
          personalized = r.personalized;
          provider = r.provider;
        }

        // PECR emailability — resolve once here (Companies House when keyed, else
        // the name heuristic; cached) so the campaign send gate stays cheap.
        const isLtd = opts.mock
          ? isCorporateEntity(lead.company)
          : await isEmailableEntity(cfg, lead.company);

        const chosenEmail = lead.email ?? enrichment.emails[0];

        const row: OutputRow = {
          company: lead.company,
          domain: lead.domain,
          is_ltd: isLtd,
          discovery_source: lead.discovery_source,
          ...(lead.discovery_query !== undefined ? { discovery_query: lead.discovery_query } : {}),
          ...(lead.name !== undefined ? { name: lead.name } : {}),
          ...(lead.role !== undefined ? { role: lead.role } : {}),
          ...(lead.linkedin !== undefined ? { linkedin: lead.linkedin } : {}),
          // prefer a known email, else the best on the site — now ranked
          // personal-first, so this is the named owner inbox when one exists
          ...(chosenEmail !== undefined ? { email: chosenEmail } : {}),
          email_source: lead.email ? "provided" : enrichment.emails[0] ? "site" : "none",
          ...(chosenEmail !== undefined ? { email_is_role: isRoleInbox(chosenEmail) } : {}),
          ...(lead.phone !== undefined ? { phone: lead.phone } : {}),
          ...(lead.rating !== undefined ? { rating: lead.rating } : {}),
          ...(lead.reviews !== undefined ? { reviews: lead.reviews } : {}),
          ...(lead.location !== undefined ? { location: lead.location } : {}),
          enriched: enrichment.ok,
          enrichment_source: enrichment.source,
          signals: enrichment.signals.join("|"),
          ...(detectWorkingDays(enrichment.summary_text)
            ? { working_days: detectWorkingDays(enrichment.summary_text) }
            : {}),
          ai_provider: provider,
          status: "draft",
          opener: personalized.opener,
          icebreaker: personalized.icebreaker,
          subject: personalized.subject,
          fit_score: personalized.fit_score,
          reason: personalized.reason,
          process: personalized.process,
          automation: personalized.automation,
          est_benefit: personalized.est_benefit,
          brief: personalized.brief,
          followup_1: personalized.followup_1,
          followup_2: personalized.followup_2,
          subject_b: personalized.subject_b,
          demo: personalized.demo,
          services: personalized.services,
        };
        done++;
        console.log(
          `[${opts.label}] (${done}/${leads.length}) ${lead.company.padEnd(28).slice(0, 28)} ` +
            `enriched=${enrichment.ok ? "✓" : "✗"} src=${enrichment.source} ` +
            `ai=${provider} fit=${personalized.fit_score} · ${truncate(personalized.process, 40)}`,
        );
        return row;
      }),
    ),
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export interface FinalizeOptions {
  force: boolean;
  sendTest: boolean;
  label: string;
  writeDraftsQueue: boolean;
}

export async function finalizeOutput(
  cfg: AppConfig,
  rows: OutputRow[],
  opts: FinalizeOptions,
): Promise<void> {
  if (opts.force) {
    await overwriteCsv(cfg.OUTPUT_CSV_PATH, rows);
    console.log(`[${opts.label}] wrote ${rows.length} rows → ${cfg.OUTPUT_CSV_PATH} (overwritten)`);
  } else {
    await writeCsv(cfg.OUTPUT_CSV_PATH, rows);
    console.log(`[${opts.label}] appended ${rows.length} rows → ${cfg.OUTPUT_CSV_PATH}`);
  }

  if (opts.writeDraftsQueue) {
    const res = await writeDrafts(cfg, rows);
    console.log(`[${opts.label}] wrote ${res.count} email drafts → ${res.dir}/ + ${res.csv}`);
  }

  if (sheetsOutputReady(cfg)) {
    try {
      await appendToSheets(cfg, rows);
      console.log(`[${opts.label}] appended ${rows.length} rows to Google Sheets`);
    } catch (err) {
      console.error(`[${opts.label}] sheets append failed: ${(err as Error).message}`);
    }
  }

  if (opts.sendTest) {
    if (!emailTestReady(cfg)) {
      console.warn(
        `[${opts.label}] --send-test requested but RESEND_API_KEY / EMAIL_FROM / EMAIL_TEST_TO not all set — skipping`,
      );
    } else {
      const first = rows[0];
      if (first) {
        const result = await sendTestEmail(cfg, first);
        if (result.ok) console.log(`[${opts.label}] test email sent (id=${result.id})`);
        else console.error(`[${opts.label}] test email FAILED: ${result.error}`);
      }
    }
  }
}

export function printTable(rows: OutputRow[]): void {
  for (const r of rows) {
    console.log(
      `\n· ${r.company} (${r.domain})  fit=${r.fit_score ?? "-"}  ` +
        `[${r.ai_provider}/${r.enrichment_source}/${r.discovery_source}]`,
    );
    if (r.subject) console.log(`  subject:    ${r.subject}`);
    if (r.opener) console.log(`  opener:     ${r.opener}`);
    if (r.icebreaker) console.log(`  icebreaker: ${r.icebreaker}`);
    if (r.process) console.log(`  process:    ${r.process}`);
    if (r.automation) console.log(`  automation: ${r.automation}`);
    if (r.est_benefit) console.log(`  benefit:    ${r.est_benefit}`);
    if (r.reason) console.log(`  why fit:    ${r.reason}`);
    if (r.signals) console.log(`  signals:    ${r.signals}`);
  }
}
