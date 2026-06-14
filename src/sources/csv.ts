import { readFile } from "node:fs/promises";
import type { Lead } from "../types.js";
import type { LeadsSource } from "./index.js";
import { normalizeDomain } from "./index.js";

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function parseLeadsCsv(text: string): Lead[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  const idx = {
    company: header.indexOf("company"),
    domain: header.indexOf("domain"),
    name: header.indexOf("name"),
    role: header.indexOf("role"),
    linkedin: header.indexOf("linkedin"),
    email: header.indexOf("email"),
  };
  if (idx.company < 0 || idx.domain < 0) {
    throw new Error("Leads CSV must contain at least 'company' and 'domain' columns.");
  }

  const leads: Lead[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]!);
    if (cols.length < header.length) continue;
    const company = (cols[idx.company] ?? "").trim();
    const domain = normalizeDomain(cols[idx.domain] ?? "");
    if (!company || !domain) continue;
    const lead: Lead = { company, domain };
    if (idx.name >= 0) {
      const v = (cols[idx.name] ?? "").trim();
      if (v) lead.name = v;
    }
    if (idx.role >= 0) {
      const v = (cols[idx.role] ?? "").trim();
      if (v) lead.role = v;
    }
    if (idx.linkedin >= 0) {
      const v = (cols[idx.linkedin] ?? "").trim();
      if (v) lead.linkedin = v;
    }
    if (idx.email >= 0) {
      const v = (cols[idx.email] ?? "").trim();
      if (v) lead.email = v;
    }
    leads.push(lead);
  }
  return leads;
}

export class CsvLeadsSource implements LeadsSource {
  constructor(private readonly path: string) {}
  async fetchLeads(): Promise<Lead[]> {
    const text = await readFile(this.path, "utf8");
    return parseLeadsCsv(text);
  }
}
