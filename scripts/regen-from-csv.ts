// Regenerate drafts from ALREADY-discovered leads in data/out/leads_enriched.csv
// — re-personalize on the working LLM and emit fresh drafts to Opero Ops, WITHOUT
// touching discovery (Serper) or email-finding (Hunter). The "send today" path
// when discovery/Hunter quotas are down: we already have the domains + emails, so
// the only external call is the LLM (enrichment is served from cache when warm).
//   npx tsx scripts/regen-from-csv.ts
import { readFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { processLeads } from "../src/pipeline.js";
import { emitDrafts } from "../src/prospect.js";
import type { DiscoveredLead } from "../src/types.js";

/** Minimal quote-aware CSV parser (fields may contain commas/quotes/newlines). */
function parseCsv(text: string): Record<string, string>[] {
  const t = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQ = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQ) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = (rows.shift() ?? []).map((h) => h.trim());
  return rows
    .filter((r) => r.length > 1)
    .map((r) => {
      const o: Record<string, string> = {};
      header.forEach((h, idx) => {
        o[h] = (r[idx] ?? "").trim();
      });
      return o;
    });
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  // Emails came from the sites already (email_source=site) — don't re-verify
  // (that would burn Hunter). Mutate the in-memory config only.
  (cfg as { EMAIL_VERIFY: boolean }).EMAIL_VERIFY = false;

  const csv = await readFile("data/out/leads_enriched.csv", "utf8");
  const recs = parseCsv(csv);
  const seen = new Set<string>();
  const leads: DiscoveredLead[] = [];
  for (const r of recs) {
    const company = r.company;
    const domain = r.domain;
    if (!company || !domain) continue;
    if (!r.email || !r.email.includes("@")) continue;
    const dom = domain.toLowerCase();
    if (seen.has(dom)) continue;
    seen.add(dom);
    leads.push({
      company,
      domain,
      email: r.email,
      discovery_source: "csv",
      ...(r.discovery_query ? { discovery_query: r.discovery_query } : {}),
      ...(r.phone ? { phone: r.phone } : {}),
      ...(r.location ? { location: r.location } : {}),
      ...(r.rating ? { rating: Number(r.rating) } : {}),
      ...(r.reviews ? { reviews: Number(r.reviews) } : {}),
    });
  }
  console.log(`[regen] ${leads.length} unique leads with email — re-personalizing (no Serper/Hunter)`);

  const rows = await processLeads(cfg, leads, {
    mock: false,
    force: false, // use the enrichment cache when warm = zero site fetches
    concurrency: 2,
    llmReady: true,
    label: "regen",
    requireEmail: false,
  });

  const provs: Record<string, number> = {};
  for (const r of rows) {
    const k = r.ai_provider ?? "none";
    provs[k] = (provs[k] ?? 0) + 1;
  }
  console.log(`[regen] providers: ${JSON.stringify(provs)}`);

  // Only emit REAL generations — drop fallbacks so the batch stays clean.
  const good = rows.filter((r) => r.ai_provider && r.ai_provider !== "fallback");
  console.log(`[regen] emitting ${good.length}/${rows.length} real drafts (dropped ${rows.length - good.length} fallback)`);
  // RU translation is GUARANTEED inside emitDrafts (the single emit choke point),
  // so this path doesn't need a separate translate step — it can't be forgotten.
  await emitDrafts(cfg, good);
  const keys = good.map((r) => (r.domain || r.email || r.company).toLowerCase());
  console.log(`[regen] EMITTED_KEYS ${JSON.stringify(keys)}`);
  console.log("[regen] done → check Рассылка");
}

void main();
