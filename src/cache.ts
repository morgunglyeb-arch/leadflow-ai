import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Enrichment } from "./types.js";

function cachePath(dir: string, domain: string): string {
  return join(dir, `${domain}.json`);
}

export async function loadCachedEnrichment(
  dir: string,
  domain: string,
): Promise<Enrichment | null> {
  try {
    const raw = await readFile(cachePath(dir, domain), "utf8");
    const parsed = JSON.parse(raw) as Enrichment;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveCachedEnrichment(
  dir: string,
  enrichment: Enrichment,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    cachePath(dir, enrichment.domain),
    JSON.stringify(enrichment, null, 2),
    "utf8",
  );
}
