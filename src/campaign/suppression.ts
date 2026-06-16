import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Never-contact list: one domain or email per line (# comments allowed).
 * Opt-outs and hard bounces are appended automatically so we never email them
 * again — protects sender reputation and respects people who said no.
 */
export async function loadSuppression(path: string): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const raw = await readFile(path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const v = line.trim().toLowerCase();
      if (v && !v.startsWith("#")) set.add(v);
    }
  } catch {
    /* no list yet */
  }
  return set;
}

export function isSuppressed(set: Set<string>, domain: string, email?: string): boolean {
  if (set.has(domain.toLowerCase())) return true;
  if (email && set.has(email.toLowerCase())) return true;
  return false;
}

export async function addToSuppression(
  path: string,
  entry: string,
  reason: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${entry.toLowerCase()}  # ${reason} ${new Date().toISOString().slice(0, 10)}\n`, "utf8");
}
