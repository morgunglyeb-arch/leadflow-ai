import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { google } from "googleapis";
import type { AppConfig } from "./config.js";
import type { OutputRow } from "./types.js";

const CSV_COLUMNS: Array<keyof OutputRow> = [
  "status",
  "company",
  "domain",
  "name",
  "role",
  "linkedin",
  "email",
  "email_source",
  "phone",
  "location",
  "rating",
  "reviews",
  "discovery_source",
  "discovery_query",
  "enriched",
  "enrichment_source",
  "signals",
  "ai_provider",
  "fit_score",
  "brief",
  "subject",
  "opener",
  "icebreaker",
  "process",
  "automation",
  "est_benefit",
  "reason",
];

function csvEscape(v: unknown): string {
  if (v === undefined || v === null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToBody(rows: OutputRow[]): string {
  if (rows.length === 0) return "";
  return (
    rows
      .map((r) => CSV_COLUMNS.map((c) => csvEscape(r[c] as unknown)).join(","))
      .join("\n") + "\n"
  );
}

const UTF8_BOM = "﻿";

export function rowsToCsv(rows: OutputRow[]): string {
  const header = CSV_COLUMNS.join(",") + "\n";
  return UTF8_BOM + header + rowsToBody(rows);
}

export interface ExistingKeys {
  emails: Set<string>;
  domains: Set<string>;
}

export async function loadExistingKeys(path: string): Promise<ExistingKeys> {
  const keys: ExistingKeys = { emails: new Set(), domains: new Set() };
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return keys;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return keys;
  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  const emailIdx = header.indexOf("email");
  const domainIdx = header.indexOf("domain");
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(",");
    if (emailIdx >= 0) {
      const e = (cols[emailIdx] ?? "").trim().toLowerCase();
      if (e) keys.emails.add(e);
    }
    if (domainIdx >= 0) {
      const d = (cols[domainIdx] ?? "").trim().toLowerCase();
      if (d) keys.domains.add(d);
    }
  }
  return keys;
}

export async function writeCsv(path: string, rows: OutputRow[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let exists = false;
  try {
    const s = await stat(path);
    exists = s.size > 0;
  } catch {
    exists = false;
  }
  if (exists) {
    await appendFile(path, rowsToBody(rows), "utf8");
  } else {
    await writeFile(path, rowsToCsv(rows), "utf8");
  }
}

export async function overwriteCsv(path: string, rows: OutputRow[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rowsToCsv(rows), "utf8");
}

export async function appendToSheets(cfg: AppConfig, rows: OutputRow[]): Promise<void> {
  if (!cfg.GOOGLE_SHEETS_ID || !cfg.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error("Sheets output requires GOOGLE_SHEETS_ID and GOOGLE_SERVICE_ACCOUNT_JSON.");
  }
  let creds: { client_email?: string; private_key?: string };
  try {
    creds = JSON.parse(cfg.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (err) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!creds.client_email || !creds.private_key) {
    throw new Error("Service account JSON missing client_email/private_key.");
  }
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const values: string[][] = [
    [...CSV_COLUMNS] as string[],
    ...rows.map((r) => CSV_COLUMNS.map((c) => String(r[c] ?? ""))),
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: cfg.GOOGLE_SHEETS_ID,
    range: cfg.GOOGLE_SHEETS_WRITE_RANGE,
    valueInputOption: "RAW",
    requestBody: { values },
  });
}

export interface EmailResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export async function sendTestEmail(
  cfg: AppConfig,
  row: OutputRow,
): Promise<EmailResult> {
  if (!cfg.RESEND_API_KEY || !cfg.EMAIL_FROM || !cfg.EMAIL_TEST_TO) {
    return { ok: false, error: "Resend / EMAIL_FROM / EMAIL_TEST_TO not configured" };
  }
  const subject = row.subject ?? `LeadFlow test — ${row.company}`;
  const lines = [
    row.name ? `Hi ${row.name.split(" ")[0]},` : `Hi there,`,
    "",
    row.opener ?? "(no opener generated)",
    "",
    row.icebreaker ? row.icebreaker : "",
    "",
    "— Glyeb",
  ].filter((l) => l !== undefined);
  const text = lines.join("\n");
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: cfg.EMAIL_FROM,
        to: cfg.EMAIL_TEST_TO,
        subject: `[LeadFlow test → ${row.company}] ${subject}`,
        text,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) return { ok: false, error: `resend ${res.status}: ${json.message ?? "unknown"}` };
    return { ok: true, id: json.id };
  } catch (err) {
    return { ok: false, error: `network: ${(err as Error).message}` };
  }
}
