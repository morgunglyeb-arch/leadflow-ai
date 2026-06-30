// Bank backfill — load already-WRITTEN leads (data/out/leads_enriched.csv) and turn
// them into sendable OutputRows WITHOUT any LLM/Gemini call. The copy (subject/opener/
// body) was generated in earlier runs; here we only parse + filter so the send queue
// can be topped up from stock when fresh generation is rate-limited/banned/slow.
//
// Single source of truth for both `scripts/enqueue-banked.ts` (manual) and the
// automatic in-run backfill in run.ts. Sending needs no Gemini — this keeps the
// pipeline moving when key limits run out.
import fs from "node:fs";
import type { OutputRow } from "../types.js";

export const BANK_CSV = "data/out/leads_enriched.csv";

// Minimal RFC4180-ish CSV parser (handles quoted fields + embedded commas/newlines).
function parseCSV(s: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  const Q = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === Q) {
        if (s[i + 1] === Q) {
          f += Q;
          i++;
        } else q = false;
      } else f += ch;
    } else if (ch === Q) q = true;
    else if (ch === ",") {
      row.push(f);
      f = "";
    } else if (ch === "\n") {
      row.push(f);
      rows.push(row);
      row = [];
      f = "";
    } else if (ch !== "\r") f += ch;
  }
  if (f.length || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows;
}

const TRADE =
  /plumb|electric|heat|boiler|gas|roof|build|construct|clean|landscap|garden|kitchen|bathroom|joiner|carpenter|painter|drain|hvac|locksmith|pest|window|fencing|driveway|paving|tiler|plaster/i;
const PROSERV =
  /account|estate|letting|mortgage|insurance|solicitor|legal|financial|wealth|ifa|advisor|adviser|surveyor|conveyanc|broker|consult|bookkeep/i;
const CLINIC =
  /dental|dentist|physio|chiro|osteo|clinic|\bgp\b|medical|aesthetic|orthodont|hygien|practice|veterinar|optician|health/i;

export function segmentOf(q: string): string {
  if (TRADE.test(q)) return "trade";
  if (PROSERV.test(q)) return "proserv";
  if (CLINIC.test(q)) return "clinic";
  return "other";
}

// Default allow-list mirrors the ICP pivot (trades + professional services); clinics
// are excluded by default. Override via SEGMENTS env (comma-separated).
export function allowedSegments(): string[] {
  return (process.env.SEGMENTS ?? "trade,proserv,other").split(",").map((s) => s.trim());
}

// Parse the bank CSV into qualified, sendable OutputRows. Skips rows without a valid
// email, junk (ai_provider=fallback), and segments outside the allow-list. Newest rows
// LAST in the file (it's append-only) → callers that want freshest-first can reverse.
export function loadBankLeads(allow: string[] = allowedSegments()): OutputRow[] {
  if (!fs.existsSync(BANK_CSV)) return [];
  const rows = parseCSV(fs.readFileSync(BANK_CSV, "utf8"));
  if (!rows.length) return [];
  const h = (rows[0] ?? []).map((x) => x.replace(/^﻿/, ""));
  const col = (n: string) => h.indexOf(n);
  const g = (r: string[], n: string) => r[col(n)] ?? "";
  const out: OutputRow[] = [];
  for (const r of rows.slice(1)) {
    if (r.length < 2) continue;
    const email = g(r, "email");
    if (!email.includes("@")) continue;
    if (g(r, "ai_provider") === "fallback") continue; // skip junk fallback copy
    if (!allow.includes(segmentOf(g(r, "discovery_query")))) continue;
    out.push({
      status: "qualified",
      company: g(r, "company"),
      domain: g(r, "domain"),
      name: g(r, "name"),
      role: g(r, "role"),
      email,
      email_source: g(r, "email_source"),
      phone: g(r, "phone"),
      location: g(r, "location"),
      discovery_source: g(r, "discovery_source"),
      discovery_query: g(r, "discovery_query"),
      ai_provider: g(r, "ai_provider"),
      fit_score: Number(g(r, "fit_score")) || 0,
      subject: g(r, "subject"),
      opener: g(r, "opener"),
      icebreaker: g(r, "icebreaker"),
      process: g(r, "process"),
      automation: g(r, "automation"),
      est_benefit: g(r, "est_benefit"),
      reason: g(r, "reason"),
      followup_1: g(r, "followup_1"),
      followup_2: g(r, "followup_2"),
      subject_b: g(r, "subject_b"),
    } as unknown as OutputRow);
  }
  return out;
}
