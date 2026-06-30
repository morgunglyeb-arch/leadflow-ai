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
 * The ONE curated list of automations shown to every business (owner-locked;
 * generic service-business menu since the 2026-06-27 pivot to trades + professional
 * services). The model kept inventing weak/generic items, so the menu is fixed +
 * strong; only the HOOK above it is personalised per business. The first item is
 * the headline "assistant" offer — there is no separate offer sentence.
 * Edit this list to change what every business is offered.
 */
export const CLINIC_MENU: string[] = [
  "An assistant that answers new enquiries and books you in 24/7",
  "Instant text-back to missed calls — so the caller books you, not the next company",
  "Chase quotes and enquiries that went quiet, until they reply",
  "Win back past customers who haven't been back in a while",
  "Automatic review requests after each job, plus a weekly report",
];

/**
 * FIXED Russian rendering of CLINIC_MENU for the owner-facing review card. The
 * menu is locked, so its translation is locked too — translating these terse
 * bullets through the LLM per-lead produced wrong words ("chase"→"преследование"/
 * stalking). Keep 1:1 aligned with CLINIC_MENU above.
 */
export const CLINIC_MENU_RU: string[] = [
  "Ассистент, который отвечает на новые заявки и записывает 24/7",
  "Мгновенный авто-SMS на пропущенный звонок — чтобы клиент записался к вам, а не к следующим",
  "Дожимаем заявки и сметы, которые затихли, до ответа",
  "Возвращаем прошлых клиентов, которые давно не обращались",
  "Автозапрос отзыва после работы + еженедельный отчёт",
];

// FIXED Russian copy for the other LOCKED parts of the email, for the owner's
// review card. Owner-facing only (never sent). Keep aligned with the English
// STUDIO_INTRO / SERVICES_INTRO / CALL_TO_ACTION / OPT_OUT if those ever change.
const STUDIO_INTRO_RU =
  "Мы Opero — студия, которая под ключ настраивает бизнесу автоматизации, чтобы рутина в админке работала сама.";
const SERVICES_INTRO_RU = "Вот что мы могли бы вам настроить:";
const CALL_TO_ACTION_RU =
  "Хотите увидеть, где можно сэкономить время или деньги? Введите свою сферу на opero-studio.com — он покажет автоматизации под ваш бизнес. Или просто ответьте, и я пришлю короткий пример.";
const OPT_OUT_RU = "Не актуально? Ответьте «нет», и я больше не буду писать.";

/**
 * Build the OWNER-FACING Russian review body: the locked parts (intro, menu, CTA,
 * signature, opt-out) come from the fixed RU copy above; only the personalised
 * HOOK is translated (passed in as `hookRu`). This keeps the menu RU correct and
 * costs one small hook translation instead of translating the whole body per lead.
 */
export function assembleDraftRu(row: OutputRow, cfg: AppConfig, hookRu: string): string {
  const lines: string[] = [];
  lines.push(greeting(row.company, seedFrom(row.domain)));
  lines.push("");
  const hk = hookRu.trim();
  if (hk) {
    lines.push(hk);
    lines.push("");
  }
  lines.push(STUDIO_INTRO_RU);
  lines.push("");
  if (cfg.SHOW_SERVICES_MENU && CLINIC_MENU_RU.length > 0) {
    lines.push(SERVICES_INTRO_RU);
    for (const s of CLINIC_MENU_RU) lines.push(`• ${s}`);
    lines.push("");
  }
  lines.push(CALL_TO_ACTION_RU);
  lines.push("");
  lines.push(`— ${cfg.SENDER_SIGNATURE}`);
  lines.push("");
  lines.push(OPT_OUT_RU);
  return lines.join("\n");
}

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
// Tidy short business name (drop suffixes/separators) — shared by the greeting and
// the soft-CTA {company} token so they read consistently.
function shortName(company: string): string {
  return (
    company
      .split(/[-–—|,:]/)[0]
      ?.replace(/\b(ltd|limited|llp|inc|llc)\b\.?/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim() ?? ""
  );
}

function greeting(company: string, seed = 0): string {
  const short = shortName(company);
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
// Format A/B selector (owner-authorized). Deterministic per lead by domain, so a
// thread's follow-ups + the review card stay on ONE variant. B is the audit's
// open/conversion variant; A is the current owner-locked format.
export function formatVariantFor(row: OutputRow, cfg: AppConfig): "A" | "B" {
  if (!cfg.EMAIL_FORMAT_AB) return "A";
  return seedFrom(row.domain) % 2 === 1 ? "B" : "A";
}

export function assembleDraft(row: OutputRow, cfg: AppConfig): EmailDraft {
  const subject = row.subject ?? `quick idea for ${row.company}`;
  const variant = formatVariantFor(row, cfg);
  const lines: string[] = [];
  const greet = greeting(row.company, seedFrom(row.domain));

  // Personalized hook (the only model-written part). Leads the body either way —
  // the self-intro first would read as mass-mail and bury the reason they'd reply.
  const observation = [row.icebreaker, row.opener]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s))
    .join(" ");
  // Who we are — JUST the studio intro (owner spec 2026-06-24): the offer is the
  // first menu item below, so the email reads as one list, not "offer + menu".
  const intro = (cfg.STUDIO_INTRO ?? "").trim();
  const servicesIntro = cfg.SERVICES_INTRO ?? "A few things we could set up for you:";

  if (variant === "B") {
    // Variant B (A/B): hook on the FIRST line so the inbox PREVIEW shows the hook
    // (not the greeting), a SHORTER menu, and one soft 1:1 CTA instead of the site
    // CTA. Same locked menu source (CLINIC_MENU) — just trimmed; we do NOT re-enable
    // the model-generated menu (it produced weak items — owner decision stands).
    lines.push(observation ? `${greet.replace(/[,\s]+$/, "")} — ${observation}` : greet);
    lines.push("");
    if (intro) {
      lines.push(intro);
      lines.push("");
    }
    const menuB = CLINIC_MENU.slice(0, Math.max(0, cfg.EMAIL_MENU_MAX_B));
    if (cfg.SHOW_SERVICES_MENU && menuB.length > 0) {
      lines.push(servicesIntro);
      for (const s of menuB) lines.push(`• ${s}`);
      lines.push("");
    }
    lines.push((cfg.CALL_TO_ACTION_SOFT ?? "").replace("{company}", shortName(row.company) || "you"));
  } else {
    // Variant A — current owner-locked format, byte-for-byte unchanged.
    lines.push(greet);
    lines.push("");
    if (observation) {
      lines.push(observation);
      lines.push("");
    }
    if (intro) {
      lines.push(intro);
      lines.push("");
    }
    if (cfg.SHOW_SERVICES_MENU && CLINIC_MENU.length > 0) {
      lines.push(servicesIntro);
      for (const s of CLINIC_MENU) lines.push(`• ${s}`);
      lines.push("");
    }
    lines.push((cfg.CALL_TO_ACTION ?? "").replace("{site}", cfg.SITE_URL ?? ""));
  }

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
    `**Fit:** ${row.fit_score ?? "?"} / 5 · **Status:** ${row.status} · **Формат:** ${formatVariantFor(row, cfg)}`,
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
