import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import type { Enrichment } from "./types.js";
import { loadCachedEnrichment, saveCachedEnrichment } from "./cache.js";
import { normalizeDomain } from "./sources/index.js";
import FirecrawlApp from "@mendable/firecrawl-js";

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
  // buy-signals: motivated to fix ops
  { key: "hiring_reception", pattern: /\b(receptionist|front desk|front of house|reception team|call handler)\b/i },
  { key: "expanding", pattern: /\b(we'?re expanding|now open|new (branch|clinic|location)|grand opening|opening soon)\b/i },
  // ICP POSITIVE — explicit owner-run / independent / established language. A
  // strong "small independent, owner at the helm" marker → rewarded in roiScore.
  {
    key: "owner_run",
    pattern:
      /(family[- ](?:run|owned)|husband (?:and|&) wife|independent(?:ly[- ]owned)? (?:practice|clinic|dental|surgery|firm|agency|business|tradesperson|builder)|locally[- ]owned|owner[- ]run|established (?:in )?(?:18|19|20)\d{2}|founded (?:in )?(?:18|19|20)\d{2}|since (?:18|19|20)\d{2}|[\w'-]+ (?:&|and) sons|[A-Z][\w'-]+'s (?:plumbing|electrical|electric|roofing|heating|building|cleaning|gardening|landscaping|joinery)|Dr\.? [A-Z][\w'-]+'s (?:practice|clinic|surgery|dental))/i,
  },
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
  // --- ALREADY-AUTOMATED markers: things WE sell that they already run, so we
  //     don't pitch what they have. These are the de-prioritizers for our ICP
  //     (small businesses NOT yet automated). ---
  // An AI/booking chat widget on the site (e.g. DenGro, ManyChat, Landbot,
  // Tidio, Chatbase, Voiceflow) = they already have a chat assistant.
  {
    key: "has_chatbot",
    pattern:
      /(dengro|manychat|landbot|tidio|chatbase|voiceflow|botpress|smartsupp|chatfuel|leadbot|\bchatbot\b|ai assistant|virtual assistant|chat (?:with|to) (?:us|our team))/i,
  },
  // Automated review collection / reputation tools.
  {
    key: "has_review_tool",
    pattern: /(birdeye|podium|nicejob|reviews\.io|reputation\.com|trustpilot\.com\/review|yotpo|reviewsio)/i,
  },
  // A real CRM / marketing-automation stack = they already automate follow-up.
  {
    key: "has_crm",
    pattern: /(hubspot|salesforce|pipedrive|zoho|gohighlevel|go high level|keap|infusionsoft|activecampaign|klaviyo|mailchimp)/i,
  },
  // Automated SMS/missed-call text-back already in place.
  { key: "has_textback", pattern: /(textback|text[- ]?back|missed[- ]?call (?:text|sms)|whatsapp business api)/i },
  // they PAY for leads (ad pixels) → missed-enquiry follow-up has obvious ROI
  { key: "runs_google_ads", pattern: /(googleadservices|gtag\/js|aw-\d{6,}|gclid)/i },
  { key: "runs_meta_ads", pattern: /(connect\.facebook\.net|fbq\(|facebook pixel|fbevents\.js)/i },
  // targeting de-prioritizers: DIY site (no budget) / chain (procurement)
  { key: "diy_site", pattern: /(wix\.com|wixsite|squarespace|weebly|godaddy|\.wordpress\.com)/i },
  { key: "multi_location", pattern: /(our locations|our clinics|our branches|find your nearest|locations across|nationwide|branches across)/i },
  // STRONG size marker → a franchise/chain won't let a cold email reach the
  // owner (gatekept) and procurement kills the sale. Hard-excluded downstream;
  // distinct from the softer `multi_location`. (ICP: small independent only.)
  {
    key: "franchise",
    pattern:
      /(franchise|franchising opportunit|part of (?:the )?[\w'&-]+ (?:group|family|network)|a member of the [\w'&-]+ group|nationwide network|our network of|offices across the uk|find your (?:nearest|local) (?:branch|office)|(?:branches|offices|agents) (?:nationwide|across the country)|(?:clinics|practices|centres|surgeries|branches|offices) (?:nationwide|across the country)|(?:[3-9]|\d{2,})\+? (?:locations|clinics|branches|offices|practices|surgeries|stores)|(?:clinics|practices|branches|offices) across the uk)/i,
  },
  // DM-bot footprint: an Instagram/Messenger auto-responder is already in place,
  // so don't pitch a chat assistant for THAT channel — pitch what it doesn't
  // cover (missed phone calls, reactivation, reviews). Honest heuristic: a
  // social DM bot is only inferable from footprints, never 100% certain.
  {
    key: "social_bot",
    pattern:
      /(m\.me\/[\w.]+\?ref=|powered by manychat|messenger bot|instagram automation|auto[- ]?reply (?:on |in )?(?:instagram|messenger|whatsapp)|typically replies (?:instantly|in minutes|within minutes))/i,
  },
];

// A real UK postcode (outward + inward), e.g. "W1G 8YP", "WD6 3BS".
const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi;
// Enumerated site markers, e.g. "Location 2", "Location 3", "Branch 4".
const SITE_MARKER = /\b(?:location|branch|clinic|site)\s*([2-9])\b/gi;

/**
 * A MULTI-SITE network (3+ locations) — beyond our ICP. Owner rule: small AND
 * MEDIUM independents are fine (1–2 sites), but a 3+ site chain gatekeeps the
 * owner (generic "office@", procurement, affiliate partners) so the cold email
 * never reaches a decision-maker. Detected two ways, either is sufficient:
 *   - an enumerated "Location/Branch 3+" marker (implies ≥3 sites), or
 *   - 3+ DISTINCT full UK postcodes on the site (separate physical premises).
 * Threshold is 3 on purpose — 2-site medium businesses still qualify.
 */
export function detectMultiSite(text: string): boolean {
  let maxSite = 0;
  for (const m of text.matchAll(SITE_MARKER)) maxSite = Math.max(maxSite, Number(m[1]));
  if (maxSite >= 3) return true;
  const codes = new Set(
    [...text.matchAll(UK_POSTCODE)].map((m) => m[0].toUpperCase().replace(/\s+/g, "")),
  );
  return codes.size >= 3;
}

const DAY_NUM: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * Which weekdays the business is OPEN, parsed from its own site (owner rule:
 * send on the business's working days — "Google Maps lies", read the website).
 * Returns a comma-list of weekday numbers (0=Sun..6=Sat), or "" when unclear so
 * the sender falls back to the global SEND_DAYS. Heuristic, range-first then
 * per-day; a weekend-working clinic (e.g. "Monday – Sunday 8am-7pm") → all 7.
 */
export function detectWorkingDays(text: string): string {
  const t = (text || "").toLowerCase();
  if (!t) return "";
  if (
    /\b(7 days a week|seven days a week|open (?:7|seven) days|open daily|every day|mon(?:day)?\s*[-–—]+\s*sun(?:day)?|monday\s+to\s+sunday)\b/.test(
      t,
    )
  )
    return "0,1,2,3,4,5,6";
  if (/\bmon(?:day)?\s*(?:[-–—]+|\s+to\s+)\s*sat(?:urday)?\b/.test(t)) return "1,2,3,4,5,6";
  if (/\bmon(?:day)?\s*(?:[-–—]+|\s+to\s+)\s*fri(?:day)?\b|\bweekdays?\b/.test(t)) return "1,2,3,4,5";
  // Per-day: a day name followed (within ~30 chars) by an opening time, not "closed".
  const days = new Set<number>();
  for (const [name, n] of Object.entries(DAY_NUM)) {
    const open = new RegExp(`\\b${name}\\w*\\b[^\\n]{0,30}?\\d{1,2}\\s*(?:am|pm|[:.]\\d{2})`, "i");
    const closed = new RegExp(`\\b${name}\\w*\\b[^\\n]{0,15}?closed`, "i");
    if (open.test(t) && !closed.test(t)) days.add(n);
  }
  return days.size >= 2 ? [...days].sort((a, b) => a - b).join(",") : "";
}

export function detectSignals(text: string): string[] {
  const hits = new Set<string>();
  for (const { key, pattern } of SIGNAL_RULES) {
    if (pattern.test(text)) hits.add(key);
  }
  if (detectMultiSite(text)) hits.add("multi_site");
  return [...hits];
}

export function detectChannels(html: string): string[] {
  const hits = new Set<string>();
  for (const { key, pattern } of CHANNEL_RULES) {
    if (pattern.test(html)) hits.add(key);
  }
  return [...hits];
}

// Signals that mean a capability WE sell is ALREADY in place → don't pitch it.
const ALREADY_AUTOMATED: Record<string, string> = {
  has_chatbot: "a website chat assistant / chatbot",
  online_booking: "online self-booking",
  has_review_tool: "automated review collection",
  has_crm: "a CRM / marketing-automation tool",
  has_textback: "missed-call text-back / auto-SMS",
  live_chat: "a live-chat widget",
  social_bot: "an auto-responder in their social DMs (Instagram/Messenger)",
};

/**
 * From detected signals, list the automations the business ALREADY has, in plain
 * words. The model must NOT re-pitch these; many of these present at once also
 * means they're past our ICP (small, not-yet-automated) → lower the fit.
 */
export function existingAutomations(signals: string[]): string[] {
  const set = new Set(signals);
  const out: string[] = [];
  for (const [key, label] of Object.entries(ALREADY_AUTOMATED)) {
    if (set.has(key)) out.push(label);
  }
  return out;
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

/** True if this is a generic/desk mailbox (info@, reception@) rather than a named
 * person. Role inboxes are read by staff who treat cold mail as ads → ignore or
 * report-spam → tank the sender domain's reputation; a named/personal inbox lands
 * on the decision-maker. So we now RANK PERSONAL ABOVE ROLE everywhere
 * (owner-reachability), reversing the old "generic-first for SMB" assumption. */
export function isRoleInbox(email: string): boolean {
  return ROLE_INBOX.test(email);
}

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
    if (ROLE_INBOX.test(email)) score -= 2; // sink role/desk inboxes below a named one
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

// Internal pages worth reading, by priority — services/pricing/booking reveal
// what they sell and how they take bookings; contact/privacy carry emails.
const LINK_KEYWORDS: Array<{ re: RegExp; score: number }> = [
  { re: /(services|treatments|what-we-do|procedures)/i, score: 5 },
  { re: /(prices?|pricing|fees?|cost)/i, score: 5 },
  { re: /(book|booking|appointment|appointments|consultation)/i, score: 5 },
  { re: /(contact|contact-us|get-in-touch)/i, score: 4 },
  { re: /(about|about-us|team|our-team|staff|practice)/i, score: 3 },
  { re: /(reviews?|testimonials?)/i, score: 3 },
  { re: /(faqs?|faq)/i, score: 2 },
  { re: /(privacy|privacy-policy)/i, score: 2 },
];

/** Pull same-site internal links from the homepage, ranked by relevance. */
function extractInternalLinks(html: string, domain: string): string[] {
  const root = domain.replace(/^www\./, "");
  const scored = new Map<string, number>();
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let href = (m[1] ?? "").trim();
    const anchor = stripTags(m[2] ?? "");
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:")) continue;

    // normalize to an absolute https URL on the same domain
    let url: string;
    if (href.startsWith("http")) {
      const d = normalizeDomain(href);
      if (d !== root && !d.endsWith(`.${root}`)) continue;
      url = href.replace(/^http:/, "https:");
    } else {
      if (!href.startsWith("/")) href = `/${href}`;
      url = `https://${domain}${href}`;
    }
    url = url.split("?")[0]!.replace(/\/$/, "");
    if (url === `https://${domain}`) continue;

    const hay = `${href} ${anchor}`;
    let score = 0;
    for (const { re: kre, score: s } of LINK_KEYWORDS) if (kre.test(hay)) score = Math.max(score, s);
    if (score === 0) continue;
    scored.set(url, Math.max(scored.get(url) ?? 0, score));
  }
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([u]) => u)
    .slice(0, 6);
}

const MAX_PAGES = 7;

async function fetchSiteLive(domain: string, cfg: AppConfig): Promise<ParsedSite> {
  // 1) homepage first — it tells us which internal pages actually exist.
  const home = await fetchWithTimeout(`https://${domain}`, cfg);
  const collected: ParsedSite[] = [parseSiteHtml(home.html, domain)];

  // 2) follow the homepage's real high-value links (services, pricing, book,
  //    contact, reviews…), plus a privacy guess for email coverage.
  const links = extractInternalLinks(home.html, domain);
  if (!links.some((u) => /privacy/i.test(u))) links.push(`https://${domain}/privacy-policy`);
  const toFetch = links.slice(0, MAX_PAGES - 1);

  const results = await Promise.allSettled(toFetch.map((url) => fetchWithTimeout(url, cfg)));
  for (const r of results) {
    if (r.status === "fulfilled") collected.push(parseSiteHtml(r.value.html, domain));
  }
  return mergeParsed(collected, domain);
}

const MERGED_TEXT_CHARS = 6500;
const PER_PAGE_CHARS = 1600;

function mergeParsed(parts: ParsedSite[], domain: string): ParsedSite {
  const title = parts.find((p) => p.title)?.title;
  const description = parts.find((p) => p.description)?.description;
  // Give every crawled page a slice (homepage gets more), so services/pricing/
  // booking pages actually reach the model instead of being truncated away.
  let budget = MERGED_TEXT_CHARS;
  const chunks: string[] = [];
  parts.forEach((p, i) => {
    if (budget <= 0) return;
    const cap = i === 0 ? PER_PAGE_CHARS * 2 : PER_PAGE_CHARS;
    const slice = p.summary_text.slice(0, Math.min(cap, budget));
    if (slice.trim()) {
      chunks.push(slice);
      budget -= slice.length;
    }
  });
  const summary_text = chunks.join("\n---\n");
  const signals = [...new Set(parts.flatMap((p) => p.signals))];
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
      if (ROLE_INBOX.test(email)) score -= 2; // sink role/desk inboxes below a named one
      if (/(gmail|outlook|hotmail|yahoo|icloud|proton)\./.test(at)) score += 1;
      return { email, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((s) => s.email)
    .slice(0, 5);
}

// ---------------------------------------------------------------------------
// Firecrawl enrichment — JS-rendering, anti-bot bypass, clean markdown output.
// Used when FIRECRAWL_API_KEY is set (or keyless mode for basic scrape).
// Falls back to the built-in HTTP crawler on any error.
// ---------------------------------------------------------------------------

let firecrawlClient: InstanceType<typeof FirecrawlApp> | null = null;

function getFirecrawl(cfg: AppConfig): InstanceType<typeof FirecrawlApp> | null {
  if (!cfg.FIRECRAWL_API_KEY) return null;
  if (firecrawlClient) return firecrawlClient;
  firecrawlClient = new FirecrawlApp({ apiKey: cfg.FIRECRAWL_API_KEY });
  return firecrawlClient;
}

async function fetchSiteFirecrawl(domain: string, cfg: AppConfig): Promise<ParsedSite | null> {
  const fc = getFirecrawl(cfg);
  if (!fc) return null;

  try {
    // Crawl homepage + up to 6 internal pages (same as our built-in crawler).
    // Returns clean markdown per page — much better for LLM than raw HTML.
    const result = await fc.crawlUrl(`https://${domain}`, {
      limit: MAX_PAGES,
      scrapeOptions: {
        formats: ["markdown" as const, "html" as const],
      },
    });

    if (!result || result.status === "failed" || result.status === "cancelled" || !result.data?.length) return null;

    const collected: ParsedSite[] = [];
    const allEmails: string[] = [];

    for (const page of result.data) {
      const html = page.html ?? "";
      const markdown = page.markdown ?? "";
      const title = page.metadata?.title;
      const description = page.metadata?.description;

      // Use markdown for summary (cleaner for LLM), HTML for signal/email detection
      const signals = [
        ...detectSignals(markdown || htmlToText(html)),
        ...detectChannels(html),
      ];
      const emails = extractEmails(html, domain);
      allEmails.push(...emails);

      const summary_text = markdown
        ? markdown.slice(0, PER_PAGE_CHARS)
        : htmlToText(html).slice(0, PER_PAGE_CHARS);

      collected.push({ title, description, summary_text, signals, emails });
    }

    // Merge all pages
    const title = collected.find((p) => p.title)?.title;
    const description = collected.find((p) => p.description)?.description;
    let budget = MERGED_TEXT_CHARS;
    const chunks: string[] = [];
    collected.forEach((p, i) => {
      if (budget <= 0) return;
      const cap = i === 0 ? PER_PAGE_CHARS * 2 : PER_PAGE_CHARS;
      const slice = p.summary_text.slice(0, Math.min(cap, budget));
      if (slice.trim()) {
        chunks.push(slice);
        budget -= slice.length;
      }
    });

    const summary_text = chunks.join("\n---\n");
    const signals = [...new Set(collected.flatMap((p) => p.signals))];
    const emails = rerankEmails([...new Set(allEmails)], domain);

    console.log(`[firecrawl] ${domain}: ${result.data.length} pages, ${emails.length} emails, ${signals.length} signals`);
    return { title, description, summary_text, signals, emails };
  } catch (err) {
    console.warn(`[firecrawl] ${domain} failed: ${(err as Error).message} — falling back to HTTP`);
    return null;
  }
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
    // Try Firecrawl first (JS rendering, anti-bot, clean markdown).
    // Falls back to built-in HTTP crawler on any error or if not configured.
    let parsed: ParsedSite | null = null;
    let source: "firecrawl" | "live" = "live";

    parsed = await fetchSiteFirecrawl(domain, cfg);
    if (parsed) {
      source = "firecrawl";
    } else {
      parsed = await fetchSiteLive(domain, cfg);
    }

    const enrichment: Enrichment = {
      domain,
      title: parsed.title,
      description: parsed.description,
      summary_text: parsed.summary_text,
      signals: parsed.signals,
      emails: parsed.emails,
      ok: true,
      source,
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
