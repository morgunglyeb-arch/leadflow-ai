import type { AppConfig } from "../config.js";
import type { DiscoveredLead } from "../types.js";
import type { LeadDiscoverer, DiscoverOptions } from "./index.js";
import type { ExpandedQuery } from "./icp.js";
import { loadDiscoveryFixture } from "./mock.js";
import { normalizeDomain } from "../sources/index.js";

interface SerperOrganic {
  title?: string;
  link?: string;
  snippet?: string;
}
interface SerperResponse {
  organic?: SerperOrganic[];
}

// Domains that are never a prospect's own site.
const BLOCKLIST = [
  "google.",
  "facebook.",
  "instagram.",
  "linkedin.",
  "twitter.",
  "x.com",
  "youtube.",
  "yelp.",
  "tripadvisor.",
  "wikipedia.",
  "amazon.",
  "ebay.",
  "reddit.",
  "medium.",
  "crunchbase.",
  "glassdoor.",
  "indeed.",
  "yellowpages.",
  "maps.",
];

function isBlocked(domain: string): boolean {
  return BLOCKLIST.some((b) => domain.includes(b));
}

function companyFromTitle(title: string | undefined, domain: string): string {
  if (title) {
    // take the part before a common separator
    const cut = title.split(/[|\-–—:·]/)[0]?.trim();
    if (cut && cut.length >= 2) return cut;
  }
  // fall back to the domain's second-level label, title-cased
  const label = domain.split(".")[0] ?? domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export class SearchDiscoverer implements LeadDiscoverer {
  readonly source = "search" as const;

  async discover(
    query: ExpandedQuery,
    cfg: AppConfig,
    opts: DiscoverOptions,
  ): Promise<DiscoveredLead[]> {
    if (opts.mock) {
      const leads = await loadDiscoveryFixture(query, this.source);
      return leads.slice(0, opts.maxLeads);
    }
    if (!cfg.SERPER_API_KEY) {
      throw new Error("SERPER_API_KEY not set");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.ENRICH_TIMEOUT_MS);
    let json: SerperResponse;
    try {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "X-API-KEY": cfg.SERPER_API_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({ q: query.full, num: 20 }),
      });
      if (!res.ok) throw new Error(`serper HTTP ${res.status}`);
      json = (await res.json()) as SerperResponse;
    } finally {
      clearTimeout(timer);
    }

    const seen = new Set<string>();
    const out: DiscoveredLead[] = [];
    for (const item of json.organic ?? []) {
      if (!item.link) continue;
      const domain = normalizeDomain(item.link);
      if (!domain || isBlocked(domain) || seen.has(domain)) continue;
      seen.add(domain);
      out.push({
        company: companyFromTitle(item.title, domain),
        domain,
        discovery_source: this.source,
        discovery_query: query.full,
        ...(query.full.includes(" in ")
          ? { location: query.full.split(" in ").slice(1).join(" in ") }
          : {}),
      });
      if (out.length >= opts.maxLeads) break;
    }
    return out;
  }
}
