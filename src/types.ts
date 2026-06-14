export interface Lead {
  company: string;
  domain: string;
  name?: string;
  role?: string;
  linkedin?: string;
  email?: string;
}

export interface Enrichment {
  domain: string;
  title?: string;
  description?: string;
  summary_text: string;
  signals: string[];
  ok: boolean;
  source: "live" | "cache" | "mock" | "failed";
  fetched_at: string;
  error?: string;
}

export interface Personalized {
  opener: string;
  icebreaker: string;
  subject: string;
  fit_score: number;
  reason: string;
}

export type OutputRow = Lead & {
  enriched: boolean;
  enrichment_source: Enrichment["source"];
  signals: string;
  ai_provider: "anthropic" | "groq" | "fallback";
} & Partial<Personalized>;
