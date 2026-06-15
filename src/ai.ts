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
  brief: z.string().min(3).max(700),
});

const LANG_NAME: Record<string, string> = { en: "English", uk: "Ukrainian", ru: "Russian" };

function buildSystemPrompt(outreachLang: string, digestLang: string): string {
  const outName = LANG_NAME[outreachLang] ?? "English";
  const digName = LANG_NAME[digestLang] ?? "Russian";
  return `You are a senior consultant for a studio that builds custom AI assistants and automations for small businesses. For each lead you find the SINGLE most valuable thing this business has NOT yet automated — something we can build and sell them — and write a short, plain cold email that sells it.

What we can build (pick the ONE best fit for THIS business from the site evidence; don't force the same idea on everyone):
- an assistant that answers calls / texts / website chat / social DMs and books the appointment automatically
- a 24/7 assistant inside their own WhatsApp, Instagram, Telegram or website chat that replies instantly and qualifies enquiries
- instant text-back to every missed call or new enquiry
- automatic reminders to cut no-shows; review collection and replies
- quote / intake forms, follow-ups, order & returns handling, back-office reporting

GROUNDING (no hallucination):
- Use ONLY the company context + DETECTED SIGNALS provided. Never invent facts, numbers, tools, or channels that aren't evidenced.
- The DETECTED SIGNALS show how they contact customers (e.g. whatsapp, instagram, phone_booking, contact_form, online_booking, live_chat). Use them to name the EXACT current situation.
- State the problem as a FACT from the evidence — NO hedging words ("likely", "probably", "maybe", "скорее всего"). E.g. if signals show phone_booking and no online_booking: "you take bookings by phone and reply to enquiries by hand". If signals show instagram + whatsapp: "you handle enquiries through Instagram and WhatsApp manually".
- If you genuinely cannot see a concrete gap, set process to "unclear from site" (it will be filtered out) — do NOT guess.

WRITING FOR A NON-TECHNICAL OWNER (critical):
- The owner does NOT know what "automation", "AI agent", "workflow" or "integration" means. Write so a busy shop/clinic owner instantly gets it.
- BANNED words in opener/subject/automation/est_benefit: agentic, workflow, pipeline, LLM, GPT, API, integration, "AI-driven", TypeScript, "solution", "leverage", "streamline", "synergy".
- Describe what it DOES in concrete terms, e.g. "a helper that answers every WhatsApp message and books the slot for you, even after hours" — not "an AI workflow".
- Lead with the pain and the result (missed calls = lost customers; never miss a booking again), not the technology. No flattery clichés, no "I hope this finds you well", "I came across your".
- The email must make sense and feel worth a reply on its own — it should sell itself.

LANGUAGE (strict):
- Write opener, icebreaker, subject, process, automation, est_benefit and reason in ${outName} (the prospect reads this).
- Write "brief" ONLY in ${digName}, for OUR operator (not the prospect): 2-4 plain sentences — what the business does, the EXACT problem we'll solve (no hedging), the EXACT thing we'll build and sell them, and why the fit score. If ${digName} is Russian, write it entirely in Russian Cyrillic.

Fields:
- opener: 1-2 sentences, first line of the email, references their exact situation in plain words. No greeting line.
- icebreaker: one short, specific observation about their business.
- subject: <= 60 chars, plain, curiosity or benefit, no emojis, no ALL CAPS.
- fit_score: 1 (no fit) to 5 (excellent). High when there is a clear unautomated, sellable gap.
- reason: one line justifying the score, grounded in evidence.
- process: the EXACT unautomated, manual thing they do now — stated as fact, naming the channel from the signals. No hedging. Or "unclear from site".
- automation: one plain sentence — exactly what we'd build for them, in their channel, in owner-language. No jargon.
- est_benefit: a concrete owner outcome (e.g. "never miss a booking, less time on the phone, fewer no-shows"). No invented numbers.
- brief: see LANGUAGE above.

Output via the emit_personalization tool only.`;
}

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
    brief: { type: "string", maxLength: 700 },
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
    "brief",
  ],
  additionalProperties: false,
};

interface AiInput {
  ourOffer: string;
  lead: Lead;
  enrichment: Enrichment;
  icpNote?: string;
  outreachLang: string;
  digestLang: string;
}

