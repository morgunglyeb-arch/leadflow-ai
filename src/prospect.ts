import type { AppConfig } from "./config.js";
import { assertDiscoveryReady, assertLLMReady, digestReady } from "./config.js";
import { discoverLeads } from "./discover/index.js";
import { loadExistingKeys } from "./output.js";
import { finalizeOutput, printTable, processLeads } from "./pipeline.js";
import { sendDigest, writeDigestFile } from "./digest.js";
import { assembleDraft } from "./outreach.js";
import { translate } from "./ai.js";
import { existingAutomations } from "./enrich.js";
import { matchVertical, verticalPrice } from "./vertical.js";
import { pLimit } from "./pLimit.js";
import { emitDraft, emitEvent, emitRunEnd, emitRunStart } from "./ops-emit.js";
import type { DiscoveredLead, OutputRow } from "./types.js";

const DIGEST_LANG_NAME: Record<string, string> = { ru: "Russian", uk: "Ukrainian", en: "English" };

/**
 * Attach operator-only digest extras to the FINAL leads: the market price to
 * quote for the proposed automation, the automations they ALREADY have (so the
 * operator can sanity-check we're not re-pitching), and a faithful translation
 * of the outgoing English email into the operator's language.
 */
async function attachDigestExtras(
  cfg: AppConfig,
  rows: OutputRow[],
  concurrency: number,
): Promise<void> {
  const limit = pLimit(Math.max(1, Math.min(concurrency, 4)));
  const targetLang = DIGEST_LANG_NAME[cfg.DIGEST_LANG] ?? "Russian";
  await Promise.all(
    rows.map((row) =>
      limit(async () => {
        const vertical = await matchVertical(
          `${row.discovery_query ?? ""} ${row.company} ${(row.signals ?? "").replace(/\|/g, " ")}`,
        );
        const price = verticalPrice(vertical);
        if (price) row.market_price = price;

        const already = existingAutomations((row.signals ?? "").split("|").filter(Boolean));
        if (already.length > 0) row.already_automated = already.join(", ");

        // Translate the exact email the operator would send (only if the digest
        // language differs from the outreach language).
        if (cfg.DIGEST_LANG !== cfg.OUTREACH_LANG && row.opener) {
          const body = assembleDraft(row, cfg).body;
          const tr = await translate(cfg, body, targetLang);
          if (tr) row.email_translation = tr;
        }
      }),
    ),
  );
}

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

// The things WE sell — having 3+ already in place means a business is past our
// ICP (a small business NOT yet automated), so there's nothing left to sell.
const SELLABLE_SIGNALS = [
  "has_chatbot",
  "online_booking",
  "has_crm",
  "has_review_tool",
  "has_textback",
  "social_bot",
] as const;

/** A lead worth selling automation to: small/independent, has an email AND a
 * real automation gap, and isn't already automated to the hilt. */
