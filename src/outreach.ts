import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config.js";
import type { OutputRow } from "./types.js";

export interface EmailDraft {
  to?: string;
  subject: string;
  body: string;
}

export interface EmailSequence {
  to?: string;
  subject: string;
  initial: string;
  followup_1: string;
  followup_2: string;
}

/**
 * The ONE curated list of automations shown to every clinic (owner-locked
 * 2026-06-24). The model kept inventing weak/generic menu items, so the menu is
 * now fixed + strong; only the HOOK above it is personalised per clinic. The
 * first item is the headline "agent" offer — there is no separate offer sentence.
 * Edit this list to change what every clinic is offered.
 */
export const CLINIC_MENU: string[] = [
  "An AI agent that takes bookings and answers patients 24/7",
  "Win back patients who haven't been in for a while",
  "Auto-fill last-minute cancellations from a waitlist",
  "Chase unbooked treatment plans until patients book",
  "A weekly report: bookings, no-shows, and who's due a recall",
];

/**
 * Full sendable bodies for the 3-touch sequence (greeting + content + opt-out +
 * signature). Used by the autonomous campaign sender.
 */
export function assembleSequence(row: OutputRow, cfg: AppConfig): EmailSequence {
  const greet = greeting(row.company, seedFrom(row.domain));
  const sig = `— ${cfg.SENDER_SIGNATURE}`;
  const initialDraft = assembleDraft(row, cfg);
  // assembleDraft already ends with the opt-out line (locked format) — use it as-is
  // so the sent email and the «Рассылка» review card are byte-identical (no dup).
  const initial = initialDraft.body;
  const fu = (text: string): string => `${greet}\n\n${text}\n\n${cfg.OPT_OUT_TEXT}\n\n${sig}`;
  // Follow-up #1 = the site self-serve invite (link kept OUT of the first touch).
  // Falls back to the AI-written nudge when the site CTA is disabled.
  const siteCta = cfg.SITE_CTA_ENABLED
    ? (cfg.SITE_CTA_LINE ?? "").replace("{site}", cfg.SITE_URL ?? "")
    : "";
  const fu1Body = siteCta || row.followup_1;
  return {
    ...(row.email ? { to: row.email } : {}),
    subject: initialDraft.subject,
    initial,
    followup_1: fu1Body ? fu(fu1Body) : "",
    followup_2: row.followup_2 ? fu(row.followup_2) : "",
  };
}

/**
 * Stable per-lead seed from the domain. The same lead always varies the same
 * way, so a thread's follow-ups keep ONE consistent greeting, while different
 * leads (and so an inbox's stream) don't all share a byte-identical skeleton.
 */
function seedFrom(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Greeting addresses the BUSINESS, not a person — the recipient often isn't the
 * named contact, so a wrong first name hurts. We use a tidy short company name.
 * The template is varied deterministically per lead (`seed`) so the same phrase
 * doesn't prefix every single send — a templated-mail / fingerprint tell that
 * hurts deliverability when one inbox streams identical skeletons.
 */
function greeting(company: string, seed = 0): string {
  const short = company
    .split(/[-–—|,:]/)[0]
    ?.replace(/\b(ltd|limited|llp|inc|llc)\b\.?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!short || short.length < 2) {
    const bare = ["Hello,", "Hi there,", "Hi,"];
    return bare[seed % bare.length]!;
  }
  const named = [
    `Hi ${short} team,`,
    `Hello ${short} team,`,
    `Hi there at ${short},`,
    `Hi ${short},`,
  ];
  return named[seed % named.length]!;
}

/**
 * Assemble a full, ready-to-review cold email. The model only personalises the
 * HOOK (icebreaker + opener); the rest is fixed owner-locked copy.
 * One unified format for every lead: hook → who-we-are → ONE curated menu
 * → sales-y site CTA → signature.
 */
export function assembleDraft(row: OutputRow, cfg: AppConfig): EmailDraft {
  const subject = row.subject ?? `quick idea for ${row.company}`;
  const lines: string[] = [];
  lines.push(greeting(row.company, seedFrom(row.domain)));
  lines.push("");

  // Body shape (owner spec): personalized hook FIRST (earns the read), then a
  // one-line "who we are" (no per-lead offer sentence), then the ONE curated menu
  // (CLINIC_MENU — its first item IS the headline agent offer), then the CTA, then
  // the Opero + site signature + opt-out. The hook must stay first — leading with
  // the self-intro reads as mass-mail and buries the reason they'd reply.
  const observation = [row.icebreaker, row.opener]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s))
    .join(" ");
  if (observation) {
    lines.push(observation);
    lines.push("");
  }

  // Who we are — JUST the studio intro, NO per-lead offer sentence (owner spec
  // 2026-06-24): the offer is now the FIRST item of the single curated list
  // below, so the email reads as one list, not "offer paragraph + menu".
  const intro = (cfg.STUDIO_INTRO ?? "").trim();
  if (intro) {
    lines.push(intro);
    lines.push("");
  }

  // ONE curated list (CLINIC_MENU) — fixed, strong, owner-locked. Not model-
  // generated (the model kept inventing weak/generic items). The hook above is
  // what's personalised; this list is the consistent high-value offering.
  const servicesIntro = cfg.SERVICES_INTRO ?? "A few things we could set up for you:";
  if (cfg.SHOW_SERVICES_MENU && CLINIC_MENU.length > 0) {
    lines.push(servicesIntro);
    for (const s of CLINIC_MENU) lines.push(`• ${s}`);
    lines.push("");
  }

  lines.push((cfg.CALL_TO_ACTION ?? "").replace("{site}", cfg.SITE_URL ?? ""));
  lines.push("");
  lines.push(`— ${cfg.SENDER_SIGNATURE}`);
  // Opt-out is part of the LOCKED format and a PECR/CAN-SPAM requirement. It must
  // live HERE (not only on the autonomous send path) because the «Рассылка» review
  // card is `assembleDraft` output verbatim, and the operator copy-pastes it by
  // hand — so the card must equal the real, compliant email byte-for-byte.
  const optOut = (cfg.OPT_OUT_TEXT ?? "").trim();
  if (optOut) {
    lines.push("");
    lines.push(optOut);
  }

  return {
    ...(row.email ? { to: row.email } : {}),
    subject,
    body: lines.join("\n"),
  };
}

