import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { DiscoveredLead } from "../types.js";
import type { LeadDiscoverer, DiscoverOptions } from "./index.js";
import type { ExpandedQuery } from "./icp.js";
import { loadDiscoveryFixture } from "./mock.js";
import { normalizeDomain } from "../sources/index.js";

interface VibeCandidate {
  company?: string;
  name?: string;
  domain?: string;
  website?: string;
  contact_name?: string;
  title?: string;
  role?: string;
  email?: string;
  location?: string;
}

/**
 * Vibe Prospecting lives behind an MCP (agent-time), not a runtime HTTP client.
 * The agent runs a prospecting session via the MCP and writes normalized JSON
 * exports into VIBE_EXPORT_DIR (e.g. data/discovered/vibe_*.json). This adapter
 * reads those exports so the deterministic pipeline can take over.
 *
 * In --mock mode it reads the shared discovery fixtures like the other sources.
 */
export class VibeDiscoverer implements LeadDiscoverer {
  readonly source = "vibe" as const;
  private served = false;

  async discover(
    query: ExpandedQuery,
    cfg: AppConfig,
    opts: DiscoverOptions,
  ): Promise<DiscoveredLead[]> {
    if (opts.mock) {
      const leads = await loadDiscoveryFixture(query, this.source);
      return leads.slice(0, opts.maxLeads);
    }

    // The export pool is query-independent — serve it once across the loop.
    if (this.served) return [];
    this.served = true;

    let files: string[];
    try {
      files = (await readdir(cfg.VIBE_EXPORT_DIR)).filter(
        (f) => f.startsWith("vibe") && f.endsWith(".json"),
      );
    } catch {
      throw new Error(
        `VIBE_EXPORT_DIR ${cfg.VIBE_EXPORT_DIR} not found. ` +
          "Run a Vibe Prospecting session via the MCP and export normalized JSON there.",
      );
    }
    if (files.length === 0) {
      throw new Error(
        `No vibe_*.json exports in ${cfg.VIBE_EXPORT_DIR}. ` +
          "Populate it from the Vibe Prospecting MCP, then re-run.",
      );
    }

    const out: DiscoveredLead[] = [];
    for (const file of files) {
      let candidates: VibeCandidate[];
      try {
        candidates = JSON.parse(
          await readFile(join(cfg.VIBE_EXPORT_DIR, file), "utf8"),
        ) as VibeCandidate[];
      } catch {
        continue;
      }
      for (const c of candidates) {
        const domain = normalizeDomain(c.domain ?? c.website ?? "");
        const company = c.company ?? c.name ?? "";
        if (!domain || !company) continue;
        const lead: DiscoveredLead = {
          company,
          domain,
          discovery_source: this.source,
          discovery_query: query.full,
        };
        if (c.contact_name) lead.name = c.contact_name;
        if (c.title ?? c.role) lead.role = c.title ?? c.role;
        if (c.email) lead.email = c.email;
        if (c.location) lead.location = c.location;
        out.push(lead);
        if (out.length >= opts.maxLeads) break;
      }
      if (out.length >= opts.maxLeads) break;
    }
    return out;
  }
}
