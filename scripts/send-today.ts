// Build a manual "send today" pack: pick the N best qualified leads from
// leads_enriched.csv and render each email with the REAL assembleDraft (so the
// body is byte-for-byte the locked format the machine would send). Output is a
// single markdown file the owner works through by hand. No sending here.
import fs from "node:fs";
import { loadConfig } from "../src/config";
import { assembleDraft } from "../src/outreach";
import type { OutputRow } from "../src/types";

const N = Number(process.env.N ?? 40);
const SRC = "data/out/leads_enriched.csv";
const OUT = process.env.OUT ?? "/Users/a1/opero-send-today.md";

function parseCSV(s: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], f = "", q = false;
  const Q = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === Q) { if (s[i + 1] === Q) { f += Q; i++; } else q = false; }
      else f += ch;
    } else {
      if (ch === Q) q = true;
      else if (ch === ",") { row.push(f); f = ""; }
      else if (ch === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
      else if (ch === "\r") { /* skip */ }
      else f += ch;
    }
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const TRADE = /plumb|electric|heat|boiler|gas|roof|build|construct|clean|landscap|garden|kitchen|bathroom|joiner|carpenter|painter|drain|hvac|locksmith|pest|window|fencing|driveway|paving|tiler|plaster/i;
const PROSERV = /account|estate|letting|mortgage|insurance|solicitor|legal|financial|wealth|ifa|advisor|adviser|surveyor|conveyanc|broker|consult|bookkeep/i;
const CLINIC = /dental|dentist|physio|chiro|osteo|clinic|\bgp\b|medical|aesthetic|orthodont|hygien|practice|veterinar|optician|health/i;
function segmentOf(q: string): "trade" | "proserv" | "clinic" | "other" {
  if (TRADE.test(q)) return "trade";
  if (PROSERV.test(q)) return "proserv";
  if (CLINIC.test(q)) return "clinic";
  return "other";
}
// Which segments to include. Default: NEW ICP only (exclude the abandoned clinics).
const ALLOW = (process.env.SEGMENTS ?? "trade,proserv,other").split(",").map((s) => s.trim());

const rows = parseCSV(fs.readFileSync(SRC, "utf8"));
if (rows.length === 0) throw new Error(`empty CSV: ${SRC}`);
const h = (rows[0] ?? []).map((x) => x.replace(/^﻿/, ""));
const idx = (n: string) => h.indexOf(n);
const get = (r: string[], n: string) => r[idx(n)] ?? "";

const records = rows.slice(1)
  .filter((r) => r.length > 1 && get(r, "email").includes("@"))
  .filter((r) => ALLOW.includes(segmentOf(get(r, "discovery_query"))))
  .map((r) => ({
    company: get(r, "company"),
    domain: get(r, "domain"),
    name: get(r, "name"),
    role: get(r, "role"),
    email: get(r, "email"),
    email_source: get(r, "email_source"),
    phone: get(r, "phone"),
    location: get(r, "location"),
    provider: get(r, "ai_provider"),
    fit: Number(get(r, "fit_score")) || 0,
    query: get(r, "discovery_query"),
    subject: get(r, "subject"),
    opener: get(r, "opener"),
    icebreaker: get(r, "icebreaker"),
    seg: segmentOf(get(r, "discovery_query")),
    isLtd: /\bltd\b|\blimited\b|\bplc\b/i.test(get(r, "company")),
  }));

// rank: fit desc, then Gemini(openai) before openrouter, then has-phone
records.sort((a, b) =>
  b.fit - a.fit ||
  (a.provider === "openai" ? -1 : 1) - (b.provider === "openai" ? -1 : 1) ||
  (b.phone ? 1 : 0) - (a.phone ? 1 : 0)
);
const pick = records.slice(0, N);

const cfg = loadConfig();
const segCount: Record<string, number> = { trade: 0, proserv: 0, other: 0, clinic: 0 };
for (const p of pick) segCount[p.seg] = (segCount[p.seg] ?? 0) + 1;

const out: string[] = [];
out.push(`# Отправить сегодня — ${pick.length} лидов (ручная отправка)`);
out.push("");
out.push(`_Собрано из ${records.length} квалифицированных (все non-fallback, fit 4–5). Сегменты: trade ${segCount.trade} · proserv ${segCount.proserv} · other ${segCount.other}._`);
out.push("");
out.push("## ⚠️ Прежде чем слать");
out.push("- **Канал:** trade → лучше WhatsApp/звонок на phone (почта у них слабо читается). proserv → email их родной канал.");
out.push("- **НЕ слать с прогреваемых доменов** (opero-team / withopero / heyopero) — это де-факто холодный старт на дне-8 прогрева. Email-ручную слать с ОТДЕЛЬНОГО личного ящика.");
out.push("- **WhatsApp ≤15/день с одного номера** — 40 холодных за день = риск бана номера. Раскидать или слать меньше.");
out.push("- **PECR:** по почте — только Ltd (помечено ниже), с opt-out строкой (уже в теле).");
out.push("");
out.push("---");
out.push("");

pick.forEach((p, i) => {
  const draft = assembleDraft({
    company: p.company, domain: p.domain, name: p.name, role: p.role,
    email: p.email, email_source: p.email_source, phone: p.phone,
    subject: p.subject, opener: p.opener, icebreaker: p.icebreaker,
  } as unknown as OutputRow, cfg);
  const chan = p.seg === "trade" ? "📱 WhatsApp/звонок (или email)" : "✉️ Email";
  out.push(`### ${i + 1}. ${p.company} — ${p.seg.toUpperCase()} · fit ${p.fit} · ${p.provider}${p.isLtd ? " · Ltd" : " · ⚠️не-Ltd(PECR)"}`);
  out.push(`**Канал:** ${chan}`);
  out.push(`**To:** ${p.email}${p.email_source === "site" ? " _(с сайта)_" : ""}${p.name ? ` · ${p.name}${p.role ? ` (${p.role})` : ""}` : ""}`);
  if (p.phone) out.push(`**Phone:** ${p.phone}`);
  out.push(`**Subject:** ${draft.subject}`);
  out.push("");
  out.push("```");
  out.push(draft.body);
  out.push("```");
  out.push("");
  out.push("---");
  out.push("");
});

fs.writeFileSync(OUT, out.join("\n"));
console.log(`wrote ${pick.length} → ${OUT}`);
console.log(`segments: trade ${segCount.trade} · proserv ${segCount.proserv} · other ${segCount.other}`);
console.log(`Ltd: ${pick.filter((p) => p.isLtd).length}/${pick.length} · with phone: ${pick.filter((p) => p.phone).length}/${pick.length}`);
