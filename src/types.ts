export interface Lead {
  company: string;
  domain: string;
  name?: string;
  role?: string;
  linkedin?: string;
  email?: string;
}

export type DiscoverySource = "search" | "maps" | "vibe" | "seed" | "csv";

export interface DiscoveredLead extends Lead {
  discovery_source: DiscoverySource;
  discovery_query?: string;
  phone?: string;
  rating?: number;
  reviews?: number;
  location?: string;
  cid?: string; // Google place id (maps) — used to pull reviews
}

export interface Enrichment {
  domain: string;
  title?: string;
  description?: string;
  summary_text: string;
  signals: string[];
  emails: string[]; // discovered on the site, best-ranked first
  ok: boolean;
  source: "live" | "cache" | "mock" | "failed";
  fetched_at: string;
  error?: string;
}

/**
 * The single LLM output per lead. Beyond the cold-email copy it carries an
 * automation pitch: a concrete manual process spotted in the company context
 * and how we'd automate it. All of it must be grounded in the enrichment text.
 */
export interface Personalized {
  opener: string;
  icebreaker: string;
  subject: string;
  fit_score: number;
  reason: string;
  // automation pitch
  process: string; // the manual/repetitive process spotted (or "unclear")
  automation: string; // what we'd automate it with
  est_benefit: string; // qualitative benefit, no invented numbers
  // internal brief for the operator, in DIGEST_LANG (not sent to the prospect)
  brief: string;
  // follow-up bodies (outreach language), sent only if no reply
  followup_1: string;
  followup_2: string;
  // A/B: a second subject line on a different angle (we test which wins)
  subject_b: string;
  // a concrete, tangible example of the assistant in action for this business
  demo: string;
  // a short menu of relevant services we could set up (so they see what's possible)
  services: string[];
}

export type LeadStatus = "draft" | "approved" | "sent" | "skipped";

export type OutputRow = DiscoveredLead & {
  enriched: boolean;
  enrichment_source: Enrichment["source"];
  signals: string;
  ai_provider: "anthropic" | "groq" | "openai" | "fallback";
  status: LeadStatus;
  email_source: "provided" | "site" | "none";
} & Partial<Personalized>;
