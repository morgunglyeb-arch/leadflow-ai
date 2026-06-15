import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiscoveredLead, DiscoverySource } from "../types.js";
import type { ExpandedQuery } from "./icp.js";
import { querySlug } from "./icp.js";
import { normalizeDomain } from "../sources/index.js";

const FIXTURE_DIR = "data/fixtures/discovery";

interface RawCandidate {
  company: string;
  domain: string;
  name?: string;
  role?: string;
  email?: string;
  phone?: string;
  rating?: number;
  reviews?: number;
  location?: string;
}

/**
 * Reads data/fixtures/discovery/<query-slug>.json — an array of raw candidates —
 * so `--mock` discovery is deterministic and offline, mirroring the rest of the
 * pipeline's fixture story.
 */
export async function loadDiscoveryFixture(
  query: ExpandedQuery,
  source: DiscoverySource,
): Promise<DiscoveredLead[]> {
  const path = join(FIXTURE_DIR, `${querySlug(query.full)}.json`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  let parsed: RawCandidate[];
  try {
    parsed = JSON.parse(raw) as RawCandidate[];
  } catch {
    return [];
  }
  return parsed
    .filter((c) => c.company && c.domain)
    .map((c) => {
      const lead: DiscoveredLead = {
        company: c.company,
        domain: normalizeDomain(c.domain),
        discovery_source: source,
        discovery_query: query.full,
      };
      if (c.name) lead.name = c.name;
      if (c.role) lead.role = c.role;
      if (c.email) lead.email = c.email;
      if (c.phone) lead.phone = c.phone;
      if (typeof c.rating === "number") lead.rating = c.rating;
      if (typeof c.reviews === "number") lead.reviews = c.reviews;
      if (c.location) lead.location = c.location;
      return lead;
    });
}
