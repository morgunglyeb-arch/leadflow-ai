import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config.js";
import type { OutputRow } from "./types.js";

export interface EmailDraft {
  to?: string;
  subject: string;
  body: string;
}

function firstName(name?: string): string {
  if (!name) return "there";
  return name.trim().split(/\s+/)[0] ?? "there";
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
  lines.push(`Hi ${firstName(row.name)},`);
  lines.push("");
  if (row.opener) lines.push(row.opener);

  const hasProcess = Boolean(
    row.process && row.process.trim().toLowerCase() !== "unclear from site",
  );
  if (hasProcess && row.automation) {
    lines.push("");
    lines.push(`${capitalize(stripTrailingPunct(row.process!))}.`);
    lines.push(
      `${capitalize(stripTrailingPunct(row.automation))}` +
        (row.est_benefit ? ` — ${stripTrailingPunct(row.est_benefit)}.` : "."),
    );
  } else if (row.automation) {
    lines.push("");
    lines.push(`${capitalize(stripTrailingPunct(row.automation))}.`);
  }

  lines.push("");
  lines.push(cfg.CALL_TO_ACTION);
  lines.push("");
  lines.push(`— ${cfg.SENDER_SIGNATURE}`);

  return {
    ...(row.email ? { to: row.email } : {}),
    subject,
    body: lines.join("\n"),
  };
}

function draftMarkdown(row: OutputRow, draft: EmailDraft): string {
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

  return `# Draft — ${row.company}

${meta}
${briefBlock}
---

**Subject:** ${draft.subject}

${draft.body}
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
    await writeFile(path, draftMarkdown(row, draft), "utf8");
  }

  const header = DRAFT_CSV_COLUMNS.join(",");
  const body = rows
    .map((r) => DRAFT_CSV_COLUMNS.map((c) => csvEscape(r[c as keyof OutputRow])).join(","))
    .join("\n");
  await mkdir(dirname(cfg.DRAFTS_CSV_PATH), { recursive: true });
  await writeFile(cfg.DRAFTS_CSV_PATH, "﻿" + header + "\n" + body + "\n", "utf8");

  return { count: rows.length, dir: cfg.DRAFTS_DIR, csv: cfg.DRAFTS_CSV_PATH };
}
