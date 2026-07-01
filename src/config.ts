import { config as loadEnv } from "dotenv";
import { z } from "zod";

// `.env` is the app's source of truth — override any vars the surrounding
// shell may have preset (e.g. an empty ANTHROPIC_API_KEY) so config is honored.
loadEnv({ override: true });

const schema = z.object({
  // "anthropic" | "groq" | "openai" (any OpenAI-compatible endpoint:
  // Gemini, Cerebras, OpenRouter, Together, GitHub Models, OpenAI itself…)
  // Default is the FREE OpenAI-compatible provider (Gemini), never "anthropic":
  // Anthropic costs money and is owner's-call-only (it's deliberately excluded
  // from the free fallback chain — ai.ts). Defaulting to "anthropic" was a latent
  // foot-gun — if .env ever lost LLM_PROVIDER, runs would silently bill Anthropic.
  LLM_PROVIDER: z.enum(["anthropic", "groq", "openai"]).default("openai"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
  GROQ_API_KEY: z.string().optional(),
  // Multiple free Groq keys (comma/space separated) to ROTATE across on 429 —
  // same trick as OPENAI_API_KEYS. Falls back to the single GROQ_API_KEY.
  GROQ_API_KEYS: z.string().optional(),
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),

  // Generic OpenAI-compatible provider (used when LLM_PROVIDER=openai)
  // OPENAI_API_KEYS: optional comma/space-separated list, rotated with failover
  // on 429 so a single exhausted key never stalls the run (see src/ai.ts).
  OPENAI_API_KEYS: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z
    .string()
    .default("https://generativelanguage.googleapis.com/v1beta/openai/"),
  OPENAI_MODEL: z.string().default("gemini-2.0-flash"),

  // OpenRouter — a 3rd free fallback in the chain (one key → many free models).
  // Used automatically when Gemini hits its daily quota and Groq is down. Keys
  // look like `sk-or-v1-…`; OPENROUTER_API_KEYS rotates several. Pick any free
  // model (suffix `:free`) that supports JSON output.
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_API_KEYS: z.string().optional(),
  OPENROUTER_MODEL: z.string().default("openai/gpt-oss-120b:free"),

  // Retry transient 429s (rate limits) before giving up to fallback
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  // Gentle global pacing between LLM calls (ms). On the FREE tier (a handful of
  // keys, each ~20 req/min) a burst trips the per-minute limit and cascades to
  // the fallback; a small inter-call gap keeps total rate under the combined
  // limit so generation stays on the primary model. 0 = off (paid/uncapped).
  LLM_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(0),

  // Second LLM pass that reviews each draft against a rubric (right money
  // channel? worth their money? concise? grounded?) and rewrites weak ones.
  SELF_CRITIQUE: z
    .string()
    .default("true")
    .transform((s) => s.toLowerCase() !== "false"),

  OUR_OFFER: z
    .string()
    .default(
      "AI automation for businesses: we set up systems that handle the manual work for them — missed-call text-back, lead capture and follow-up, reporting, customer triage.",
    ),

  // Language of the cold email sent TO the prospect (their language).
  OUTREACH_LANG: z.enum(["en", "uk", "ru"]).default("en"),
  // Language of the per-lead brief shown to YOU (problem + what to automate).
  DIGEST_LANG: z.enum(["ru", "uk", "en"]).default("ru"),

  LEADS_SOURCE: z.enum(["csv", "sheets"]).default("csv"),
  LEADS_CSV_PATH: z.string().default("data/leads.csv"),
  GOOGLE_SHEETS_ID: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_SHEETS_READ_RANGE: z.string().default("leads!A1:F"),
  GOOGLE_SHEETS_WRITE_RANGE: z.string().default("leads_out!A1"),

  // --- Discovery (prospecting) ---------------------------------------------
  // Which discoverer to use when sourcing new leads. "csv" reuses LEADS_SOURCE.
  DISCOVERY_SOURCE: z.enum(["search", "maps", "vibe", "seed", "csv"]).default("search"),
  ICP_CONFIG_PATH: z.string().default("config/icp.json"),
  MAX_LEADS: z.coerce.number().int().positive().default(50),
  // Only keep leads at/above this fit score (1-5). The operator wants strong
  // leads only — default 4 ("strictly 4 and above").
  MIN_FIT: z.coerce.number().int().min(1).max(5).default(4),
  // Review-count band (Google reviews). Too FEW = no real patient volume / weak
  // social proof ("5-star from 4 reviews" reads thin); too MANY = a large
  // operation past our ICP. Only applied when the review count is known.
  REVIEWS_MIN: z.coerce.number().int().min(0).default(20),
  REVIEWS_MAX: z.coerce.number().int().positive().default(1000),

  // Qualification: only keep leads worth selling automation to.
  REQUIRE_EMAIL: z
    .string()
    .default("true")
    .transform((s) => s.toLowerCase() !== "false"),
  REQUIRE_AUTOMATION: z
    .string()
    .default("true")
    .transform((s) => s.toLowerCase() !== "false"),
  // Discover up to MAX_LEADS * OVERFETCH candidates to fill the quota after
  // dropping leads with no email / no automation gap.
  OVERFETCH: z.coerce.number().min(1).max(10).default(4),

  // Email verification before sending (fewer bounces, protects reputation).
  // Free MX-record check by default; deeper check if ZEROBOUNCE_API_KEY is set.
  EMAIL_VERIFY: z
    .string()
    .default("true")
    .transform((s) => s.toLowerCase() !== "false"),
  ZEROBOUNCE_API_KEY: z.string().optional(),
  // Optional rotation list (any separator) — ZeroBounce free tier is 100
  // verifications/key, so several keys multiply the verification budget.
  ZEROBOUNCE_API_KEYS: z.string().optional(),
  // MyEmailVerifier — free tier 100 verifications/DAY/key with API access; the
  // highest-volume free verifier, so it leads the verify chain. Singular + rotation.
  MYEMAILVERIFIER_API_KEY: z.string().optional(),
  MYEMAILVERIFIER_API_KEYS: z.string().optional(),

  // FREE email-discovery fallback. When on-site scraping AND Hunter domain-search
  // find no address (e.g. Hunter 429/quota out), and the domain accepts mail (a
  // free MX-record check passes), guess the near-universal UK-SMB role inbox
  // `info@<domain>`. MX blesses the guess; bounce risk on info@ is low (unlike a
  // personal guess). Keeps reach up when paid finders are throttled. Default on;
  // set false to stay scrape+Hunter only. PECR Ltd-gate still applies downstream.
  EMAIL_GUESS_ROLE_FALLBACK: z
    .string()
    .default("true")
    .transform((s) => s.toLowerCase() !== "false"),

  // Hunter.io — email finder + deliverability verification (free: 25 req/mo)
  // Domain search finds emails we missed; verify checks if a specific address
  // is deliverable (SMTP-level, much better than MX-only).
  HUNTER_API_KEY: z.string().optional(),
  // Multiple Hunter keys (any separator) → rotate on 429/quota so email lookup
  // never dead-ends on one key's free 25/mo limit. Legacy HUNTER_API_KEY still works.
  HUNTER_API_KEYS: z.string().optional(),

  // Firecrawl — JS-rendering web scraper (free: 500 credits/mo, keyless: rate-limited)
  // When set, enrichment uses Firecrawl to crawl sites (handles SPA, anti-bot,
  // cookie banners). Falls back to built-in HTTP crawler when empty.
  FIRECRAWL_API_KEY: z.string().optional(),

  // Optional UK director lookup (Companies House) for personalization.
  COMPANIES_HOUSE_API_KEY: z.string().optional(),

  // Web search discoverer (Serper by default; provider-agnostic shape)
  SEARCH_PROVIDER: z.enum(["serper"]).default("serper"),
  SERPER_API_KEY: z.string().optional(),

  // Maps discoverer backend: "serper" (Serper /places, no Google key needed)
  // or "google" (Places API New — needs GOOGLE_PLACES_API_KEY + the API enabled)
  MAPS_PROVIDER: z.enum(["serper", "google"]).default("serper"),
  GOOGLE_PLACES_API_KEY: z.string().optional(),

  // Vibe Prospecting export directory (populated by the agent via the MCP)
  VIBE_EXPORT_DIR: z.string().default("data/discovered"),

  ENRICH_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  ENRICH_USER_AGENT: z
    .string()
    .default("LeadFlowAI/1.0 (+https://github.com/morgunglyeb-arch/leadflow-ai)"),
  ENRICH_CACHE_DIR: z.string().default("data/cache"),
  CONCURRENCY: z.coerce.number().int().positive().default(5),

  OUTPUT_CSV_PATH: z.string().default("data/out/leads_enriched.csv"),
  DRAFTS_DIR: z.string().default("data/out/drafts"),
  DRAFTS_CSV_PATH: z.string().default("data/out/drafts.csv"),
  DIGEST_HTML_PATH: z.string().default("data/out/digest.html"),
  SHEETS_OUTPUT_ENABLED: z
    .string()
    .default("false")
    .transform((s) => s.toLowerCase() === "true"),

  // Sender identity used when assembling draft emails
  // Brand-only identity (no personal name shown to prospects — public brand is
  // "Opero"). Used as the sign-off/sender the reply-assistant references.
  SENDER_NAME: z.string().default("Opero"),
  // One-line self-intro (operator-digest only now — not prepended to the cold
  // email body). Studio "we" voice, brand-only, no personal name.
  SENDER_INTRO: z
    .string()
    .default(
      "We're Opero — we help local businesses stop losing customers to slow, manual admin.",
    ),
  // Shown to the prospect. Brand-only + the live brand domain (text, builds
  // trust without a clickable CTA link in the body). NO personal name, no GitHub.
  SENDER_SIGNATURE: z.string().default("Opero · opero-studio.com"),
  // No calls (you don't do live English calls). Sales-y CTA that names the site
  // in PLAIN TEXT ({site}, same bare domain as the signature — not a tracked
  // link, so deliverability is unaffected) and gives a no-friction reply option.
  CALL_TO_ACTION: z
    .string()
    .default(
      "Want to see where you could save time or money? Go to {site}, type in your line of work, and it'll show the automations that fit your business. Or just reply to this email and we'll advise you.",
    ),
  // Soft 1:1 CTA for format A/B variant B — one low-friction yes/no instead of the
  // site CTA. {company} → short business name. Audit: a single soft ask out-replies
  // a hard "go to the site" on cold mail.
  CALL_TO_ACTION_SOFT: z
    .string()
    .default("Want me to send a quick mockup of how this would work for {company}? Just reply."),
  // Format A/B (owner-authorized 2026-06-30). Half the leads (deterministic by
  // domain) get variant B: hook merged into the FIRST line (better inbox preview),
  // menu trimmed to EMAIL_MENU_MAX_B items, and the soft CTA above. Variant A = the
  // current owner-locked format, unchanged. Judge by reply-rate. false = all get A.
  EMAIL_FORMAT_AB: z
    .string()
    .default("true")
    .transform((s) => s.toLowerCase() !== "false"),
  EMAIL_MENU_MAX_B: z.coerce.number().default(2),
  // One-line "who we are" so every email plainly says what we do. Sits after the
  // personalized hook (never first — the hook earns the read). Plain, no jargon.
  STUDIO_INTRO: z
    .string()
    .default(
      "We're Opero, a studio that sets up done-for-you automations for businesses, so the repetitive admin runs itself.",
    ),
  // Heading for the short "here's what we could set up" menu of services.
  SERVICES_INTRO: z.string().default("A few things we could set up for you:"),
  // Show the services menu in the first email (owner wants prospects to see the
  // range up front). false = lean single-pitch email (menu moves to follow-ups).
  SHOW_SERVICES_MENU: z
    .string()
    .default("true")
    .transform((s) => s.toLowerCase() !== "false"),

  // Site self-serve CTA. The FIRST email stays link-free (deliverability on a
  // warming domain); follow-up #1 invites them to the site tool — a different
  // angle than the pitch, and the link lives in-thread where it's lower-risk.
  // Display the bare domain (no scheme) so it reads natural and isn't a tracked
  // anchor. {site} is replaced with SITE_URL.
  // Off by default now that the first-email CTA carries the site invite — keeps
  // follow-up #1 as a different angle (the AI nudge) instead of repeating it.
  SITE_CTA_ENABLED: z
    .string()
    .default("false")
    .transform((s) => s.toLowerCase() === "true"),
  SITE_URL: z.string().default("opero-studio.com"),
  SITE_CTA_LINE: z
    .string()
    .default(
      "Following up on my note. If replying isn't your thing, there's a faster way: go to {site}, type in your line of work, and you'll see the automations that fit your business and where they'd save you time or money. Takes about 20 seconds.",
    ),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_TEST_TO: z.string().optional(),
  // Your own inbox — where the daily digest of leads + drafts is sent
  EMAIL_DIGEST_TO: z.string().optional(),

  // --- Autonomous campaign (Gmail send + follow-up + learning) -------------
  CAMPAIGN_STATE_PATH: z.string().default("data/campaign/state.json"),
  // Master safety switch — must be explicitly true for the agent to SEND.
  SENDING_ENABLED: z
    .string()
    .default("false")
    .transform((s) => s.toLowerCase() === "true"),
  // Gmail OAuth (one-time setup). Credentials = the OAuth client json from
  // Google Cloud; token = produced by the auth flow (`npm run campaign -- --auth`).
  GMAIL_CREDENTIALS_PATH: z.string().default("secrets/gmail_credentials.json"),
  GMAIL_TOKEN_PATH: z.string().default("secrets/gmail_token.json"),
  GMAIL_SENDER: z.string().optional(), // your gmail address (the From:)
  // Multi-inbox: comma-separated Gmail addresses to ROTATE sends across (e.g.
  // "a@gmail.com,b@gmail.com,c@gmail.com"). Each gets its own warmup cap, so 3
  // inboxes ≈ 3× daily volume. Each needs its own one-time auth (npm run
  // campaign -- --auth authorizes them all in turn). Empty = single inbox
  // (GMAIL_SENDER + GMAIL_TOKEN_PATH), unchanged.
  GMAIL_ACCOUNTS: z.string().optional(),
  // Human display-names for the From header, comma-separated and ALIGNED 1:1 with
  // GMAIL_ACCOUNTS order (e.g. "Anna Brown,Sofia ...,James ..."). NOT a secret —
  // these are public sender names. If omitted/short, each inbox falls back to its
  // local-part capitalised (anna@ → "Anna"), then to SENDER_NAME for generic
  // mailboxes (info@, team@). Wiring: a bare-address From suppresses opens/trust;
  // a real name reads as a 1:1 human. See gmail.ts buildMime.
  GMAIL_NAMES: z.string().optional(),

  // The agent self-limits volume: it sends min(warmup-today, qualified leads
  // above the quality bar). Protects deliverability — never blasts.
  // Safe ceiling for a WARMED inbox is "under 50"; a fresh inbox must stay far
  // lower and only reach ~25 at the end of warmup (see GTM plan). Default 25.
  SEND_DAILY_CAP: z.coerce.number().int().positive().default(25),
  // Per-DOMAIN daily cold-send ceiling (belt-and-suspenders over the per-inbox
  // cap). 3 inboxes × 25 = 75/day/domain otherwise — too hot for fresh domains.
  // Caps total cold volume per sending domain regardless of how many inboxes it
  // has; rotation skips an inbox whose domain has hit this. Default 40.
  SEND_DOMAIN_DAILY_CAP: z.coerce.number().int().positive().default(40),
  // Gentle warmup for a fresh inbox: day1=5, +2/day (the safe step — +3 ramps
  // too fast and costs ~+23% spam placement in month 1). ~3-4wk to full volume.
  SEND_WARMUP_START: z.coerce.number().int().positive().default(5),
  SEND_WARMUP_STEP: z.coerce.number().int().positive().default(2),
  // Only send leads scoring at/above this ROI/quality bar (the rest queue for
  // your manual review). Higher = fewer, stronger sends.
  SEND_MIN_SCORE: z.coerce.number().default(9),
  // Max FIRST-TOUCHES per run. 0 = off (send up to the full daily cap in one go).
  // Set >0 + run the campaign on an hourly cron in the SEND_WINDOW to SPREAD the
  // day's volume into small bursts (human-looking, protects deliverability)
  // instead of firing the whole cap at once. Per-inbox daily caps still apply.
  SEND_PER_RUN_CAP: z.coerce.number().int().min(0).default(0),
  // Manual kill-switch: comma/space-separated inbox addresses to PULL from sending
  // without de-authing them (e.g. one stuck in spam placement). They keep warming;
  // they just won't send cold mail. Empty = all authorized inboxes send.
  SEND_EXCLUDE_INBOXES: z
    .string()
    .optional()
    .default("")
    .transform((s) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)),
  // ── Auto inbox-health guard (self-healing reputation auto-pause) ──────────
  // Each campaign run, the guard inspects every sending inbox: if its domain is
  // on a DNSBL, or its lifetime bounce rate exceeds INBOX_BOUNCE_PAUSE_RATE (once
  // it has at least INBOX_BOUNCE_MIN_SENT sends), it AUTO-PAUSES that inbox for
  // INBOX_PAUSE_DAYS and alerts the owner. A paused inbox keeps warming but stops
  // cold sends, so its reputation recovers; the pause auto-clears on expiry.
  INBOX_GUARD_ENABLED: z
    .string()
    .default("true")
    .transform((s) => s.toLowerCase() !== "false"),
  INBOX_BOUNCE_PAUSE_RATE: z.coerce.number().min(0).max(1).default(0.06),
  INBOX_BOUNCE_MIN_SENT: z.coerce.number().int().min(1).default(20),
  INBOX_PAUSE_DAYS: z.coerce.number().int().min(1).default(2),
  // Days to wait before each follow-up if no reply (comma-separated).
  FOLLOWUP_GAP_DAYS: z.string().default("3,10"),
  // Deliverability GATE (deliverability-audit skill, enforced in code): before
  // sending, verify each sending domain has SPF+DKIM+DMARC; inboxes on a failing
  // domain are skipped. Disable only for testing.
  DELIVERABILITY_GATE: z
    .string()
    .default("true")
    .transform((s) => s.toLowerCase() !== "false"),
  // UK PECR compliance (compliance-guard skill): only cold-email clearly-
  // incorporated entities (Ltd/LLP/PLC) — sole traders/individuals need consent.
  // The rest are held (not sent). Set false to override.
  SEND_CORPORATE_ONLY: z
    .string()
    .default("true")
    .transform((s) => s.toLowerCase() !== "false"),
  // Strengthens SEND_CORPORATE_ONLY with the Companies House register (needs
  // COMPANIES_HOUSE_API_KEY). When true, a name that the register searches but
  // finds NO active company for is held as a likely sole trader/individual.
  // When false (or no API key), we fall back to the trading-name heuristic only.
  REQUIRE_LTD: z
    .string()
    .default("true")
    .transform((s) => s.toLowerCase() !== "false"),
  OPT_OUT_TEXT: z
    .string()
    .default("Not relevant? Reply 'no' and I won't follow up."),

  // Never-contact list (domains/emails); opt-outs & bounces are auto-added.
  SUPPRESSION_PATH: z.string().default("data/campaign/suppression.txt"),
  // Send only in the highest-open windows, interpreted in the PROSPECT's timezone
  // (SEND_TZ), not the machine's. 2025/2026 data: mid-morning ~9-11 is the open-
  // rate peak, post-lunch ~13-15 a strong second; mapping to the recipient's local
  // time is the single biggest timing lever. Comma-separated 24h ranges (a-b, end
  // exclusive). Jitter between sends so the pattern looks human (deliverability).
  SEND_WINDOW: z.string().default("8-11,13-16"),
  // IANA timezone the SEND_WINDOW + SEND_DAYS are read in. Our prospects are UK,
  // so default to London — the operator's machine can run anywhere.
  SEND_TZ: z.string().default("Europe/London"),
  // Weekdays we send on (0=Sun … 6=Sat). Tue/Wed/Thu consistently top reply rates;
  // Fri/weekends underperform and Mon is noisy. Comma-separated.
  SEND_DAYS: z.string().default("2,3,4"),
  SEND_JITTER_SEC: z.coerce.number().int().min(0).max(600).default(45),
  // When a lead replies "interested", draft a suggested response for you.
  REPLY_ASSIST: z
    .string()
    .default("true")
    .transform((s) => s.toLowerCase() !== "false"),

  // --- Peer warmup (free, in-house — our own inboxes email each other) ------
  // Master switch. OFF by default: warmup needs the gmail.modify scope, so all
  // inboxes must be RE-authorized (npm run campaign -- --auth) before enabling.
  WARMUP_ENABLED: z
    .string()
    .default("false")
    .transform((s) => s.toLowerCase() === "true"),
  // Fail-closed escape hatch (audit #24): when WARMUP_ENABLED=false and sending is
  // LIVE, cold first-touches are HELD by default (no reputation base = torched
  // domains). Set true to deliberately send on the send-ramp alone (no peer-warmup).
  SEND_WITHOUT_WARMUP: z
    .string()
    .default("false")
    .transform((s) => s.toLowerCase() === "true"),
  // Peer-warmup volume per inbox: starts at WARMUP_DAILY, ramps linearly to
  // WARMUP_DAILY_MAX over WARMUP_RAMP_DAYS (gentle, human-looking). Plateau kept
  // at 8 (not 12) — the GTM safe protocol holds steady warmup traffic at 5–8/day
  // "forever"; higher volume of bot-to-bot mail starts to look synthetic.
  WARMUP_DAILY: z.coerce.number().int().positive().default(2),
  WARMUP_DAILY_MAX: z.coerce.number().int().positive().default(8),
  WARMUP_RAMP_DAYS: z.coerce.number().int().positive().default(21),
  // Fraction of received warmup mail an inbox replies to. 0.33 ≈ a natural human
  // reply rate; much higher reads as fake (GTM safe protocol: 30–35%).
  WARMUP_REPLY_RATE: z.coerce.number().min(0).max(1).default(0.33),
  // While warmup is ON, hold COLD first-touches until warmup has run this many
  // days (gives every inbox a sending/receiving history before strangers see it).
  // 14 = cold sending only from week 3, per the GTM safe warmup protocol.
  WARMUP_COLD_AFTER_DAYS: z.coerce.number().int().min(0).default(14),
  WARMUP_STATE_PATH: z.string().default("data/campaign/warmup.json"),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(): AppConfig {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export function assertLLMReady(cfg: AppConfig): void {
  if (cfg.LLM_PROVIDER === "anthropic" && !cfg.ANTHROPIC_API_KEY) {
    throw new Error("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set.");
  }
  if (cfg.LLM_PROVIDER === "groq" && !cfg.GROQ_API_KEY && !cfg.GROQ_API_KEYS) {
    throw new Error("LLM_PROVIDER=groq but neither GROQ_API_KEYS nor GROQ_API_KEY is set.");
  }
  if (cfg.LLM_PROVIDER === "openai" && !cfg.OPENAI_API_KEY) {
    throw new Error("LLM_PROVIDER=openai but OPENAI_API_KEY is not set.");
  }
}

export function emailTestReady(cfg: AppConfig): boolean {
  return Boolean(cfg.RESEND_API_KEY && cfg.EMAIL_FROM && cfg.EMAIL_TEST_TO);
}

export function digestReady(cfg: AppConfig): boolean {
  return Boolean(cfg.RESEND_API_KEY && cfg.EMAIL_FROM && cfg.EMAIL_DIGEST_TO);
}

export function sheetsOutputReady(cfg: AppConfig): boolean {
  return Boolean(
    cfg.SHEETS_OUTPUT_ENABLED && cfg.GOOGLE_SHEETS_ID && cfg.GOOGLE_SERVICE_ACCOUNT_JSON,
  );
}

export function assertDiscoveryReady(cfg: AppConfig, mock: boolean): void {
  if (mock) return; // fixtures used; no network credentials needed
  if (cfg.DISCOVERY_SOURCE === "search" && !cfg.SERPER_API_KEY) {
    throw new Error("DISCOVERY_SOURCE=search but SERPER_API_KEY is not set (or run with --mock).");
  }
  if (cfg.DISCOVERY_SOURCE === "maps") {
    if (cfg.MAPS_PROVIDER === "serper" && !cfg.SERPER_API_KEY) {
      throw new Error("DISCOVERY_SOURCE=maps MAPS_PROVIDER=serper but SERPER_API_KEY is not set.");
    }
    if (cfg.MAPS_PROVIDER === "google" && !cfg.GOOGLE_PLACES_API_KEY) {
      throw new Error("DISCOVERY_SOURCE=maps MAPS_PROVIDER=google but GOOGLE_PLACES_API_KEY is not set.");
    }
  }
}
