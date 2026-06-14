import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  LLM_PROVIDER: z.enum(["anthropic", "groq"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),

  OUR_OFFER: z
    .string()
    .default(
      "AI automation for SMBs — we build agentic workflows that replace manual ops (lead enrichment, reporting, customer triage).",
    ),

  LEADS_SOURCE: z.enum(["csv", "sheets"]).default("csv"),
  LEADS_CSV_PATH: z.string().default("data/leads.csv"),
  GOOGLE_SHEETS_ID: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_SHEETS_READ_RANGE: z.string().default("leads!A1:F"),
  GOOGLE_SHEETS_WRITE_RANGE: z.string().default("leads_out!A1"),

  ENRICH_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  ENRICH_USER_AGENT: z
    .string()
    .default("LeadFlowAI/1.0 (+https://github.com/morgunglyeb-arch/leadflow-ai)"),
  ENRICH_CACHE_DIR: z.string().default("data/cache"),
  CONCURRENCY: z.coerce.number().int().positive().default(5),

  OUTPUT_CSV_PATH: z.string().default("data/out/leads_enriched.csv"),
  SHEETS_OUTPUT_ENABLED: z
    .string()
    .default("false")
    .transform((s) => s.toLowerCase() === "true"),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_TEST_TO: z.string().optional(),
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
}

export function emailTestReady(cfg: AppConfig): boolean {
  return Boolean(cfg.RESEND_API_KEY && cfg.EMAIL_FROM && cfg.EMAIL_TEST_TO);
}

export function sheetsOutputReady(cfg: AppConfig): boolean {
  return Boolean(
    cfg.SHEETS_OUTPUT_ENABLED && cfg.GOOGLE_SHEETS_ID && cfg.GOOGLE_SERVICE_ACCOUNT_JSON,
  );
}