function isQualified(row: OutputRow, cfg: AppConfig, minFit: number): boolean {
  if (row.status === "skipped") return false;
  if (cfg.REQUIRE_EMAIL && !row.email) return false;
  const sig = new Set((row.signals ?? "").split("|").filter(Boolean));
  // SIZE GATE — a franchise/chain/multi-site network gatekeeps the owner; not
  // our ICP (the email won't reach a decision-maker, and procurement kills the
  // sale). `multi_site` = 3+ locations/postcodes (e.g. a clinic with Location
  // 1/2/3); 1–2-site small/medium independents still qualify.
  if (sig.has("franchise") || sig.has("multi_site")) return false;
  // ALREADY-AUTOMATED GATE — 3+ of the things we sell already in place = past
  // our ICP, nothing left to pitch.
  if (SELLABLE_SIGNALS.filter((k) => sig.has(k)).length >= 3) return false;
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

/**
 * Rank by likely ROI of contacting them, not just raw fit: businesses that pay
 * for leads (ad pixels), take bookings by phone only, run emergency trades, or
 * are clearly busy have the most expensive unautomated gap → contact first.
 */
export function roiScore(row: OutputRow): number {
  const sig = new Set((row.signals ?? "").split("|").filter(Boolean));
  let s = (row.fit_score ?? 0) * 2;
  if (sig.has("runs_google_ads") || sig.has("runs_meta_ads")) s += 3;
  if (sig.has("phone_booking") && !sig.has("online_booking")) s += 2;
  if (/plumb|electric|roof|hvac|boiler|locksmith|emergency|drain/i.test(row.discovery_query ?? "")) s += 2;
  if (sig.has("whatsapp")) s += 1; // real click-to-chat channel (not just a social link)
  const reviews = row.reviews ?? 0;
  if (reviews > 1000) s += 2;
  else if (reviews > 300) s += 1;
  // buy-signals: motivated + has budget
  if (sig.has("hiring_reception")) s += 2;
  if (sig.has("expanding")) s += 1;
  // ICP core: SMALL, INDEPENDENT, owner-reachable — reward the absence of any
  // chain/franchise markers (the email actually lands on the decision-maker).
  if (!sig.has("multi_location") && !sig.has("franchise")) s += 2;
  // de-prioritize low-budget / hard-to-close / too big
  if (sig.has("diy_site")) s -= 3;
  if (sig.has("multi_location")) s -= 2;
  if (sig.has("franchise")) s -= 5; // also hard-excluded in isQualified
  // ICP fit: we want SMALL businesses NOT yet automated. Each automation they
  // already run is one less thing to sell AND a signal they're past our ICP.
  for (const k of [
    "has_chatbot",
    "has_crm",
    "has_review_tool",
    "has_textback",
    "online_booking",
    "social_bot",
  ]) {
    if (sig.has(k)) s -= 2;
  }
  return s;
}

/**
 * Public entrypoint: wraps the prospecting run with best-effort Opero Ops
 * telemetry (run.start / run.end). Emits are no-ops unless OPERO_OPS_URL +
 * INGEST_BEARER_TOKEN are set and never affect the run result.
 */
export async function runProspecting(cfg: AppConfig, flags: ProspectFlags): Promise<OutputRow[]> {
  const runId = await emitRunStart("prospect");
  try {
    const rows = await runProspectingCore(cfg, flags);
    // Push each qualified lead's pre-generated message to the hub's "Рассылка"
    // review tab so the owner can check + send it by hand. Skip mock data.
    if (!flags.mock) await emitDrafts(cfg, rows);
    await emitRunEnd(runId, { status: "done", qualified: rows.length, sent: 0 });
    return rows;
  } catch (err) {
    await emitRunEnd(runId, { status: "failed" });
    throw err;
  }
}

/** Build a review-draft per qualified lead (site · email · why · message) and
 * emit it to Opero Ops. Best-effort: one failure never breaks the run. */
async function emitDrafts(cfg: AppConfig, rows: OutputRow[]): Promise<void> {
  for (const row of rows) {
    try {
      const { subject, body } = assembleDraft(row, cfg);
      if (!body.trim()) continue;
      const website = row.domain
        ? /^https?:\/\//.test(row.domain)
          ? row.domain
          : `https://${row.domain}`
        : undefined;
      // "Why this business" is operator-facing → prefer the Russian `brief`
      // (digest lang). Fall back to the English reason/process only if absent,
      // so the Mini App shows the explanation in the owner's language.
      const proc = (row.process ?? "").trim();
      const reason =
        (row.brief ?? "").trim() ||
        [row.reason, proc && proc !== "unclear from site" ? proc : ""]
          .filter(Boolean)
          .join(" · ");
      await emitDraft({
        business: row.company,
        ...(website ? { website } : {}),
        ...(row.email ? { email: row.email } : {}),
        ...(row.discovery_query ? { industry: row.discovery_query } : {}),
        ...(reason ? { reason } : {}),
        subject,
        message: body,
        ...(row.email_translation ? { message_ru: row.email_translation } : {}),
        score: Math.round(roiScore(row)),
        dedup_key: (row.domain || row.email || row.company).toLowerCase(),
      });
    } catch (err) {
      console.warn(`[prospect] emitDraft failed for ${row.company}: ${(err as Error).message}`);
    }
  }
}

async function runProspectingCore(cfg: AppConfig, flags: ProspectFlags): Promise<OutputRow[]> {
  const concurrency = flags.concurrency ?? cfg.CONCURRENCY;
  const target = flags.limit && flags.limit > 0 ? flags.limit : cfg.MAX_LEADS;
  const minFit = flags.minFit ?? cfg.MIN_FIT;
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

  // LLM-EXHAUSTION ALARM — keys were configured (llmReady) but (almost) every
  // lead fell back to the no-LLM opener → the provider pool is exhausted/blocked
  // and fallback leads get disqualified, so the run silently yields ~0 quality
  // drafts. Never dead-end on a limit in silence: ping the operator's phone.
  const fellBack = allRows.filter((r) => r.ai_provider === "fallback").length;
  if (llmReady && allRows.length >= 3 && fellBack / allRows.length >= 0.8) {
    console.warn(
      `[prospect] ⚠️ LLM pool exhausted — ${fellBack}/${allRows.length} leads used the fallback opener.`,
    );
    await emitEvent("llm_exhausted", {
      processed: allRows.length,
      fell_back: fellBack,
      provider: cfg.LLM_PROVIDER,
      note: "All LLM providers/keys exhausted or blocked — run produced low-quality fallback drafts. Rotate or replenish keys.",
    });
  }

  // 4. final set: qualified, highest ROI first, capped to target
  const rows = qualified.sort((a, b) => roiScore(b) - roiScore(a)).slice(0, target);

  // 4b. enrich the final set with operator-only digest extras (market price,
  //     what they already have, and a translation of the outgoing email).
  //     MUST run before the dry-run return — dry runs still emit drafts to the
  //     hub, and those need the Russian translation (message_ru).
  await attachDigestExtras(cfg, rows, concurrency);

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
