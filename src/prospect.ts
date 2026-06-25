import type { AppConfig } from "./config.js";
import { assertDiscoveryReady, assertLLMReady, digestReady } from "./config.js";
import { discoverLeads } from "./discover/index.js";
import { loadExistingKeys } from "./output.js";
import { finalizeOutput, printTable, processLeads } from "./pipeline.js";
import { sendDigest, writeDigestFile } from "./digest.js";
import { assembleDraft, assembleDraftRu } from "./outreach.js";
import { translate } from "./ai.js";
import { existingAutomations } from "./enrich.js";
import { deriveOwnerEmail } from "./owner-email.js";
import { matchVertical, verticalPrice } from "./vertical.js";
import { pLimit } from "./pLimit.js";
import { emitDraft, emitEvent, emitRunEnd, emitRunStart } from "./ops-emit.js";
import type { DiscoveredLead, OutputRow } from "./types.js";

const DIGEST_LANG_NAME: Record<string, string> = { ru: "Russian", uk: "Ukrainian", en: "English" };

/** Owner-facing review translation. For DIGEST_LANG=ru the LOCKED parts (intro,
 * menu, CTA, opt-out) use the fixed RU copy and ONLY the personalised hook is
 * translated — so the curated menu can't be mistranslated ("chase"→"преследование")
 * and we don't re-translate fixed copy per lead. Other digest languages fall back
 * to a whole-body translation. No-op when digest lang == outreach lang. */
async function buildReviewRu(cfg: AppConfig, row: OutputRow): Promise<string | undefined> {
  if (cfg.DIGEST_LANG === cfg.OUTREACH_LANG) return undefined;
  const targetLang = DIGEST_LANG_NAME[cfg.DIGEST_LANG] ?? "Russian";
  if (cfg.DIGEST_LANG === "ru") {
    const hookEn = [row.icebreaker, row.opener]
      .map((s) => s?.trim())
      .filter((s): s is string => Boolean(s))
      .join(" ");
    const hookRu = hookEn ? (await translate(cfg, hookEn, targetLang)) || "" : "";
    return assembleDraftRu(row, cfg, hookRu);
  }
  return (await translate(cfg, assembleDraft(row, cfg).body, targetLang)) || undefined;
}

/**
 * Attach operator-only digest extras to the FINAL leads: the market price to
 * quote for the proposed automation, the automations they ALREADY have (so the
 * operator can sanity-check we're not re-pitching), and a faithful translation
 * of the outgoing English email into the operator's language.
 */
