import type { AppConfig } from "../config.js";
import type { DiscoveredLead } from "../types.js";
import type { ExpandedQuery, IcpConfig } from "./icp.js";
import { expandQueries, loadIcpConfig } from "./icp.js";
import { SearchDiscoverer } from "./search.js";
import { MapsDiscoverer } from "./maps.js";
import { VibeDiscoverer } from "./vibe.js";
import { normalizeDomain } from "../sources/index.js";

export interface DiscoverOptions {
  mock: boolean;
  maxLeads: number;
}

/**
 * A LeadDiscoverer turns one ICP query into candidate leads. Implementations:
 * web search (Serper), Google Places (maps), and a Vibe-Prospecting export
 * reader (populated by the agent via the MCP). All return DiscoveredLead[].
 */
export interface LeadDiscoverer {
  readonly source: DiscoveredLead["discovery_source"];
  discover(query: ExpandedQuery, cfg: AppConfig, opts: DiscoverOptions): Promise<DiscoveredLead[]>;
}

export function buildDiscoverer(cfg: AppConfig): LeadDiscoverer {
  switch (cfg.DISCOVERY_SOURCE) {
    case "maps":
      return new MapsDiscoverer();
    case "vibe":
      return new VibeDiscoverer();
    case "search":
    case "seed":
    case "csv":
    default:
      return new SearchDiscoverer();
  }
}

/** Strip emoji / GMB spam decorations and collapse whitespace in a name. */
export function sanitizeCompany(name: string): string {
  return name
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu,
      "",
    )
    .replace(/[|•·–—]+\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 80);
}

/** Fisher–Yates shuffle (copy). Used to rotate geo-by-city queries per run. */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const ai = a[i] as T;
    a[i] = a[j] as T;
    a[j] = ai;
  }
  return a;
}

/** Drop leads with no domain and collapse duplicates by normalized domain. */
export function dedupeLeads(leads: DiscoveredLead[]): DiscoveredLead[] {
  const seen = new Set<string>();
  const out: DiscoveredLead[] = [];
  for (const lead of leads) {
    const domain = normalizeDomain(lead.domain);
    if (!domain) continue;
    if (seen.has(domain)) continue;
    seen.add(domain);
    const company = sanitizeCompany(lead.company) || domain;
    out.push({ ...lead, domain, company });
  }
  return out;
}

export interface DiscoverResult {
  leads: DiscoveredLead[];
  icp: IcpConfig;
  queries: ExpandedQuery[];
}

export async function discoverLeads(
  cfg: AppConfig,
  opts: DiscoverOptions,
): Promise<DiscoverResult> {
  const icp = await loadIcpConfig(cfg.ICP_CONFIG_PATH);
  const queries = expandQueries(icp);
  const discoverer = buildDiscoverer(cfg);

  const maxLeads = opts.maxLeads || icp.max_leads || cfg.MAX_LEADS;
  // Spread the budget across queries so one niche doesn't eat the whole run.
  const perQuery = Math.max(2, Math.ceil(maxLeads / queries.length));
  const all: DiscoveredLead[] = [];

  // With geo-by-city there are far more queries than we fill in one run, so we
  // hit only the FRONT of the list — shuffle it so each run samples different
  // towns (and so we take just a few leads per city, not 12 from one giant city).
  const ordered = icp.cities?.length ? shuffle(queries) : queries;
  for (const q of ordered) {
    if (all.length >= maxLeads) break;
    const remaining = Math.min(perQuery, maxLeads - all.length);
    try {
      const found = await discoverer.discover(q, cfg, { ...opts, maxLeads: remaining });
      all.push(...found);
      console.log(
        `[discover] "${q.full}" (${discoverer.source}) → ${found.length} candidates`,
      );
    } catch (err) {
      console.warn(`[discover] "${q.full}" failed: ${(err as Error).message}`);
    }
  }

  const deduped = dedupeLeads(all).slice(0, maxLeads);
  return { leads: deduped, icp, queries };
}
