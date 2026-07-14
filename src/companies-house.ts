/**
 * UK Companies House lookup — the strong signal behind the PECR compliance gate
 * (`compliance-guard` skill, enforced in code). The free name heuristic in
 * `compliance.ts` only sees a legal suffix in the trading name ("… Ltd"), so it
 * (a) wrongly HOLDS registered companies that trade under a plain name and
 * (b) can't tell a dissolved company from a live one. The official register
 * resolves both.
 *
 * Auth: the API key is the HTTP Basic *username* with a blank password.
 * Endpoint: https://api.company-information.service.gov.uk/search/companies
 * Free tier: ~600 requests / 5 min — ample at our send volume. Best-effort and
 * fully optional: with no key set every call returns `null` (= "can't tell"),
 * and the caller falls back to the name heuristic.
 */

import type { AppConfig } from "./config.js";

const CH_SEARCH_URL = "https://api.company-information.service.gov.uk/search/companies";

interface CompanySearchItem {
  title?: string;
  company_status?: string; // "active" | "dissolved" | "liquidation" | ...
  company_type?: string; // "ltd" | "llp" | "plc" | ...
  company_number?: string;
}

const CH_BASE = "https://api.company-information.service.gov.uk";

// name -> result. null = couldn't determine (no key / error / rate-limited).
const cache = new Map<string, boolean | null>();

/** Strip legal suffixes + punctuation so trading and registered names compare. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(ltd|limited|llp|plc|llc|inc|incorporated|cyf|cyfyngedig|uk|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Sector / descriptor boilerplate that clutters a trading name but isn't part of
// the registered company name ("Cartwright & Co Ltd — Accountants & Tax Advisers").
// Stripped only to build a cleaner CH *query*; never used to decide emailability.
const SECTOR_RE =
  /\b(estate|letting|lettings|sales|mortgage|mortgages|insurance|accountanc[y]?|accountants?|bookkeep(?:ing|er)?|tax|advis[eo]rs?|consultants?|services?|solutions?|specialists?|agents?|agency|brokers?|broking|financial|properties|property|of|in|at|for)\b/gi;

/**
 * Build progressively-cleaner CH search queries from a noisy trading name. CH's
 * relevance search misses when the query carries a descriptive tail or location
 * ("Collinson Hall - Estate Agents & Letting Agents in St Albans" → no hit), so we
 * try the raw name first, then the parenthetical (real Ltd often hides there:
 * "Royton Insurance (RIS Group LTD)"), then the name minus its dash-tail, then that
 * minus sector boilerplate. Order matters: earliest = most specific.
 */
export function chQueryVariants(raw: string): string[] {
  const out: string[] = [];
  const push = (s: string | undefined) => {
    const v = (s ?? "").trim();
    if (v && norm(v).length >= 3 && !out.includes(v)) out.push(v);
  };
  push(raw);
  const paren = raw.match(/\(([^)]+)\)/);
  if (paren) push(paren[1]);
  const base = raw.replace(/\([^)]*\)/g, " ").split(/\s[-–—]\s/)[0] ?? "";
  push(base);
  push(base.replace(SECTOR_RE, " ").replace(/\s+/g, " ").trim());
  return out;
}

/**
 * Precision-first match: EVERY (normalised, whole-word) token of our query name
 * must appear in a single active register title. This is deliberately stricter than
 * loose containment — a bare generic token ("Wakefield") must NOT confirm an
 * unrelated "Wakefield … Ltd", because a false positive here means cold-emailing a
 * sole trader (a PECR breach). Single-token queries are rejected outright.
 */
function titleMatches(queryNorm: string, titleNorm: string): boolean {
  const qt = queryNorm.split(" ").filter(Boolean);
  if (qt.length < 2) return false; // too generic to confirm safely
  const tt = new Set(titleNorm.split(" ").filter(Boolean));
  return qt.every((tok) => tt.has(tok));
}