export async function attachDigestExtras(
  cfg: AppConfig,
  rows: OutputRow[],
  concurrency: number,
): Promise<void> {
  const limit = pLimit(Math.max(1, Math.min(concurrency, 4)));
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

        // Owner-facing RU review (fixed menu RU + translated hook; see buildReviewRu).
        const ru = await buildReviewRu(cfg, row);
        if (ru) row.email_translation = ru;
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

// Known UK national chains/groups — anti-ICP (procurement, no owner to reach).
// Catches brands that slip the structural `multi_site` check because a single
// glossy branch page lists no 3rd postcode (e.g. CREATE Fertility, Specsavers,
// Vets4Pets that leaked before). Matched on the business NAME / domain, so an
// independent that merely mentions "Bupa-registered" on its site isn't caught.
const KNOWN_CHAINS =
  /\b(specsavers|vision express|optical express|boots opticians?|scrivens opticians?|hakim group|vets ?4 ?pets|pets at home|medivet|cvs vets|ivc evidensia|independent vetcare|vetpartners|companion care|goddard veterinary|white ?cross vets|my ?dentist|portman dental|rodericks dental|dental partners|together dental|colosseum dental|damira dental|nuffield health|spire healthcare|spire hospital|hca healthcare|circle health|practice plus|create fertility|london women'?s clinic|care fertility|fertility partnership|bourn hall)\b/i;

export function isKnownChain(company: string, domain: string): boolean {
  return KNOWN_CHAINS.test(company) || KNOWN_CHAINS.test(domain.replace(/[.\-_]/g, " "));
}

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
  if (isKnownChain(row.company ?? "", row.domain ?? "")) return false;
  // REVIEW-COUNT BAND — drop too-few (no volume/weak proof) and too-many (large
  // operation past our ICP). Only when the count is actually known.
  const rv = row.reviews;
  if (typeof rv === "number" && (rv < cfg.REVIEWS_MIN || rv > cfg.REVIEWS_MAX)) return false;
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
  // SIZE no longer earns points — we target small/independent, not the biggest.
  // A very high review count is a soft "looks large" signal → gently DOWN-rank
  // (NOT a hard ceiling: it only lowers priority, never excludes — the structural
  // fix for "Maps surfaces the giants" is narrow-geo discovery, not a cutoff).
  const reviews = row.reviews ?? 0;
  if (reviews > 800) s -= 2;
  // OWNER-REACHABILITY (heavy weight, not cosmetic) — a named/personal inbox
  // (drsmith@) lands on the DECISION-MAKER; a generic desk inbox (info@/reception@)
  // is read by staff as ads → ignored / report-spam → wrecks the sender domain's
  // reputation for EVERY lead. So role-only is now a strong DOWN-rank, named a
  // strong UP-rank — this is the single biggest deliverability lever in selection.
  const localpart = (row.email ?? "").split("@")[0]?.toLowerCase() ?? "";
  const GENERIC_INBOX =
    /^(info|office|reception|service|services|admin|hello|hi|contact|contactus|enquir(?:y|ies)|mail|team|clinic|practice|appointments?|bookings?|reservations|frontdesk|hr|careers|jobs|no-?reply|donotreply)$/;
  if (row.email) {
    const isRole = row.email_is_role ?? GENERIC_INBOX.test(localpart);
    s += isRole ? -4 : 5;
  }
  // A director's personal address we DERIVED + SMTP-verified (Companies House →
  // pattern) is the strongest owner-reachability signal there is.
  if (row.derived_personal_email) s += 2;
  // INDEPENDENCE — explicit owner-run/established language = our ideal ICP.
  if (sig.has("owner_run")) s += 2;
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
  const stats: { discovered?: number } = {};
  try {
    const rows = await runProspectingCore(cfg, flags, stats);
    // Push each qualified lead's pre-generated message to the hub's "Рассылка"
    // review tab so the owner can check + send it by hand. Skip mock data.
    if (!flags.mock) await emitDrafts(cfg, rows);
    await emitRunEnd(runId, {
      status: "done",
      discovered: stats.discovered ?? 0,
      qualified: rows.length,
      sent: 0,
    });
    return rows;
  } catch (err) {
    await emitRunEnd(runId, { status: "failed" });
    throw err;
  }
}

/** Normalize a discovery query ("dental implant clinics in Warrington, United
 * Kingdom") down to just the VERTICAL ("dental implant clinics") for `drafts.
 * industry` — so the funnel can group/learn by vertical instead of treating every
 * city as its own "industry" (audit #29). The city is always the last `" in "`
 * segment, so we drop it (rejoining the rest preserves verticals like "walk in
 * clinics"). */
function verticalFromQuery(q: string | undefined): string | undefined {
  if (!q) return undefined;
  const parts = q.split(/\s+in\s+/i);
  if (parts.length < 2) return q.trim() || undefined;
  parts.pop(); // drop the trailing "<city>[, Country]" segment
  return parts.join(" in ").trim() || undefined;
}

// Owner-email derivation is capped per run. With ZeroBounce keys added (~100
// verifications/key, several keys → 400+/mo) verification is no longer the
// bottleneck, so we attempt the whole final set (Hunter 25/mo runs out first, then
// the chain falls through to ZeroBounce). Only role-only, Ltd leads are attempted.
const OWNER_DERIVE_BUDGET = 15;

/** For role-only, corporate (Ltd) leads in the final set, try to reach the owner
 * directly: Companies House director → likely personal address → SMTP-verify. On a
 * verified hit, swap the role inbox for the owner's address. Best-effort + capped. */
async function deriveOwnerEmails(cfg: AppConfig, rows: OutputRow[]): Promise<void> {
  let budget = OWNER_DERIVE_BUDGET;
  for (const row of rows) {
    if (budget <= 0) break;
    if (!row.email_is_role) continue; // already a personal/named inbox
    if (row.is_ltd === false) continue; // sole trader → review, don't chase (PECR)
    if (!row.domain) continue;
    budget--;
    try {
      const personal = await deriveOwnerEmail(cfg, row.company, row.domain);
      if (personal) {
        row.email = personal;
        row.email_is_role = false;
        row.derived_personal_email = personal;
        row.email_source = "derived";
        console.log(`[owner-email] ${row.company}: reached owner at ${personal} (was role inbox)`);
      }
    } catch (err) {
      console.warn(`[owner-email] ${row.company}: ${(err as Error).message}`);
    }
  }
}

/** Build a review-draft per qualified lead (site · email · why · message) and
 * emit it to Opero Ops. Best-effort: one failure never breaks the run.
 * Exported so the CSV-regenerate path (scripts/regen-from-csv.ts) reuses the
 * exact same emit + vertical-normalization logic. */
export async function emitDrafts(cfg: AppConfig, rows: OutputRow[]): Promise<void> {
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
      // ⚠ REVIEW FLAGS — surface owner-reachability / PECR risks to the operator in
      // «Рассылка» so a role-inbox or non-Ltd lead is checked before sending (the
      // owner chose: emit with a flag + lower score, not withhold).
      const warnFlags: string[] = [];
      if (row.email_is_role) warnFlags.push("ящик role-типа (info@/reception@) — может не дойти до владельца");
      if (row.is_ltd === false) warnFlags.push("не подтверждён как Ltd — PECR, проверь перед отправкой");
      const warn = warnFlags.length > 0 ? `⚠ ${warnFlags.join("; ")}. ` : "";
      const reason =
        warn +
        ((row.brief ?? "").trim() ||
          [row.reason, proc && proc !== "unclear from site" ? proc : ""]
            .filter(Boolean)
            .join(" · "));
      // ⭐ RULE — owner-facing RU translation is GUARANTEED HERE, the single choke
      // point every draft passes through on its way to «Рассылка». Do NOT rely on a
      // separate upstream step (attachDigestExtras): paths that build rows directly
      // — the regen script, future callers — skip it and the RU silently vanished.
      // If the row already carries a translation we reuse it; otherwise translate
      // the exact body we're about to send. (No-op when DIGEST_LANG == OUTREACH_LANG.)
      let messageRu = row.email_translation;
      if (!messageRu) messageRu = await buildReviewRu(cfg, row);
      await emitDraft({
        business: row.company,
        ...(website ? { website } : {}),
        ...(row.email ? { email: row.email } : {}),
        ...(verticalFromQuery(row.discovery_query)
          ? { industry: verticalFromQuery(row.discovery_query) }
          : {}),
        ...(reason ? { reason } : {}),
        subject,
        message: body,
        ...(messageRu ? { message_ru: messageRu } : {}),
        score: Math.round(roiScore(row)),
        dedup_key: (row.domain || row.email || row.company).toLowerCase(),
      });
    } catch (err) {
      console.warn(`[prospect] emitDraft failed for ${row.company}: ${(err as Error).message}`);
    }
  }
}

async function runProspectingCore(
  cfg: AppConfig,
  flags: ProspectFlags,
  stats?: { discovered?: number },
): Promise<OutputRow[]> {
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
  if (stats) stats.discovered = discovered.length;
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

  // 4a. OWNER-REACHABILITY (P0b) — for the final set only (token-cheap), try to
  //     reach the decision-maker directly: a role-only inbox on a corporate (Ltd)
  //     lead → derive the director's personal address (Companies House) + verify.
  if (!flags.mock) await deriveOwnerEmails(cfg, rows);

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
