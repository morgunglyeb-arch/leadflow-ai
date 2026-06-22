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
}

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
  const target = norm(company ?? "");
  if (target.length < 3) return null; // too vague to match safely
  if (cache.has(target)) return cache.get(target) ?? null;

  let result: boolean | null = null;
  try {
    const url = `${CH_SEARCH_URL}?q=${encodeURIComponent(company ?? "")}&items_per_page=20`;
    const auth = Buffer.from(`${cfg.COMPANIES_HOUSE_API_KEY}:`).toString("base64");
    const res = await fetch(url, {
      headers: { authorization: `Basic ${auth}`, accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    // Don't poison the cache on transient failures — let a later run retry.
    if (res.status === 429 || res.status >= 500) return null;
    if (!res.ok) {
      cache.set(target, null);
      return null;
    }
    const json = (await res.json()) as { items?: CompanySearchItem[] };
    const items = json.items ?? [];
    result = items.some((it) => {
      if (it.company_status !== "active") return false;
      const t = norm(it.title ?? "");
      if (!t) return false;
      // Conservative two-way containment so "Bright Smile" matches
      // "BRIGHT SMILE DENTAL CARE LTD" without matching unrelated firms.
      return t.includes(target) || target.includes(t);
    });
  } catch {
    result = null;
  }
  if (result !== null) cache.set(target, result);
  return result;
}