/** One CH search → normalised titles of ACTIVE companies. null = transient/HTTP fail. */
async function searchActiveTitles(cfg: AppConfig, q: string): Promise<string[] | null> {
  const url = `${CH_SEARCH_URL}?q=${encodeURIComponent(q)}&items_per_page=20`;
  const auth = Buffer.from(`${cfg.COMPANIES_HOUSE_API_KEY}:`).toString("base64");
  const res = await fetch(url, {
    headers: { authorization: `Basic ${auth}`, accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 429 || res.status >= 500) return null; // transient — let a later run retry
  if (!res.ok) return []; // definitive "no result" (e.g. 404/400)
  const json = (await res.json()) as { items?: CompanySearchItem[] };
  return (json.items ?? [])
    .filter((it) => it.company_status === "active")
    .map((it) => norm(it.title ?? ""))
    .filter(Boolean);
}

/**
 * Is there an ACTIVE incorporated company on the UK register matching this name?
 * Returns true (found active match), false (searched, no active match), or null
 * (cannot determine — no API key, network/HTTP error, or rate-limited).
 */
export async function isRegisteredCompany(
  cfg: AppConfig,
  company: string | undefined | null,
): Promise<boolean | null> {
  if (!cfg.COMPANIES_HOUSE_API_KEY) return null;
  const raw = company ?? "";
  const target = norm(raw);
  if (target.length < 3) return null; // too vague to match safely
  if (cache.has(target)) return cache.get(target) ?? null;

  // Try progressively-cleaner queries (raw → parenthetical → dash-trimmed → sector-
  // stripped). A noisy trading name makes CH's search miss the real company, so a
  // single raw query wrongly reads as "not registered" and HOLDS a live Ltd.
  let result: boolean | null = false; // "searched, no confident match" until a variant hits
  try {
    let searchedAny = false;
    for (const q of chQueryVariants(raw)) {
      const tq = norm(q);
      if (tq.split(" ").filter(Boolean).length < 2) continue; // skip too-generic variants
      const titles = await searchActiveTitles(cfg, q);
      if (titles === null) return null; // transient (429/5xx) — don't poison the cache
      searchedAny = true;
      if (titles.some((t) => titleMatches(tq, t))) {
        result = true;
        break;
      }
    }
    if (!searchedAny) result = null; // every variant too generic → can't tell (fall back to heuristic)
  } catch {
    result = null;
  }
  if (result !== null) cache.set(target, result);
  return result;
}

// --- Director lookup (for deriving the owner's personal email) ------------------

interface Officer {
  name?: string; // "SMITH, John David"
  officer_role?: string; // "director" | "secretary" | "llp-member" | ...
  resigned_on?: string;
}

const directorCache = new Map<string, string | null>();

async function chGet(cfg: AppConfig, path: string): Promise<unknown | null> {
  const auth = Buffer.from(`${cfg.COMPANIES_HOUSE_API_KEY}:`).toString("base64");
  const res = await fetch(`${CH_BASE}${path}`, {
    headers: { authorization: `Basic ${auth}`, accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  return res.json();
}

/** "SMITH, John David" → "John Smith" (drop titles, keep first forename + surname). */
function normalizeOfficerName(raw: string): string | null {
  const parts = raw.split(",");
  const surnameRaw = parts[0];
  const foreRaw = parts[1];
  if (!surnameRaw || !foreRaw) return null;
  const last = surnameRaw.trim();
  const titles = /^(dr|mr|mrs|ms|miss|prof|sir|dame|mx)\.?$/i;
  const first = foreRaw
    .trim()
    .split(/\s+/)
    .find((w) => w && !titles.test(w));
  if (!first || !last) return null;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  return `${cap(first)} ${cap(last)}`;
}

/** Company number of the best ACTIVE register match for this trading name. */
async function findActiveCompanyNumber(
  cfg: AppConfig,
  company: string,
): Promise<string | null> {
  const target = norm(company);
  if (target.length < 3) return null;
  const json = (await chGet(
    cfg,
    `/search/companies?q=${encodeURIComponent(company)}&items_per_page=20`,
  )) as { items?: CompanySearchItem[] } | null;
  const match = (json?.items ?? []).find((it) => {
    if (it.company_status !== "active" || !it.company_number) return false;
    const t = norm(it.title ?? "");
    return Boolean(t) && (t.includes(target) || target.includes(t));
  });
  return match?.company_number ?? null;
}

/**
 * The active director's name ("First Last") for a company, or null. Used to DERIVE
 * the owner's personal email when the site only exposed a role inbox. Companies
 * House free tier is generous (~600 req / 5 min), so this is cheap; the expensive
 * step downstream is verifying the guessed address. Returns null with no key, no
 * match, or no active director. Cached per process.
 */
export async function getActiveDirectorName(
  cfg: AppConfig,
  company: string | undefined | null,
): Promise<string | null> {
  if (!cfg.COMPANIES_HOUSE_API_KEY || !company) return null;
  const key = norm(company);
  if (key.length < 3) return null;
  if (directorCache.has(key)) return directorCache.get(key) ?? null;

  let out: string | null = null;
  try {
    const number = await findActiveCompanyNumber(cfg, company);
    if (number) {
      const json = (await chGet(
        cfg,
        `/company/${number}/officers?items_per_page=35&register_type=directors`,
      )) as { items?: Officer[] } | null;
      const director = (json?.items ?? []).find(
        (o) => /director/i.test(o.officer_role ?? "") && !o.resigned_on && o.name,
      );
      if (director?.name) out = normalizeOfficerName(director.name);
    }
  } catch {
    out = null;
  }
  directorCache.set(key, out);
  return out;
}
