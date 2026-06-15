import { readFile } from "node:fs/promises";
import { z } from "zod";

export const IcpMarket = z.enum(["local_smb", "ecommerce", "agency", "b2b_saas"]);
export type IcpMarket = z.infer<typeof IcpMarket>;

const IcpSegmentSchema = z.object({
  market: IcpMarket,
  queries: z.array(z.string().min(2)).min(1),
});

export const IcpConfigSchema = z.object({
  location: z.string().default(""),
  segments: z.array(IcpSegmentSchema).min(1),
  max_leads: z.number().int().positive().optional(),
  // free-text note injected into the pitch prompt for extra targeting context
  note: z.string().optional(),
});

export type IcpConfig = z.infer<typeof IcpConfigSchema>;
export type IcpSegment = z.infer<typeof IcpSegmentSchema>;

export interface ExpandedQuery {
  market: IcpMarket;
  query: string; // raw query (vertical / niche)
  full: string; // query with location appended, ready for search/maps
}

export async function loadIcpConfig(path: string): Promise<IcpConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `ICP config not found at ${path}. Copy config/icp.example.json → ${path} and edit it.`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`ICP config at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = IcpConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `ICP config at ${path} is invalid: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`,
    );
  }
  return parsed.data;
}

export function expandQueries(icp: IcpConfig): ExpandedQuery[] {
  const out: ExpandedQuery[] = [];
  for (const seg of icp.segments) {
    for (const q of seg.queries) {
      const full = icp.location ? `${q} in ${icp.location}` : q;
      out.push({ market: seg.market, query: q, full });
    }
  }
  return out;
}

export function querySlug(full: string): string {
  return full
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
