import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Enrichment, Lead, Personalized } from "./types.js";

export const PersonalizedSchema = z.object({
  opener: z.string().min(5).max(400),
  icebreaker: z.string().min(3).max(280),
  subject: z.string().min(3).max(120),
  fit_score: z.number().int().min(1).max(5),
  reason: z.string().min(3).max(280),
  process: z.string().min(3).max(240),
  automation: z.string().min(3).max(280),
  est_benefit: z.string().min(3).max(240),
});

const SYSTEM_PROMPT = `You are an expert SDR for an AI-automation studio. For each lead you write concise cold-email personalization AND a concrete automation pitch — a specific manual/repetitive process the company likely runs, and how WE would automate it.

Hard rules:
- Use ONLY the company context provided in the user message. Never invent facts, funding, headcount, customers, product names, or numbers that are not literally present.
- If the context is thin or missing, write a clean GENERIC opener tied to their company name and role only, set fit_score <= 2, set process to "unclear from site", and keep the automation generic.
- Reference at most one specific detail per message — what they do, who they sell to, or a clear signal from the page. Do not stack multiple claims.
- Tone: natural, peer-to-peer, confident, no flattery clichés. Banned phrases: "I hope this finds you well", "I came across your", "love what you're doing", "huge fan", "saw you guys are crushing it".
- opener: 1-2 sentences, first line of a cold email. No greeting line, no "Hi NAME,".
- icebreaker: one short observation about their business, separate from the opener.
- subject: <= 60 chars, lowercase or sentence case, no emojis, no ALL CAPS.
- fit_score: 1 (no fit) to 5 (excellent fit) against OUR offer. Be honest. If the company is clearly not in our target, score 1-2 and say why.
- reason: one line justifying fit_score, grounded in the context.
- process: the single most likely MANUAL or repetitive process at this company, INFERRED from the context (e.g. "phone-based appointment booking", "manual order/returns handling", "client onboarding paperwork"). Hedge honestly ("likely", "probably") — do not assert internal facts you can't see. If unclear, say "unclear from site".
- automation: in one sentence, how WE would automate that process with an agentic workflow, tied to OUR offer.
- est_benefit: a QUALITATIVE benefit (e.g. "fewer missed bookings, faster response"). NEVER invent percentages, hours saved, or dollar figures unless they appear in the context.

Output via the emit_personalization tool only.`;

const TOOL_NAME = "emit_personalization";
const TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    opener: { type: "string", maxLength: 400 },
    icebreaker: { type: "string", maxLength: 280 },
    subject: { type: "string", maxLength: 120 },
    fit_score: { type: "integer", minimum: 1, maximum: 5 },
    reason: { type: "string", maxLength: 280 },
    process: { type: "string", maxLength: 240 },
    automation: { type: "string", maxLength: 280 },
    est_benefit: { type: "string", maxLength: 240 },
  },
  required: [
    "opener",
    "icebreaker",
    "subject",
    "fit_score",
    "reason",
    "process",
    "automation",
    "est_benefit",
  ],
  additionalProperties: false,
};

interface AiInput {
  ourOffer: string;
  lead: Lead;
  enrichment: Enrichment;
  icpNote?: string;
}

function buildUserMessage(input: AiInput): string {
  const { lead, enrichment, ourOffer, icpNote } = input;
  const context = enrichment.ok && enrichment.summary_text
    ? enrichment.summary_text
    : "(no website context available — write a generic, clean opener and set fit_score <= 2)";
  const signals = enrichment.signals.length > 0 ? enrichment.signals.join(", ") : "(none)";
  return [
    `OUR OFFER:\n${ourOffer}`,
    icpNote ? `\nTARGETING NOTE: ${icpNote}` : null,
    "",
    "LEAD:",
    `- company: ${lead.company}`,
    `- domain: ${lead.domain}`,
    lead.name ? `- name: ${lead.name}` : null,
    lead.role ? `- role: ${lead.role}` : null,
    "",
    `COMPANY CONTEXT (from ${lead.domain}, use ONLY this):`,
    context,
    "",
    `DETECTED SIGNALS: ${signals}`,
    "",
    "Emit the structured personalization + automation pitch now.",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export function fallbackPersonalization(lead: Lead, enrichment: Enrichment): Personalized {
  const role = lead.role ? ` as ${lead.role.toLowerCase()}` : "";
  const opener = enrichment.ok
    ? `Working on something at ${lead.company} I think is relevant${role} — wanted to keep this short and ask if it lines up.`
    : `Wanted to reach out directly${role} about a small thing I think is relevant to ${lead.company}.`;
  return {
    opener,
    icebreaker: `Curious how ${lead.company} currently handles this internally.`,
    subject: `quick idea for ${lead.company}`,
    fit_score: enrichment.ok ? 3 : 2,
    reason: enrichment.ok
      ? "Generic fallback — fit unknown without deeper review."
      : "No website context available, so fit is uncertain.",
    process: "unclear from site",
    automation:
      "A short discovery call to map which repetitive ops could move to an agentic workflow.",
    est_benefit: "Less manual back-office work once the right process is identified.",
  };
}

async function callAnthropic(cfg: AppConfig, input: AiInput): Promise<Personalized> {
  const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: cfg.ANTHROPIC_MODEL,
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [
      {
        name: TOOL_NAME,
        description: "Emit the structured cold-email personalization.",
        input_schema: TOOL_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content: buildUserMessage(input) }],
  });
  const toolUse = res.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Anthropic response did not contain tool_use block.");
  }
  return PersonalizedSchema.parse(toolUse.input);
}

async function callGroq(cfg: AppConfig, input: AiInput): Promise<Personalized> {
  const client = new OpenAI({
    apiKey: cfg.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
  });
  const res = await client.chat.completions.create({
    model: cfg.GROQ_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `${buildUserMessage(input)}\n\n` +
          "Return ONLY a JSON object with keys: opener (string), icebreaker (string), " +
          "subject (string <=60 chars), fit_score (integer 1-5), reason (string), " +
          "process (string), automation (string), est_benefit (string).",
      },
    ],
  });
  const text = res.choices[0]?.message?.content ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Groq response was not valid JSON: ${(err as Error).message}`);
  }
  return PersonalizedSchema.parse(parsed);
}

export interface PersonalizationResult {
  personalized: Personalized;
  provider: "anthropic" | "groq" | "fallback";
}

export async function personalize(
  cfg: AppConfig,
  lead: Lead,
  enrichment: Enrichment,
  icpNote?: string,
): Promise<PersonalizationResult> {
  const input: AiInput = {
    ourOffer: cfg.OUR_OFFER,
    lead,
    enrichment,
    ...(icpNote ? { icpNote } : {}),
  };
  try {
    if (cfg.LLM_PROVIDER === "groq") {
      return { personalized: await callGroq(cfg, input), provider: "groq" };
    }
    return { personalized: await callAnthropic(cfg, input), provider: "anthropic" };
  } catch (err) {
    console.warn(
      `[ai] personalization failed for ${lead.domain}, using fallback: ${(err as Error).message}`,
    );
    return { personalized: fallbackPersonalization(lead, enrichment), provider: "fallback" };
  }
}
