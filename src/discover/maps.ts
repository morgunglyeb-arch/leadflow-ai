import type { AppConfig } from "../config.js";
import type { DiscoveredLead } from "../types.js";
import type { LeadDiscoverer, DiscoverOptions } from "./index.js";
import type { ExpandedQuery } from "./icp.js";
import { loadDiscoveryFixture } from "./mock.js";
import { normalizeDomain } from "../sources/index.js";

// --- Google Places (New) ----------------------------------------------------
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

// --- Serper /places ---------------------------------------------------------
interface SerperPlace {
  title?: string;
  address?: string;
  phoneNumber?: string;
  website?: string;
  rating?: number;
  ratingCount?: number;
}
interface SerperPlacesResponse {
  places?: SerperPlace[];
}
interface SerperOrganic {
  link?: string;
  title?: string;
}
interface SerperSearchResponse {
  organic?: SerperOrganic[];
}

// Domains that aren't a business's own site (directories / aggregators).
const NON_SITE = [
  "google.",
  "facebook.",
  "instagram.",
  "linkedin.",
  "yelp.",
  "tripadvisor.",
  "nhs.uk",
  "yell.com",
  "trustpilot.",
  "booking.com",
  "doctolib.",
  "treatwell.",
  "checkatrade.",
  "trustatrader.",
  "bark.com",
  "thomsonlocal.",
  "wikipedia.",
  "youtube.",
  "tiktok.",
  "maps.",
];
function isNonSite(domain: string): boolean {
  return NON_SITE.some((b) => domain.includes(b));
}

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
    if (cfg.MAPS_PROVIDER === "google") {
      return this.viaGoogle(query, cfg, opts);
    }
    return this.viaSerper(query, cfg, opts);
  }

  private async viaGoogle(
    query: ExpandedQuery,
    cfg: AppConfig,
    opts: DiscoverOptions,
  ): Promise<DiscoveredLead[]> {
    if (!cfg.GOOGLE_PLACES_API_KEY) throw new Error("GOOGLE_PLACES_API_KEY not set");
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
      if (!p.websiteUri) continue;
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

  private async viaSerper(
    query: ExpandedQuery,
    cfg: AppConfig,
    opts: DiscoverOptions,
  ): Promise<DiscoveredLead[]> {
    if (!cfg.SERPER_API_KEY) throw new Error("SERPER_API_KEY not set");
    const places = await serperPlaces(query.full, cfg);

    const seen = new Set<string>();
    const out: DiscoveredLead[] = [];
    for (const p of places) {
      if (out.length >= opts.maxLeads) break;
      if (!p.title) continue;
      // Serper /places omits the website — resolve it with one search, and
      // verify the result actually belongs to THIS business (not a competitor).
      const domain = p.website
        ? normalizeDomain(p.website)
        : await resolveDomain(p.title, p.address ?? "", cfg);
      if (!domain || isNonSite(domain) || seen.has(domain)) continue;
      seen.add(domain);
      const lead: DiscoveredLead = {
        company: p.title,
        domain,
        discovery_source: this.source,
        discovery_query: query.full,
      };
      if (p.phoneNumber) lead.phone = p.phoneNumber;
      if (typeof p.rating === "number") lead.rating = p.rating;
      if (typeof p.ratingCount === "number") lead.reviews = p.ratingCount;
      if (p.address) lead.location = p.address;
      out.push(lead);
    }
    return out;
  }
}

async function serperPlaces(q: string, cfg: AppConfig): Promise<SerperPlace[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.ENRICH_TIMEOUT_MS);
  try {
    const res = await fetch("https://google.serper.dev/places", {
      method: "POST",
      signal: controller.signal,
      headers: { "X-API-KEY": cfg.SERPER_API_KEY!, "content-type": "application/json" },
      body: JSON.stringify({ q, num: 20 }),
    });
    if (!res.ok) throw new Error(`serper places HTTP ${res.status}`);
    const json = (await res.json()) as SerperPlacesResponse;
    return json.places ?? [];
  } finally {
    clearTimeout(timer);
  }
}

function nameTokens(name: string): string[] {
  const stop = new Set([
    "the", "and", "ltd", "limited", "clinic", "centre", "center", "company",
    "services", "london", "uk", "co", "group", "practice", "studio",
  ]);
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stop.has(w));
}

/**
 * Resolve a business's own website from its name + address, and VERIFY the
 * match so we don't attach a competitor's domain. A domain is accepted only if
 * a distinctive word from the name appears in the domain root or the result's
 * title — otherwise we'd rather drop the lead (we over-fetch to compensate).
 */
async function resolveDomain(
  title: string,
  address: string,
  cfg: AppConfig,
): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.ENRICH_TIMEOUT_MS);
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      signal: controller.signal,
      headers: { "X-API-KEY": cfg.SERPER_API_KEY!, "content-type": "application/json" },
      body: JSON.stringify({ q: `${title} ${address}`, num: 5 }),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as SerperSearchResponse;
    const tokens = nameTokens(title);

    for (const item of json.organic ?? []) {
      if (!item.link) continue;
      const domain = normalizeDomain(item.link);
      if (!domain || isNonSite(domain)) continue;
      const root = domain.split(".")[0] ?? "";
      const resultTitle = (item.title ?? "").toLowerCase();
      // accept if a distinctive name word is in the domain, or >=2 in the title
      const inDomain = tokens.some((t) => root.includes(t));
      const inTitle = tokens.filter((t) => resultTitle.includes(t)).length >= 2;
      if (tokens.length === 0 || inDomain || inTitle) return domain;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
