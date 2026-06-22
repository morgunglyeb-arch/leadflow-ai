import { config as loadEnv } from "dotenv";
import { z } from "zod";

// `.env` is the app's source of truth — override any vars the surrounding
// shell may have preset (e.g. an empty ANTHROPIC_API_KEY) so config is honored.
loadEnv({ override: true });

const schema = z.object({
  // "anthropic" | "groq" | "openai" (any OpenAI-compatible endpoint:
  // Gemini, Cerebras, OpenRouter, Together, GitHub Models, OpenAI itself…)
  LLM_PROVIDER: z.enum(["anthropic", "groq", "openai"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
  GROQ_API_KEY: z.string().optional(),
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

  // Retry transient 429s (rate limits) before giving up to fallback
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  // Second LLM pass that reviews each draft against a rubric (right money
  // channel? worth their money? concise? grounded?) and rewrites weak ones.
  SELF_CRITIQUE: z
    .string()
    .default("true")
    .transform((s) => s.toLowerCase() !== "false"),

  OUR_OFFER: z
    .string()
    .default(
      "AI automation for small businesses: we set up systems that handle the manual work for them — missed-call text-back, lead capture and follow-up, reporting, customer triage.",
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

  // Hunter.io — email finder + deliverability verification (free: 25 req/mo)
  // Domain search finds emails we missed; verify checks if a specific address
  // is deliverable (SMTP-level, much better than MX-only).
  HUNTER_API_KEY: z.string().optional(),

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
  // No calls (you don't do live English calls). Reply-based, async CTA.
  CALL_TO_ACTION: z
    .string()
    .default(
      "If that'd be useful, just reply and I'll send a short example of how it'd work for you. No call needed.",
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

  // The agent self-limits volume: it sends min(warmup-today, qualified leads
  // above the quality bar). Protects deliverability — never blasts.
  // Safe ceiling for a WARMED inbox is "under 50"; a fresh inbox must stay far
  // lower and only reach ~25 at the end of warmup (see GTM plan). Default 25.
  SEND_DAILY_CAP: z.coerce.number().int().positive().default(25),
  // Gentle warmup for a fresh inbox: day1=5, +2/day (the safe step — +3 ramps
  // too fast and costs ~+23% spam placement in month 1). ~3-4wk to full volume.
  SEND_WARMUP_START: z.coerce.number().int().positive().default(10),
  SEND_WARMUP_STEP: z.coerce.number().int().positive().default(2),
  // Only send leads scoring at/above this ROI/quality bar (the rest queue for
  // your manual review). Higher = fewer, stronger sends.
  SEND_MIN_SCORE: z.coerce.number().default(9),
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
  // Only send during these local hours (24h), and jitter between sends so the
  // pattern looks human and protects deliverability.
  SEND_WINDOW: z.string().default("9-18"),
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
  // Peer-warmup volume per inbox: starts at WARMUP_DAILY, ramps linearly to
  // WARMUP_DAILY_MAX over WARMUP_RAMP_DAYS (gentle, human-looking).
  WARMUP_DAILY: z.coerce.number().int().positive().default(2),
  WARMUP_DAILY_MAX: z.coerce.number().int().positive().default(12),
  WARMUP_RAMP_DAYS: z.coerce.number().int().positive().default(21),
  // Fraction of received warmup mail an inbox replies to (two-way = real signal).
  WARMUP_REPLY_RATE: z.coerce.number().min(0).max(1).default(0.4),
  // While warmup is ON, hold COLD first-touches until warmup has run this many
  // days (gives every inbox a sending/receiving history before strangers see it).
  WARMUP_COLD_AFTER_DAYS: z.coerce.number().int().min(0).default(7),
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
  if (cfg.LLM_PROVIDER === "groq" && !cfg.GROQ_API_KEY) {
    throw new Error("LLM_PROVIDER=groq but GROQ_API_KEY is not set.");
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
