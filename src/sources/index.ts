import type { AppConfig } from "../config.js";
import type { Lead } from "../types.js";
import { CsvLeadsSource } from "./csv.js";
import { SheetsLeadsSource } from "./sheets.js";

export interface LeadsSource {
  fetchLeads(): Promise<Lead[]>;
}

export function buildLeadsSource(cfg: AppConfig, csvOverride?: string): LeadsSource {
  if (cfg.LEADS_SOURCE === "sheets") {
    if (!cfg.GOOGLE_SHEETS_ID || !cfg.GOOGLE_SERVICE_ACCOUNT_JSON) {
      throw new Error(
        "LEADS_SOURCE=sheets requires GOOGLE_SHEETS_ID and GOOGLE_SERVICE_ACCOUNT_JSON.",
      );
    }
    return new SheetsLeadsSource(
      cfg.GOOGLE_SHEETS_ID,
      cfg.GOOGLE_SERVICE_ACCOUNT_JSON,
      cfg.GOOGLE_SHEETS_READ_RANGE,
    );
  }
  return new CsvLeadsSource(csvOverride ?? cfg.LEADS_CSV_PATH);
}

export async function fetchLeads(cfg: AppConfig, csvOverride?: string): Promise<Lead[]> {
  return buildLeadsSource(cfg, csvOverride).fetchLeads();
}

export function normalizeDomain(raw: string): string {
  let s = (raw || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.split("/")[0] ?? s;
  s = s.split("?")[0] ?? s;
  return s;
}
