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

/** Drop leads with no domain and collapse duplicates by normalized domain. */
export function dedupeLeads(leads: DiscoveredLead[]): DiscoveredLead[] {
  const seen = new Set<string>();
  const out: DiscoveredLead[] = [];
  for (const lead of leads) {
    const domain = normalizeDomain(lead.domain);
    if (!domain) continue;
    if (seen.has(domain)) continue;
    seen.add(domain);
    out.push({ ...lead, domain });
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
  const all: DiscoveredLead[] = [];

  for (const q of queries) {
    if (all.length >= maxLeads) break;
    const remaining = maxLeads - all.length;
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
