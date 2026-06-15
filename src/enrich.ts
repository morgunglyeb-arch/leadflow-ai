import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import type { Enrichment } from "./types.js";
import { loadCachedEnrichment, saveCachedEnrichment } from "./cache.js";

const MAX_TEXT_CHARS = 4000;

const SIGNAL_RULES: Array<{ key: string; pattern: RegExp }> = [
  { key: "pricing", pattern: /\b(pricing|plans|subscription)\b/i },
  { key: "careers", pattern: /\b(careers|hiring|we'?re hiring|join (our|the) team)\b/i },
  { key: "blog", pattern: /\b(blog|articles|insights|newsroom)\b/i },
  { key: "ecommerce", pattern: /\b(shop|cart|checkout|add to (cart|bag))\b/i },
  { key: "b2b", pattern: /\b(enterprise|b2b|for (teams|businesses|companies))\b/i },
  { key: "saas", pattern: /\b(saas|platform|dashboard|api|integrations?)\b/i },
  { key: "ai", pattern: /\b(ai|artificial intelligence|machine learning|llm|gpt|agentic)\b/i },
  { key: "agency", pattern: /\b(agency|consultancy|consulting|case stud(y|ies))\b/i },
  { key: "ecommerce_platform", pattern: /\b(shopify|woocommerce|magento|bigcommerce)\b/i },
  { key: "fintech", pattern: /\b(payments?|invoice|accounting|fintech|payroll)\b/i },
  { key: "marketplace", pattern: /\b(marketplace|sellers?|vendors?|two-sided)\b/i },
  { key: "logistics", pattern: /\b(logistics|shipping|fulfilment|warehouse|3pl)\b/i },
  { key: "healthcare", pattern: /\b(clinic|patients?|healthcare|telehealth|ehr)\b/i },
  { key: "education", pattern: /\b(students?|courses?|edtech|learning|curriculum)\b/i },
  { key: "series", pattern: /\bseries [a-d]\b/i },
];

// Channel rules run on RAW HTML — they look for links/attributes (href, tel:,
// social, booking widgets) that get stripped out of the visible body text.
// These tell us WHERE the business talks to customers and HOW they book.
const CHANNEL_RULES: Array<{ key: string; pattern: RegExp }> = [
  { key: "whatsapp", pattern: /(wa\.me|api\.whatsapp|whatsapp)/i },
  { key: "instagram", pattern: /instagram\.com/i },
  { key: "telegram", pattern: /(t\.me\/|telegram\.me|telegram)/i },
  { key: "messenger", pattern: /(m\.me\/|messenger\.com|facebook messenger)/i },
  { key: "phone_booking", pattern: /(tel:|call (us|to book|now)|book by phone|phone to book)/i },
  {
    key: "online_booking",
    pattern:
      /(calendly|acuityscheduling|setmore|simplybook|cliniko|dentally|zenoti|fresha|treatwell|book[- ]?online|online[- ]?booking|booking widget)/i,
  },
  { key: "contact_form", pattern: /(<form|contact[- ]?form|enquiry form|request a callback|get a quote)/i },
  { key: "live_chat", pattern: /(intercom|tawk\.to|livechatinc|drift\.com|crisp\.chat|zendesk)/i },
];

export function detectSignals(text: string): string[] {
  const hits = new Set<string>();
  for (const { key, pattern } of SIGNAL_RULES) {
    if (pattern.test(text)) hits.add(key);
  }
  return [...hits];
}

export function detectChannels(html: string): string[] {
  const hits = new Set<string>();
  for (const { key, pattern } of CHANNEL_RULES) {
    if (pattern.test(html)) hits.add(key);
  }
  return [...hits];
}

function extractTag(html: string, tag: "title"): string | undefined {
  const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m?.[1]?.replace(/\s+/g, " ").trim() || undefined;
}

function extractMetaDescription(html: string): string | undefined {
  const m =
    html.match(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    ) ??
    html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i,
    ) ??
    html.match(
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    );
  return m?.[1]?.trim() || undefined;
}

function extractHeadings(html: string): string[] {
  const out: string[] = [];
  const re = /<h([12])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const txt = stripTags(m[2] ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (txt) out.push(txt);
    if (out.length >= 10) break;
  }
  return out;
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
}

export function htmlToText(html: string): string {
  return stripTags(html)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

interface ParsedSite {
  title?: string;
  description?: string;
  summary_text: string;
  signals: string[];
  emails: string[];
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// Domains/patterns that are never a real contact address.
const EMAIL_NOISE = [
  "example.com",
  "example.org",
  "sentry.io",
  "wixpress.com",
  "wix.com",
  "schema.org",
  "w3.org",
  "domain.com",
  "yourdomain",
  "email.com",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
];
const ROLE_INBOX = /^(info|hello|contact|enquir|enquiries|reception|admin|office|bookings?|appointments?|hi|team|sales|support|mail)@/i;

/** Extract + rank emails from raw HTML (mailto links + body text). */
export function extractEmails(html: string, siteDomain: string): string[] {
  const found = new Set<string>();
  // mailto: links first (most reliable)
  const mailto = html.matchAll(/mailto:([^"'?>\s]+)/gi);
  for (const m of mailto) if (m[1]) found.add(m[1].toLowerCase());
  for (const m of html.matchAll(EMAIL_RE)) found.add(m[0].toLowerCase());

  const root = siteDomain.replace(/^www\./, "");
  const scored: Array<{ email: string; score: number }> = [];
  for (const email of found) {
    if (EMAIL_NOISE.some((n) => email.includes(n))) continue;
    if (email.length > 60) continue;
    const at = email.split("@")[1] ?? "";
    let score = 0;
    if (at === root || at.endsWith(`.${root}`)) score += 5;
    if (ROLE_INBOX.test(email)) score += 2;
    if (/(gmail|outlook|hotmail|yahoo|icloud|proton)\./.test(at)) score += 1;
    scored.push({ email, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .map((s) => s.email)
    .slice(0, 5);
}

function parseSiteHtml(html: string, domain: string): ParsedSite {
  const title = extractTag(html, "title");
  const description = extractMetaDescription(html);
  const headings = extractHeadings(html);
  const bodyText = htmlToText(html);

  const composed = [
    title ? `TITLE: ${title}` : "",
    description ? `DESCRIPTION: ${description}` : "",
    headings.length > 0 ? `HEADINGS: ${headings.join(" | ")}` : "",
    `BODY: ${bodyText}`,
  ]
    .filter(Boolean)
    .join("\n");

  const summary_text = composed.slice(0, MAX_TEXT_CHARS);
  const signals = [
    ...detectSignals(`${title ?? ""} ${description ?? ""} ${bodyText}`),
    ...detectChannels(html),
  ];
  const emails = extractEmails(html, domain);
  return { title, description, summary_text, signals, emails };
}

function parsePlainFixture(text: string): ParsedSite {
  const cleaned = text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
  const signals = [...detectSignals(text), ...detectChannels(text)];
  const firstLine = text.split("\n").map((l) => l.trim()).find(Boolean);
  const emails = extractEmails(text, "");
  return {
    title: firstLine,
    description: undefined,
    summary_text: cleaned,
    signals,
    emails,
  };
}

async function fetchWithTimeout(
  url: string,
  cfg: AppConfig,
): Promise<{ html: string; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.ENRICH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": cfg.ENRICH_USER_AGENT,
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ctype = res.headers.get("content-type") ?? "";
    if (!ctype.includes("html") && !ctype.includes("xml") && ctype !== "") {
      throw new Error(`non-HTML content-type: ${ctype}`);
    }
    const html = await res.text();
    return { html, finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSiteLive(domain: string, cfg: AppConfig): Promise<ParsedSite> {
  // homepage for context + the pages where emails actually live. Privacy pages
  // almost always carry a contact email (GDPR), so they boost the hit-rate.
  const candidates = [
    `https://${domain}`,
    `https://${domain}/about`,
    `https://${domain}/contact`,
    `https://${domain}/contact-us`,
    `https://${domain}/privacy`,
    `https://${domain}/privacy-policy`,
  ];
  // Fetch in parallel; tolerate per-page failures.
  const results = await Promise.allSettled(
    candidates.map((url) => fetchWithTimeout(url, cfg)),
  );
  const collected: ParsedSite[] = [];
  let firstError: Error | undefined;
  for (const r of results) {
    if (r.status === "fulfilled") {
      collected.push(parseSiteHtml(r.value.html, domain));
    } else if (!firstError) {
      firstError = r.reason as Error;
    }
  }
  if (collected.length === 0) {
    throw firstError ?? new Error("fetch failed");
  }
  return mergeParsed(collected, domain);
}

function mergeParsed(parts: ParsedSite[], domain: string): ParsedSite {
  const title = parts.find((p) => p.title)?.title;
  const description = parts.find((p) => p.description)?.description;
  const summary_text = parts
    .map((p) => p.summary_text)
    .join("\n---\n")
    .slice(0, MAX_TEXT_CHARS);
  const signals = [...new Set(parts.flatMap((p) => p.signals))];
  // re-rank the union of emails against the domain
  const allEmails = [...new Set(parts.flatMap((p) => p.emails))];
  const emails = rerankEmails(allEmails, domain);
  return { title, description, summary_text, signals, emails };
}

function rerankEmails(emails: string[], domain: string): string[] {
  const root = domain.replace(/^www\./, "");
  return emails
    .map((email) => {
      const at = email.split("@")[1] ?? "";
      let score = 0;
      if (at === root || at.endsWith(`.${root}`)) score += 5;
      if (ROLE_INBOX.test(email)) score += 2;
      if (/(gmail|outlook|hotmail|yahoo|icloud|proton)\./.test(at)) score += 1;
      return { email, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((s) => s.email)
    .slice(0, 5);
}

async function loadMockFixture(domain: string): Promise<ParsedSite | null> {
  const path = join("data/fixtures", `${domain}.txt`);
  try {
    const text = await readFile(path, "utf8");
    return parsePlainFixture(text);
  } catch {
    return null;
  }
}

export interface EnrichOptions {
  mock: boolean;
  force: boolean;
}

export async function enrichLead(
  domain: string,
  cfg: AppConfig,
  opts: EnrichOptions,
): Promise<Enrichment> {
  const now = new Date().toISOString();

  if (!opts.force) {
    const cached = await loadCachedEnrichment(cfg.ENRICH_CACHE_DIR, domain);
    if (cached) return { ...cached, emails: cached.emails ?? [], source: "cache" };
  }

  if (opts.mock) {
    const fixture = await loadMockFixture(domain);
    if (fixture) {
      const enrichment: Enrichment = {
        domain,
        title: fixture.title,
        description: fixture.description,
        summary_text: fixture.summary_text,
        signals: fixture.signals,
        emails: rerankEmails(fixture.emails, domain),
        ok: true,
        source: "mock",
        fetched_at: now,
      };
      await saveCachedEnrichment(cfg.ENRICH_CACHE_DIR, enrichment);
      return enrichment;
    }
    const enrichment: Enrichment = {
      domain,
      summary_text: "",
      signals: [],
      emails: [],
      ok: false,
      source: "failed",
      fetched_at: now,
      error: `no fixture found for ${domain} (looked in data/fixtures/${domain}.txt)`,
    };
    return enrichment;
  }

  try {
    const parsed = await fetchSiteLive(domain, cfg);
    const enrichment: Enrichment = {
      domain,
      title: parsed.title,
      description: parsed.description,
      summary_text: parsed.summary_text,
      signals: parsed.signals,
      emails: parsed.emails,
      ok: true,
      source: "live",
      fetched_at: now,
    };
    await saveCachedEnrichment(cfg.ENRICH_CACHE_DIR, enrichment);
    return enrichment;
  } catch (err) {
    return {
      domain,
      summary_text: "",
      signals: [],
      emails: [],
      ok: false,
      source: "failed",
      fetched_at: now,
      error: (err as Error).message,
    };
  }
}