function draftMarkdown(row: OutputRow, draft: EmailDraft, cfg: AppConfig): string {
  const meta = [
    `**Company:** ${row.company}`,
    `**Domain:** ${row.domain}`,
    row.name ? `**Contact:** ${row.name}${row.role ? ` (${row.role})` : ""}` : "",
    draft.to
      ? `**To:** ${draft.to}${row.email_source === "site" ? " _(found on site)_" : ""}`
      : "**To:** _(no email — find before sending)_",
    row.phone ? `**Phone:** ${row.phone}` : "",
    `**Fit:** ${row.fit_score ?? "?"} / 5 · **Status:** ${row.status}`,
    `**Source:** ${row.discovery_source}${row.discovery_query ? ` · "${row.discovery_query}"` : ""}`,
    row.signals ? `**Signals:** ${row.signals}` : "",
  ]
    .filter(Boolean)
    .join("  \n");

  const briefBlock = row.brief ? `\n> **Разбор:** ${row.brief}\n` : "";

  const greet = greeting(row.company, seedFrom(row.domain));
  // Mirror the real cadence + opt-out so the preview == what actually sends —
  // including the site self-serve invite that REPLACES the AI nudge in FU#1.
  const days = cfg.FOLLOWUP_GAP_DAYS.split(",").map((s) => Number.parseInt(s.trim(), 10));
  const siteCta = cfg.SITE_CTA_ENABLED
    ? (cfg.SITE_CTA_LINE ?? "").replace("{site}", cfg.SITE_URL ?? "")
    : "";
  const followups = [siteCta || row.followup_1, row.followup_2]
    .map((f, i) => {
      if (!f) return "";
      return `\n---\n\n**Follow-up ${i + 1}** _(send ~${days[i]} days later if no reply — same thread, subject "Re: ${draft.subject}")_\n\n${greet}\n\n${f}\n\n${cfg.OPT_OUT_TEXT}\n\n— ${cfg.SENDER_SIGNATURE}`;
    })
    .join("\n");

  const altSubject = row.subject_b ? `**Subject (B-variant):** ${row.subject_b}\n\n` : "";
  const demoBlock = row.demo
    ? `\n💬 **Example to show them** (drop into your reply): _${row.demo}_\n`
    : "";

  return `# Draft — ${row.company}

${meta}
${briefBlock}${demoBlock}
---

### Email 1 — initial

**Subject:** ${draft.subject}

${altSubject}${draft.body}
${followups}
`;
}

const DRAFT_CSV_COLUMNS = [
  "status",
  "company",
  "domain",
  "name",
  "role",
  "email",
  "phone",
  "fit_score",
  "discovery_source",
  "process",
  "automation",
  "est_benefit",
  "subject",
] as const;

function csvEscape(v: unknown): string {
  if (v === undefined || v === null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function domainSlug(domain: string): string {
  return domain.replace(/[^a-z0-9.]+/gi, "_");
}

export interface DraftsResult {
  count: number;
  dir: string;
  csv: string;
}

export async function writeDrafts(cfg: AppConfig, rows: OutputRow[]): Promise<DraftsResult> {
  await mkdir(cfg.DRAFTS_DIR, { recursive: true });
  // The queue mirrors this run — clear stale .md drafts from previous runs.
  try {
    const stale = (await readdir(cfg.DRAFTS_DIR)).filter((f) => f.endsWith(".md"));
    await Promise.all(stale.map((f) => rm(join(cfg.DRAFTS_DIR, f), { force: true })));
  } catch {
    /* dir was empty/new */
  }
  for (const row of rows) {
    const draft = assembleDraft(row, cfg);
    const path = join(cfg.DRAFTS_DIR, `${domainSlug(row.domain)}.md`);
    await writeFile(path, draftMarkdown(row, draft, cfg), "utf8");
  }

  const header = DRAFT_CSV_COLUMNS.join(",");
  const body = rows
    .map((r) => DRAFT_CSV_COLUMNS.map((c) => csvEscape(r[c as keyof OutputRow])).join(","))
    .join("\n");
  await mkdir(dirname(cfg.DRAFTS_CSV_PATH), { recursive: true });
  await writeFile(cfg.DRAFTS_CSV_PATH, "﻿" + header + "\n" + body + "\n", "utf8");

  return { count: rows.length, dir: cfg.DRAFTS_DIR, csv: cfg.DRAFTS_CSV_PATH };
}
