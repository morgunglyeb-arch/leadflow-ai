import type { AppConfig } from "../config.js";
import type { DiscoveredLead } from "../types.js";
import type { LeadDiscoverer, DiscoverOptions } from "./index.js";
import type { ExpandedQuery } from "./icp.js";
import { loadDiscoveryFixture } from "./mock.js";
import { normalizeDomain } from "../sources/index.js";

interface PlaceV1 {
  displayName?: { text?: string };
  websiteUri?: string;
  nationalPhoneNumber?: string;
  rating?: number;
  userRatingCount?: number;
  formattedAddress?: string;
}
interface PlacesV1Response {
  places?: PlaceV1[];
}

const FIELD_MASK = [
  "places.displayName",
  "places.websiteUri",
  "places.nationalPhoneNumber",
  "places.rating",
  "places.userRatingCount",
  "places.formattedAddress",
].join(",");

export class MapsDiscoverer implements LeadDiscoverer {
  readonly source = "maps" as const;

  async discover(
    query: ExpandedQuery,
    cfg: AppConfig,
    opts: DiscoverOptions,
  ): Promise<DiscoveredLead[]> {
    if (opts.mock) {
      const leads = await loadDiscoveryFixture(query, this.source);
      return leads.slice(0, opts.maxLeads);
    }
    if (!cfg.GOOGLE_PLACES_API_KEY) {
      throw new Error("GOOGLE_PLACES_API_KEY not set");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.ENRICH_TIMEOUT_MS);
    let json: PlacesV1Response;
    try {
      const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "X-Goog-Api-Key": cfg.GOOGLE_PLACES_API_KEY,
          "X-Goog-FieldMask": FIELD_MASK,
          "content-type": "application/json",
        },
        body: JSON.stringify({ textQuery: query.full, pageSize: 20 }),
      });
      if (!res.ok) throw new Error(`places HTTP ${res.status}`);
      json = (await res.json()) as PlacesV1Response;
    } finally {
      clearTimeout(timer);
    }

    const seen = new Set<string>();
    const out: DiscoveredLead[] = [];
    for (const p of json.places ?? []) {
      if (!p.websiteUri) continue; // can't enrich without a site
      const domain = normalizeDomain(p.websiteUri);
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);
      const lead: DiscoveredLead = {
        company: p.displayName?.text ?? domain,
        domain,
        discovery_source: this.source,
        discovery_query: query.full,
      };
      if (p.nationalPhoneNumber) lead.phone = p.nationalPhoneNumber;
      if (typeof p.rating === "number") lead.rating = p.rating;
      if (typeof p.userRatingCount === "number") lead.reviews = p.userRatingCount;
      if (p.formattedAddress) lead.location = p.formattedAddress;
      out.push(lead);
      if (out.length >= opts.maxLeads) break;
    }
    return out;
  }
}
