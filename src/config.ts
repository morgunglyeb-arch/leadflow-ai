import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  // "anthropic" | "groq" | "openai" (any OpenAI-compatible endpoint:
  // Gemini, Cerebras, OpenRouter, Together, GitHub Models, OpenAI itself…)
  LLM_PROVIDER: z.enum(["anthropic", "groq", "openai"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),

  // Generic OpenAI-compatible provider (used when LLM_PROVIDER=openai)
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z
    .string()
    .default("https://generativelanguage.googleapis.com/v1beta/openai/"),
  OPENAI_MODEL: z.string().default("gemini-2.0-flash"),

  // Retry transient 429s (rate limits) before giving up to fallback
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  OUR_OFFER: z
    .string()
    .default(
      "AI automation for SMBs — we build agentic workflows that replace manual ops (lead enrichment, reporting, customer triage).",
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
  SENDER_NAME: z.string().default("Glyeb"),
  SENDER_SIGNATURE: z
    .string()
    .default("Glyeb · AI automation for SMBs · github.com/morgunglyeb-arch"),
  CALL_TO_ACTION: z
    .string()
    .default("Worth a quick 15-min call to see if it's a fit?"),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_TEST_TO: z.string().optional(),
  // Your own inbox — where the daily digest of leads + drafts is sent
  EMAIL_DIGEST_TO: z.string().optional(),
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
