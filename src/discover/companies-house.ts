import type { AppConfig } from "../config.js";
import type { DiscoveredLead } from "../types.js";
import type { LeadDiscoverer, DiscoverOptions } from "./index.js";
import type { ExpandedQuery } from "./icp.js";
import { loadDiscoveryFixture } from "./mock.js";
import { normalizeDomain } from "../sources/index.js";

// Companies House ADVANCED SEARCH as a free, unlimited, PECR-clean discovery source.
// Every result is an ACTIVE incorporated company (is_ltd=true by construction), so
// the whole "held: not-Ltd" supply loss disappears. CH gives name + registered
// address but NO website — we resolve the domain for free (name-guess + verify,
// DuckDuckGo fallback), then hand off to the normal enrich→verify→generate chain.
// Auth: the API key is the HTTP Basic *username*, blank password (same as ../companies-house.ts).

const CH_ADVANCED = "https://api.company-information.service.gov.uk/advanced-search/companies";

// ICP vertical (icp.json query text) → UK SIC 2007 codes. Self-declared SIC is
// noisy, so we ALSO name-filter below. Order roughly best-signal first.
const SIC_BY_VERTICAL: Array<[RegExp, string[]]> = [
  [/conveyanc|solicitor|\blaw\b|legal/i, ["69102", "69109"]],
  [/mortgage/i, ["66190", "64999"]],
  [/letting/i, ["68320"]],
  [/estate agent|commercial property|property agent/i, ["68310"]],
  [/bookkeep/i, ["69202"]],
  [/account|tax advis|tax consult/i, ["69201", "69202", "69203"]],
  [/insurance/i, ["66220"]],
  [/financial advis|wealth|ifa\b|independent financial/i, ["66300", "66190"]],
  [/chartered surveyor|surveyor/i, ["68310", "71129"]],
  [/recruit/i, ["78100", "78200", "78109"]],
];

function sicFor(vertical: string): string[] {
  for (const [re, sics] of SIC_BY_VERTICAL) if (re.test(vertical)) return sics;
  return [];
}

// "solicitors in Leeds, United Kingdom" → "Leeds". Falls back to "" (nationwide).
function cityFromFull(full: string): string {
  const m = full.match(/\bin\s+(.+?)(?:,\s*United Kingdom|,\s*UK)?\s*$/i);
  return m?.[1]?.trim() ?? "";
}

const STOP = new Set([
  "the", "and", "ltd", "limited", "llp", "co", "group", "services", "service",
  "uk", "solicitors", "solicitor", "accountants", "accountant", "associates",
  "consultancy", "consultants", "consulting", "financial", "insurance", "mortgage",
  "mortgages", "property", "properties", "legal", "law", "estate", "estates",
]);
function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

// Does the company name signal it's actually in this vertical (cuts self-declared
// SIC noise, e.g. "WE HELP YOU BUY ANY CAR LTD" under an insurance SIC)?
const VERTICAL_WORDS: Array<[RegExp, RegExp]> = [
  [/solicitor|conveyanc|\blaw\b|legal/i, /solicit|law|legal|conveyanc|chambers|advocat/i],
  [/mortgage/i, /mortgage|finance|financial|lending|loan/i],
  [/estate agent|letting|property agent|commercial property/i, /estate|letting|property|homes|land|realty|lettings/i],
  [/account|bookkeep|tax/i, /account|bookkeep|\btax\b|audit|financ|ledger/i],
  [/insurance/i, /insur|assurance|risk|broker|cover|protect/i],
  [/financial advis|wealth|ifa/i, /wealth|financ|invest|advis|capital|asset|planning/i],
  [/surveyor/i, /survey|property|building|charter/i],
  [/recruit/i, /recruit|talent|staffing|resourc|personnel|hr\b/i],
];
function nameMatchesVertical(name: string, vertical: string): boolean {
  for (const [v, n] of VERTICAL_WORDS) if (v.test(vertical)) return n.test(name);
  return true; // no rule → don't over-filter
}

