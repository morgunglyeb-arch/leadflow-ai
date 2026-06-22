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
 * Full sendable bodies for the 3-touch sequence (greeting + content + opt-out +
 * signature). Used by the autonomous campaign sender.
 */
export function assembleSequence(row: OutputRow, cfg: AppConfig): EmailSequence {
  const greet = greeting(row.company);
  const sig = `— ${cfg.SENDER_SIGNATURE}`;
  const initialDraft = assembleDraft(row, cfg);
  // append a one-line opt-out to the first touch (compliance + deliverability)
  const initial = `${initialDraft.body}\n\n${cfg.OPT_OUT_TEXT}`;
  const fu = (text: string): string => `${greet}\n\n${text}\n\n${cfg.OPT_OUT_TEXT}\n\n${sig}`;
  return {
    ...(row.email ? { to: row.email } : {}),
    subject: initialDraft.subject,
    initial,
    followup_1: row.followup_1 ? fu(row.followup_1) : "",
    followup_2: row.followup_2 ? fu(row.followup_2) : "",
  };
}

/**
 * Greeting addresses the BUSINESS, not a person — the recipient often isn't the
 * named contact, so a wrong first name hurts. We use a tidy short company name.
 */
function greeting(company: string): string {
  const short = company
    .split(/[-–—|,:]/)[0]
    ?.replace(/\b(ltd|limited|llp|inc|llc)\b\.?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!short || short.length < 2) return "Hello,";
  return `Hi ${short} team,`;
}

function capitalize(s: string): string {
  const t = s.trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function stripTrailingPunct(s: string): string {
  return s.trim().replace(/[.!;,\s]+$/, "");
}

/**
 * Assemble a full, ready-to-review cold email from the AI fields. The pitch
 * (process → automation → benefit) is the body's spine; nothing here invents
 * facts — it only arranges what the model already grounded in the site text.
 */
export function assembleDraft(row: OutputRow, cfg: AppConfig): EmailDraft {
  const subject = row.subject ?? `quick idea for ${row.company}`;
  const lines: string[] = [];
  lines.push(greeting(row.company));
  lines.push("");

  // First touch = ONE idea, led by the most specific personalization we have.
  // Deliberately NO self-intro paragraph, NO bullet "menu", NO inline demo:
  // those read as mass-mail and bury the hook (and trip spam filters). The
  // breadth/menu belongs in a follow-up; the demo is the open loop the CTA
  // promises ("reply and I'll send a short example").
  const observation = [row.icebreaker, row.opener]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s))
    .join(" ");
  if (observation) {
    lines.push(observation);
    lines.push("");
  }

  // One concrete, done-for-you offer line — a single idea, never a list.
  const offer = row.automation
    ? `${capitalize(stripTrailingPunct(row.automation))}.`
    : row.services?.[0]
      ? `${capitalize(stripTrailingPunct(row.services[0]))}.`
      : "";
  if (offer) {
    lines.push(offer);
    lines.push("");
  }

  lines.push(cfg.CALL_TO_ACTION);
  lines.push("");
  lines.push(`— ${cfg.SENDER_SIGNATURE}`);

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

  const greet = greeting(row.company);
  const days = [3, 10];
  const followups = [row.followup_1, row.followup_2]
    .map((f, i) => {
      if (!f) return "";
      return `\n---\n\n**Follow-up ${i + 1}** _(send ~${days[i]} days later if no reply — same thread, subject "Re: ${draft.subject}")_\n\n${greet}\n\n${f}\n\n— ${cfg.SENDER_SIGNATURE}`;
    })
    .join("\n");

  const altSubject = row.subject_b ? `**Subject (B-variant):** ${row.subject_b}\n\n` : "";
  const demoBlock = row.demo
    ? `\n💬 **Example to show them** (drop into a reply or the call): _${row.demo}_\n`
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
