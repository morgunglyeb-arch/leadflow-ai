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
 * Approximate how many months ago a review was left, from Google's relative
 * date strings ("a year ago", "3 months ago", "2 weeks ago") or an ISO date.
 * Returns undefined if it can't be parsed. Used to judge review RECENCY so we
 * don't build the pitch on stale, no-longer-relevant complaints.
 */
function monthsAgo(date?: string): number | undefined {
  if (!date) return undefined;
  const s = date.toLowerCase().trim();
  const iso = Date.parse(s);
  if (!Number.isNaN(iso)) {
    return Math.max(0, (Date.now() - iso) / (1000 * 60 * 60 * 24 * 30.4));
  }
  const m = s.match(/(a|an|\d+)\s*(day|week|month|year)s?\s*ago/);
  if (!m) return undefined;
  const n = m[1] === "a" || m[1] === "an" ? 1 : Number.parseInt(m[1]!, 10);
  const per: Record<string, number> = { day: 1 / 30.4, week: 7 / 30.4, month: 1, year: 12 };
  return n * (per[m[2]!] ?? 1);
}

// Reviews older than this are considered stale: useful as background, but NOT a
// reliable signal of a CURRENT problem to anchor the cold email on.
const STALE_MONTHS = 18;

function recencyTag(date?: string): string {
  const m = monthsAgo(date);
  if (m === undefined) return date ? ` [${clean(date, 20)}]` : "";
  if (m <= STALE_MONTHS) return ` [recent: ~${Math.round(m)}mo ago]`;
  return ` [OLD: ~${Math.round(m / 12)}y ago — may be outdated]`;
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

  // Surface recent complaints first; tag each with how old it is so the model
  // anchors the pitch on a CURRENT problem and treats old ones with caution.
  const sortedWorst = worst
    .filter((r) => (r.rating ?? 5) <= 3)
    .sort((a, b) => (monthsAgo(a.date) ?? 999) - (monthsAgo(b.date) ?? 999))
    .slice(0, 4);
  const complaints = sortedWorst.map(
    (r) => `- COMPLAINT (${r.rating}★)${recencyTag(r.date)}: ${clean(r.snippet!, 280)}`,
  );
  const positives = best
    .slice(0, 4)
    .map((r) => `- (${r.rating ?? "?"}★)${recencyTag(r.date)}: ${clean(r.snippet!, 220)}`);

  const recentComplaints = sortedWorst.filter((r) => (monthsAgo(r.date) ?? 999) <= STALE_MONTHS);
  const note =
    complaints.length > 0 && recentComplaints.length === 0
      ? ["NOTE: the complaints below are all OLD (>18mo) — likely already fixed; do NOT assume they are a current problem."]
      : [];

  return [...note, ...complaints, ...positives].join("\n").slice(0, 2000);
}