function buildUserMessage(input: AiInput): string {
  const { lead, enrichment, ourOffer, icpNote } = input;
  const outName = LANG_NAME[input.outreachLang] ?? "English";
  const digName = LANG_NAME[input.digestLang] ?? "Russian";
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
    `DETECTED SIGNALS (how they contact customers / book): ${signals}`,
    "",
    `Now: pick the ONE most valuable thing they have NOT automated (use the signals to name the exact channel), state the problem as fact (no hedging), and write the email in plain owner-language with NO jargon.`,
    `Write all email fields in ${outName}. Write "brief" in ${digName} ONLY${input.digestLang === "ru" ? " (Russian Cyrillic — не пиши brief на английском)" : ""}.`,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

const FALLBACK_BRIEF: Record<string, (c: string) => string> = {
  ru: (c) =>
    `${c}: автоматический разбор не удался (LLM недоступен/ошибка). Зайди на сайт вручную, чтобы оценить ручные процессы и фит. Письмо ниже — нейтральный шаблон.`,
  uk: (c) =>
    `${c}: автоматичний розбір не вдався (LLM недоступний/помилка). Зайди на сайт вручну, щоб оцінити ручні процеси та фіт. Лист нижче — нейтральний шаблон.`,
  en: (c) =>
    `${c}: automatic analysis failed (LLM unavailable/error). Review the site manually to judge manual ops and fit. The email below is a neutral template.`,
};

export function fallbackPersonalization(
  lead: Lead,
  enrichment: Enrichment,
  digestLang = "ru",
): Personalized {
  const role = lead.role ? ` as ${lead.role.toLowerCase()}` : "";
  const opener = enrichment.ok
    ? `Working on something at ${lead.company} I think is relevant${role} — wanted to keep this short and ask if it lines up.`
    : `Wanted to reach out directly${role} about a small thing I think is relevant to ${lead.company}.`;
  const brief = (FALLBACK_BRIEF[digestLang] ?? FALLBACK_BRIEF.ru!)(lead.company);
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
    brief,
  };
}

async function callAnthropic(cfg: AppConfig, input: AiInput): Promise<Personalized> {
  const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: cfg.ANTHROPIC_MODEL,
    max_tokens: 1200,
    system: [
      {
        type: "text",
        text: buildSystemPrompt(input.outreachLang, input.digestLang),
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Parse "try again in 8.65s" from a rate-limit message; fallback to backoff. */
function retryDelayMs(err: unknown, attempt: number): number {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/try again in ([\d.]+)\s*s/i);
  if (m && m[1]) return Math.ceil(Number.parseFloat(m[1]) * 1000) + 250;
  return Math.min(8000, 600 * 2 ** attempt); // 0.6s, 1.2s, 2.4s…
}

function isRateLimit(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  return e?.status === 429 || /\b429\b|rate limit/i.test(e?.message ?? "");
}

/**
 * One call against any OpenAI-compatible endpoint (Groq, Gemini, Cerebras,
 * OpenRouter, OpenAI…). Retries transient 429s, honoring the provider's
 * "try again in Xs" hint when present.
 */
async function callOpenAICompatible(
  cfg: AppConfig,
  input: AiInput,
  opts: { apiKey?: string; baseURL: string; model: string },
): Promise<Personalized> {
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  const messages = [
    { role: "system" as const, content: buildSystemPrompt(input.outreachLang, input.digestLang) },
    {
      role: "user" as const,
      content:
        `${buildUserMessage(input)}\n\n` +
        "Return ONLY a JSON object with keys: opener (string), icebreaker (string), " +
        "subject (string <=60 chars), fit_score (integer 1-5), reason (string), " +
        "process (string), automation (string), est_benefit (string), brief (string).",
    },
  ];

  let lastErr: unknown;
  for (let attempt = 0; attempt <= cfg.LLM_MAX_RETRIES; attempt++) {
    try {
      const res = await client.chat.completions.create({
        model: opts.model,
        response_format: { type: "json_object" },
        messages,
      });
      const text = res.choices[0]?.message?.content ?? "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new Error(`response was not valid JSON: ${(err as Error).message}`);
      }
      return PersonalizedSchema.parse(parsed);
    } catch (err) {
      lastErr = err;
      if (isRateLimit(err) && attempt < cfg.LLM_MAX_RETRIES) {
        const delay = retryDelayMs(err, attempt);
        console.warn(`[ai] rate-limited, retrying in ${(delay / 1000).toFixed(1)}s…`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export interface PersonalizationResult {
  personalized: Personalized;
  provider: "anthropic" | "groq" | "openai" | "fallback";
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
    outreachLang: cfg.OUTREACH_LANG,
    digestLang: cfg.DIGEST_LANG,
    ...(icpNote ? { icpNote } : {}),
  };
  try {
    if (cfg.LLM_PROVIDER === "groq") {
      const personalized = await callOpenAICompatible(cfg, input, {
        apiKey: cfg.GROQ_API_KEY,
        baseURL: "https://api.groq.com/openai/v1",
        model: cfg.GROQ_MODEL,
      });
      return { personalized, provider: "groq" };
    }
    if (cfg.LLM_PROVIDER === "openai") {
      const personalized = await callOpenAICompatible(cfg, input, {
        apiKey: cfg.OPENAI_API_KEY,
        baseURL: cfg.OPENAI_BASE_URL,
        model: cfg.OPENAI_MODEL,
      });
      return { personalized, provider: "openai" };
    }
    return { personalized: await callAnthropic(cfg, input), provider: "anthropic" };
  } catch (err) {
    console.warn(
      `[ai] personalization failed for ${lead.domain}, using fallback: ${(err as Error).message}`,
    );
    return {
      personalized: fallbackPersonalization(lead, enrichment, cfg.DIGEST_LANG),
      provider: "fallback",
    };
  }
}
