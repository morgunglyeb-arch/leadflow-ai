import type { AppConfig } from "../config.js";

interface SerperReview {
  rating?: number;
  snippet?: string;
  date?: string;
}
interface SerperReviewsResponse {
  reviews?: SerperReview[];
}

async function fetchReviews(
  cid: string,
  cfg: AppConfig,
  sortBy?: string,
): Promise<SerperReview[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.ENRICH_TIMEOUT_MS);
  try {
    const res = await fetch("https://google.serper.dev/reviews", {
      method: "POST",
      signal: controller.signal,
      headers: { "X-API-KEY": cfg.SERPER_API_KEY!, "content-type": "application/json" },
      body: JSON.stringify({ cid, num: 10, ...(sortBy ? { sortBy } : {}) }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as SerperReviewsResponse;
    return (json.reviews ?? []).filter((r) => r.snippet);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function clean(s: string, n: number): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}

/**
 * Pull both the best AND the worst Google reviews for a place (by cid). The
 * low-rated ones surface the REAL customer pain ("couldn't get through on the
 * phone", "no one replied") that makes copy hit hard; the top ones show what
 * they're known for. Returns undefined if nothing usable.
 */
export async function fetchReviewDigest(
  cid: string,
  cfg: AppConfig,
): Promise<string | undefined> {
  if (!cfg.SERPER_API_KEY) return undefined;
  const [best, worst] = await Promise.all([
    fetchReviews(cid, cfg),
    fetchReviews(cid, cfg, "ratingLow"),
  ]);
  if (best.length === 0 && worst.length === 0) return undefined;

  const complaints = worst
    .filter((r) => (r.rating ?? 5) <= 3)
    .slice(0, 4)
    .map((r) => `- COMPLAINT (${r.rating}★): ${clean(r.snippet!, 280)}`);
  const positives = best
    .slice(0, 4)
    .map((r) => `- (${r.rating ?? "?"}★): ${clean(r.snippet!, 220)}`);

  return [...complaints, ...positives].join("\n").slice(0, 2000);
}
