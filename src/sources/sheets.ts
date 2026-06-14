import { google } from "googleapis";
import type { Lead } from "../types.js";
import type { LeadsSource } from "./index.js";
import { parseLeadsCsv } from "./csv.js";

export class SheetsLeadsSource implements LeadsSource {
  constructor(
    private readonly sheetId: string,
    private readonly serviceAccountJson: string,
    private readonly range: string,
  ) {}

  async fetchLeads(): Promise<Lead[]> {
    let creds: { client_email?: string; private_key?: string };
    try {
      creds = JSON.parse(this.serviceAccountJson);
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
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: this.range,
    });

    const values = res.data.values ?? [];
    if (values.length === 0) return [];

    const csv = values
      .map((row) => row.map((c) => csvEscape(String(c ?? ""))).join(","))
      .join("\n");
    return parseLeadsCsv(csv);
  }
}

function csvEscape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