async function fetchText(url: string, cfg: AppConfig, headers?: Record<string, string>): Promise<{ code: number; body: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.ENRICH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: headers ?? { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    });
    const body = await res.text();
    return { code: res.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Free domain resolution: guess candidates from the name and HTTP-verify (name token
// must appear in the domain or the page), then a DuckDuckGo HTML fallback.
function domainCandidates(name: string): string[] {
  const base = name
    .toLowerCase()
    .replace(/\b(ltd|limited|llp)\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (base.length === 0) return [];
  const joined = base.join("");
  const hyph = base.join("-");
  const firstTwo = base.slice(0, 2).join("");
  const stems = [...new Set([joined, hyph, firstTwo].filter(Boolean))];
  const out: string[] = [];
  for (const stem of stems) for (const tld of [".co.uk", ".com", ".uk"]) out.push(stem + tld);
  return out.slice(0, 8);
}

async function resolveDomain(name: string, cfg: AppConfig): Promise<string | undefined> {
  const toks = nameTokens(name);
  for (const cand of domainCandidates(name)) {
    const r = await fetchText(`https://${cand}`, cfg);
    if (r && r.code < 400) {
      const low = r.body.toLowerCase();
      if (toks.some((t) => cand.includes(t)) || toks.some((t) => low.includes(t))) {
        return normalizeDomain(cand) || cand;
      }
    }
  }
  // DuckDuckGo HTML fallback (free, no key). Rate-limited — one shot per company.
  const r = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${name} UK`)}`, cfg);
  if (r && r.code < 400) {
    const links = [...r.body.matchAll(/uddg=(https?%3A%2F%2F[^"&]+)/g)].slice(0, 5);
    for (const m of links) {
      const url = decodeURIComponent(m[1] ?? "");
      const dom = normalizeDomain(url);
      if (
        dom &&
        !/facebook|linkedin|gov\.uk|yell|google|companieshouse|find-and-update|trustpilot|checkatrade|instagram|twitter/.test(dom) &&
        toks.some((t) => dom.includes(t))
      ) {
        return dom;
      }
    }
  }
  return undefined;
}

interface CHAdvancedItem {
  company_name?: string;
  company_number?: string;
  company_status?: string;
  registered_office_address?: { locality?: string; postal_code?: string; region?: string };
}

export class CompaniesHouseDiscoverer implements LeadDiscoverer {
  readonly source = "search" as const; // reuse a valid DiscoverySource for the lead field

  async discover(query: ExpandedQuery, cfg: AppConfig, opts: DiscoverOptions): Promise<DiscoveredLead[]> {
    if (opts.mock) {
      const leads = await loadDiscoveryFixture(query, "search");
      return leads.slice(0, opts.maxLeads);
    }
    if (!cfg.COMPANIES_HOUSE_API_KEY) throw new Error("COMPANIES_HOUSE_API_KEY not set");
    const sics = sicFor(query.query);
    if (sics.length === 0) return []; // vertical has no SIC mapping → nothing to search

    const city = cityFromFull(query.full);
    // Over-fetch: ~60% of CH rows won't resolve to a live site, so pull several×
    // the target and stop once we have enough resolved domains.
    const want = Math.max(2, opts.maxLeads);
    const pull = Math.min(100, want * 6);
    const params = new URLSearchParams({
      sic_codes: sics.join(","),
      company_status: "active",
      size: String(pull),
    });
    if (city) params.set("location", city);

    const auth = Buffer.from(`${cfg.COMPANIES_HOUSE_API_KEY}:`).toString("base64");
    const r = await fetchText(`${CH_ADVANCED}?${params.toString()}`, cfg, {
      authorization: `Basic ${auth}`,
      accept: "application/json",
    });
    if (!r || r.code >= 400) throw new Error(`companies-house HTTP ${r?.code ?? "timeout"}`);

    let items: CHAdvancedItem[] = [];
    try {
      items = (JSON.parse(r.body) as { items?: CHAdvancedItem[] }).items ?? [];
    } catch {
      throw new Error("companies-house: bad JSON");
    }

    const out: DiscoveredLead[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      if (out.length >= opts.maxLeads) break;
      const name = it.company_name?.trim();
      if (!name) continue;
      if (!nameMatchesVertical(name, query.query)) continue; // cut SIC self-declaration noise
      const domain = await resolveDomain(name, cfg);
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);
      const addr = it.registered_office_address;
      // Every row is an ACTIVE incorporated company, so the downstream enrich CH
      // lookup will confirm is_ltd=true — PECR-clean by construction.
      const lead: DiscoveredLead = {
        company: name,
        domain,
        discovery_source: this.source,
        discovery_query: query.full,
      };
      if (addr?.locality || addr?.postal_code) lead.location = [addr.locality, addr.postal_code].filter(Boolean).join(", ");
      out.push(lead);
    }
    return out;
  }
}
