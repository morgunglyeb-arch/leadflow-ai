/**
 * Lightweight web search for business fact-checking and news discovery.
 * Uses DuckDuckGo Instant Answer API (free, no key, no signup).
 *
 * Adds context to personalization: recent events, awards, expansions,
 * complaints — things our site crawler doesn't catch.
 */

export interface SearchSnippet {
  title: string;
  snippet: string;
  url: string;
}

const DDG_URL = "https://api.duckduckgo.com/";

interface DDGRelatedTopic {
  Text?: string;
  FirstURL?: string;
}
interface DDGResponse {
  Abstract?: string;
  AbstractText?: string;
  AbstractSource?: string;
  AbstractURL?: string;
  RelatedTopics?: DDGRelatedTopic[];
  Results?: DDGRelatedTopic[];
}

/**
 * Search DuckDuckGo Instant Answer API for a business. Returns a short
 * abstract + related topics that can be injected into the LLM prompt for
 * better personalization (recent news, awards, expansions, etc.).
 *
 * Returns empty string if nothing useful found — this is supplementary data,
 * never blocks the pipeline.
 */
export async function searchBusinessContext(
  companyName: string,
  domain: string,
): Promise<string> {
  try {
    const query = `${companyName} ${domain} London`;
    const url = `${DDG_URL}?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) return "";

    const json = (await res.json()) as DDGResponse;

    const parts: string[] = [];

    // Abstract (e.g. from Wikipedia)
    if (json.AbstractText && json.AbstractText.length > 30) {
      parts.push(`About: ${json.AbstractText.slice(0, 300)}`);
    }

    // Related topics — often contain recent/relevant info
    const topics = [...(json.RelatedTopics ?? []), ...(json.Results ?? [])];
    for (const t of topics.slice(0, 3)) {
      if (t.Text && t.Text.length > 20) {
        parts.push(t.Text.slice(0, 200));
      }
    }

    if (parts.length === 0) return "";

    const result = parts.join("\n").slice(0, 600);
    return result;
  } catch {
    // Never block the pipeline — web search is optional enrichment
    return "";
  }
}

/**
 * Search for recent news/events about a business using DuckDuckGo lite HTML.
 * This is a scraping fallback when the Instant Answer API doesn't return
 * useful results. Returns a few snippets of text.
 */
export async function searchBusinessNews(
  companyName: string,
  domain: string,
): Promise<string> {
  try {
    const query = `"${companyName}" OR "${domain}" news opening award`;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "LeadFlowAI/1.0 (research)" },
    });
    clearTimeout(timer);

    if (!res.ok) return "";

    const html = await res.text();

    // Extract result snippets from DDG HTML results page
    const snippets: string[] = [];
    const re = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && snippets.length < 3) {
      const text = (m[1] ?? "")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (text.length > 30) snippets.push(text.slice(0, 200));
    }

    if (snippets.length === 0) return "";
    return `Recent mentions:\n${snippets.join("\n")}`.slice(0, 500);
  } catch {
    return "";
  }
}
