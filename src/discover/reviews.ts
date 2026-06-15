import type { AppConfig } from "../config.js";

interface SerperReview {
  rating?: number;
  snippet?: string;
  date?: string;
}
interface SerperReviewsResponse {
  reviews?: SerperReview[];
}

/**
 * Pull recent Google reviews for a place (by cid) and compress them into a
 * short, real digest the model can mine for genuine pain points, named staff
 * and what customers actually value — the basis for hand-researched copy.
 * Returns undefined if reviews can't be fetched (lead still proceeds).
 */
export async function fetchReviewDigest(
  cid: string,
  cfg: AppConfig,
): Promise<string | undefined> {
  if (!cfg.SERPER_API_KEY) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.ENRICH_TIMEOUT_MS);
  try {
    const res = await fetch("https://google.serper.dev/reviews", {
      method: "POST",
      signal: controller.signal,
      headers: { "X-API-KEY": cfg.SERPER_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ cid, num: 10 }),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as SerperReviewsResponse;
    const reviews = (json.reviews ?? []).filter((r) => r.snippet);
    if (reviews.length === 0) return undefined;

    const lines = reviews
      .slice(0, 8)
      .map((r) => {
        const snip = (r.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 280);
        return `- (${r.rating ?? "?"}★) ${snip}`;
      })
      .join("\n");
    return lines.slice(0, 1800);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
