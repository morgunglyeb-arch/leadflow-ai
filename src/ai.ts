import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { DiscoveredLead, Enrichment, Lead, Personalized } from "./types.js";
import { matchVertical, verticalFacts } from "./vertical.js";

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
  followup_1: z.string().min(5).max(500),
  followup_2: z.string().min(5).max(500),
  subject_b: z.string().min(3).max(120),
  demo: z.string().min(3).max(320),
  services: z.array(z.string().min(3).max(100)).min(2).max(4),
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
- State the problem as a FACT from the evidence — NO hedging words ("likely", "probably", "maybe", "скорее всего").
- If you genuinely cannot see a concrete gap, set process to "unclear from site" (it will be filtered out) — do NOT guess.
- Don't pitch what they ALREADY have. If they already have online booking and a chatbot, find a DIFFERENT gap (missed-call text-back, review collection, no-show reminders, follow-ups, reactivation of past customers). If everything obvious is already automated, lower the fit_score.

CHANNEL REALISM (very important — pitch only what pays off for THEM):
- A social link (instagram, telegram, facebook in the footer) usually means a MARKETING presence, NOT that customers book or enquire there. Do NOT assume people book via Instagram/Telegram. Only pitch automating a social channel if there's REAL evidence customers use it to enquire/book — e.g. "DM us to book", a WhatsApp click-to-chat button, or an industry where DM-booking is genuinely normal (beauty, aesthetics, barbers, salons, nails, tattoo, restaurants).
- Match the pitch to how customers in THAT industry actually contact the business:
  • Dental / medical / physio / opticians / vets / legal / accountants / trades (plumbers, electricians, roofers, HVAC): customers book by PHONE and via the website (form or online booking). The money channel is the phone. The highest-value, realistic gap is almost always missed / after-hours phone calls and slow replies to web enquiries → pitch missed-call text-back and instant web-enquiry replies, NOT an Instagram booking bot.
  • Beauty / aesthetics / salons / barbers / restaurants: Instagram & WhatsApp DMs ARE often a real booking channel → a social-DM assistant can fit.
  • Ecommerce: website chat, email, returns/order questions.
- The problem must be one that costs them REAL money and where the fix clearly pays for itself. If the only "gap" is a channel their customers don't actually use to book, that's a weak pitch — pick the phone/web enquiry gap instead, or lower the fit_score.
- whatsapp signal = a real click-to-chat channel (people do message businesses on WhatsApp). instagram/telegram signals alone = treat as marketing unless evidence says otherwise.

ECONOMICS (make it obviously worth their money):
- Frame the gap as lost MONEY, not lost convenience, using the INDUSTRY FACTS ticket size. E.g. for a dental implant clinic: "with implant cases worth thousands, even one missed enquiry a week is serious money walking to a competitor." For a plumber: "every missed emergency call is a £100–£500 job gone to the next number."
- Use the ticket size qualitatively ("cases worth thousands", "jobs worth hundreds") — do NOT invent precise totals, percentages, or hours saved. The point: one or two recovered customers pays for the whole thing.

WRITING FOR A NON-TECHNICAL OWNER (critical):
- The owner does NOT know what "automation", "AI agent", "workflow" or "integration" means. Write so a busy shop/clinic owner instantly gets it.
- BANNED words in opener/subject/automation/est_benefit/followups: agentic, workflow, pipeline, LLM, GPT, API, integration, "AI-driven", TypeScript, "solution", "leverage", "streamline", "synergy".
- Describe what it DOES in concrete terms, e.g. "a helper that answers every WhatsApp message and books the slot for you, even after hours" — not "an AI workflow".
- Lead with the pain and the result (missed calls = lost customers; never miss a booking again), not the technology. No flattery clichés, no "I hope this finds you well", "I came across your".
- The email must make sense and feel worth a reply on its own — it should sell itself.

NEVER PROPOSE A CALL OR MEETING. The sender does not take live calls. The only ask is a REPLY (e.g. "reply and I'll send a short example/video"). Banned: "jump on a call", "15-minute call", "hop on a quick call", "book a meeting", "schedule a chat". Offering to SEND a short recorded video or example is fine (it's async).

SHOW A FEW SERVICES (people often don't know what's possible):
- services: 2-4 short, concrete things we could set up for THIS business, drawn from the relevant automations for their type (see INDUSTRY FACTS) — e.g. "Auto text-back to every missed call", "An AI assistant in WhatsApp/Instagram that answers and books", "A simple CRM that logs every enquiry and follows up", "Automatic appointment reminders to cut no-shows". Each <=12 words, plain, no jargon. Only list channels their customers actually use (don't list Instagram booking for a dentist). This menu shows them the range of what's possible.

KEEP IT SHORT (deliverability + reply rate):
- The FIRST email (opener + the offer line) must read in under ~80 words total. Short sentences. One idea. Cold emails that are short get more replies and land in the inbox.
- If COMPLAINT reviews are provided, that real customer pain is your STRONGEST angle — name it (e.g. "a few reviewers mention struggling to get through by phone") without exaggerating or inventing.

FOLLOW-UPS (sent later only if they don't reply):
- followup_1: a 2-sentence nudge for ~3 days later. A DIFFERENT angle than the first email (e.g. a concrete proof offer: "happy to record a 2-minute video showing it working on your site") or a sharp one-line question. Not a repeat.
- followup_2: a 1-2 sentence polite break-up for ~4 days after that ("I'll assume the timing isn't right — happy to leave the door open"). Low-pressure, classy.
- Both in ${outName}, plain language, no greeting line (the app adds it), no signature.

LANGUAGE (strict):
- Write opener, icebreaker, subject, process, automation, est_benefit and reason in ${outName} (the prospect reads this).
- Write "brief" ONLY in ${digName}, for OUR operator (not the prospect): 2-4 plain sentences — what the business does, the EXACT problem we'll solve (no hedging), the EXACT thing we'll build and sell them, and why the fit score. If ${digName} is Russian, write it entirely in Russian Cyrillic.

Fields:
- opener: 1-2 sentences that go straight to THEIR specific situation/problem in plain words. A short sender self-intro is added automatically before this, so do NOT introduce yourself or say "I'm…"; no greeting line.
- icebreaker: one short, specific observation about their business.
- subject: <= 60 chars, plain, curiosity or benefit, no emojis, no ALL CAPS.
- fit_score: 1 (no fit) to 5 (excellent). High when there is a clear unautomated, sellable gap.
- reason: one line justifying the score, grounded in evidence.
- process: the EXACT unautomated, manual thing they do now — stated as fact, naming the channel from the signals. No hedging. Or "unclear from site".
- automation: one plain sentence that makes the OFFER unmistakable — name WHAT we'd set up and that it runs AUTOMATICALLY with no work for their team, in their channel. The reader must instantly get what they're being offered. e.g. "We'd set up an automatic assistant that texts back every missed call within seconds and books the patient in for you — 24/7, hands-off." Not vague ("a system that helps with calls"); concrete, done-for-you, no jargon.
- est_benefit: a concrete owner outcome (e.g. "never miss a booking, less time on the phone, fewer no-shows"). No invented numbers.
- brief: see LANGUAGE above.
- followup_1, followup_2: see FOLLOW-UPS above (offer to SEND an example/video; never a call).
- services: see "SHOW A FEW SERVICES" above.
- subject: the main subject line. subject_b: a SECOND subject on a DIFFERENT angle (e.g. one curiosity-led, one benefit/outcome-led) for A/B testing. Both <=60 chars, plain, no emojis/ALL CAPS.
- demo: ONE concrete, tangible example of the assistant in action for THIS business — the actual message a customer would receive, using the real business name, e.g. "Hi, sorry we missed your call at Smile Dental — reply here and we'll get you booked in." Specific and realistic, in ${outName}. NEVER use bracketed placeholders like [phone number] or [Clinic]; use the real name or just leave that detail out so it reads like a finished message.

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
    followup_1: { type: "string", maxLength: 500 },
    followup_2: { type: "string", maxLength: 500 },
    subject_b: { type: "string", maxLength: 120 },
    demo: { type: "string", maxLength: 320 },
    services: {
      type: "array",
      items: { type: "string", maxLength: 100 },
      minItems: 2,
      maxItems: 4,
    },
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
    "followup_1",
    "followup_2",
    "subject_b",
    "demo",
    "services",
  ],
  additionalProperties: false,
};

interface AiInput {
  ourOffer: string;
  lead: DiscoveredLead;
  enrichment: Enrichment;
  icpNote?: string;
  reviewsText?: string;
  verticalFacts?: string;
  winnersText?: string;
  outreachLang: string;
  digestLang: string;
}

interface Winner {
  vertical?: string;
  subject?: string;
  opener?: string;
}
let winnersCache: Winner[] | undefined;

/** Load openers that earned replies (written by the learning loop) for few-shot. */
async function loadWinners(): Promise<Winner[]> {
  if (winnersCache !== undefined) return winnersCache;
  try {
    const w = JSON.parse(await readFile("data/campaign/winners.json", "utf8"));
    winnersCache = Array.isArray(w) ? (w as Winner[]) : [];
  } catch {
    winnersCache = [];
  }
  return winnersCache;
}

function winnersText(winners: Winner[]): string | undefined {
  const good = winners.filter((w) => w.opener).slice(0, 5);
  if (good.length === 0) return undefined;
  return [
    "EXAMPLES THAT EARNED REPLIES (emulate the angle/style for similar businesses — do NOT copy verbatim):",
    ...good.map((w) => `- [${w.vertical ?? ""}] subject "${w.subject ?? ""}" — ${(w.opener ?? "").slice(0, 160)}`),
  ].join("\n");
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
    input.winnersText ? `\n${input.winnersText}` : null,
    "",
    "LEAD:",
    `- company: ${lead.company}`,
    `- domain: ${lead.domain}`,
    lead.name ? `- name: ${lead.name}` : null,
    lead.role ? `- role: ${lead.role}` : null,
    lead.location ? `- location: ${lead.location}` : null,
    lead.phone ? `- public phone: ${lead.phone}` : null,
    lead.rating !== undefined
      ? `- google rating: ${lead.rating}${lead.reviews !== undefined ? ` from ${lead.reviews} reviews` : ""} (high review counts = busy = missed enquiries cost more; you MAY reference this naturally)`
      : null,
    "",
    input.verticalFacts ? `${input.verticalFacts}\n` : null,
    `COMPANY CONTEXT (from ${lead.domain}, use ONLY this):`,
    context,
    "",
    input.reviewsText
      ? `REAL GOOGLE REVIEWS (use to spot what customers value and any pain like slow replies / hard to book; reference something specific and TRUE, never quote a made-up review):\n${input.reviewsText}\n`
      : null,
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
    followup_1: `Just floating this back to the top of your inbox — happy to show a quick example of what we'd set up for ${lead.company}.`,
    followup_2: `I'll assume the timing isn't right for now — happy to leave the door open if things change.`,
    subject_b: `a quick win for ${lead.company}`,
    demo: "",
    services: [
      "Auto text-back to every missed call",
      "Instant replies to website and social enquiries",
      "A simple system that logs leads and follows up",
    ],
  };
}

async function callAnthropicRaw(
  cfg: AppConfig,
  system: string,
  userContent: string,
): Promise<Personalized> {
  const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: cfg.ANTHROPIC_MODEL,
    max_tokens: 1400,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools: [
      {
        name: TOOL_NAME,
        description: "Emit the structured cold-email personalization.",
        input_schema: TOOL_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content: userContent }],
  });
  const toolUse = res.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Anthropic response did not contain tool_use block.");
  }
  return PersonalizedSchema.parse(toolUse.input);
}

function callAnthropic(cfg: AppConfig, input: AiInput): Promise<Personalized> {
  return callAnthropicRaw(
    cfg,
    buildSystemPrompt(input.outreachLang, input.digestLang),
    buildUserMessage(input),
  );
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
const JSON_KEYS_HINT =
  "Return ONLY a JSON object with keys: opener (string), icebreaker (string), " +
  "subject (string <=60 chars), fit_score (integer 1-5), reason (string), " +
  "process (string), automation (string), est_benefit (string), brief (string), " +
  "followup_1 (string), followup_2 (string), subject_b (string), demo (string), " +
  "services (array of 2-4 short strings).";

async function callOpenAIRaw(
  cfg: AppConfig,
  system: string,
  userContent: string,
  opts: { apiKey?: string; baseURL: string; model: string },
): Promise<Personalized> {
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: userContent },
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

function callOpenAICompatible(
  cfg: AppConfig,
  input: AiInput,
  opts: { apiKey?: string; baseURL: string; model: string },
): Promise<Personalized> {
  const system = buildSystemPrompt(input.outreachLang, input.digestLang);
  const userContent = `${buildUserMessage(input)}\n\n${JSON_KEYS_HINT}`;
  return callOpenAIRaw(cfg, system, userContent, opts);
}

function providerCall(cfg: AppConfig, system: string, userContent: string): Promise<Personalized> {
  if (cfg.LLM_PROVIDER === "groq") {
    return callOpenAIRaw(cfg, system, `${userContent}\n\n${JSON_KEYS_HINT}`, {
      apiKey: cfg.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
      model: cfg.GROQ_MODEL,
    });
  }
  if (cfg.LLM_PROVIDER === "openai") {
    return callOpenAIRaw(cfg, system, `${userContent}\n\n${JSON_KEYS_HINT}`, {
      apiKey: cfg.OPENAI_API_KEY,
      baseURL: cfg.OPENAI_BASE_URL,
      model: cfg.OPENAI_MODEL,
    });
  }
  return callAnthropicRaw(cfg, system, userContent);
}

const CRITIQUE_RUBRIC = `You are a strict reviewer of a cold email a colleague drafted. Improve it ONLY where it fails a check; otherwise keep it essentially as-is. Checks:
1. CHANNEL FIT: does the pitch match how this industry actually books (see INDUSTRY FACTS)? If it pitches a channel customers don't book through (e.g. an Instagram booking bot for a dentist), REWRITE it to the real money channel (usually phone/web for clinics, trades, legal).
2. MONEY: is the cost framed in real money using the ticket size (qualitatively)? If not, add it.
3. TIGHT: first email <= ~80 words, plain owner-language, no banned jargon, problem stated as fact (no hedging). Tighten if needed.
4. GROUNDED: nothing invented — only the provided context. Remove anything unverifiable.
5. SUBJECT <=60 chars, not spammy.
Keep the language rules. Return the full corrected object via the emit_personalization tool (all fields), even fields you didn't change.`;

async function selfCritique(
  cfg: AppConfig,
  input: AiInput,
  draft: Personalized,
): Promise<Personalized> {
  const system = `${buildSystemPrompt(input.outreachLang, input.digestLang)}\n\n${CRITIQUE_RUBRIC}`;
  const userContent =
    `${buildUserMessage(input)}\n\nCURRENT DRAFT (review against the checks, fix only what fails):\n` +
    JSON.stringify(draft);
  return providerCall(cfg, system, userContent);
}

export interface PersonalizationResult {
  personalized: Personalized;
  provider: "anthropic" | "groq" | "openai" | "fallback";
}

export async function personalize(
  cfg: AppConfig,
  lead: DiscoveredLead,
  enrichment: Enrichment,
  icpNote?: string,
  reviewsText?: string,
): Promise<PersonalizationResult> {
  const vertical = await matchVertical(
    `${lead.discovery_query ?? ""} ${lead.company} ${enrichment.title ?? ""} ${enrichment.summary_text.slice(0, 400)}`,
  );
  const wt = winnersText(await loadWinners());
  const input: AiInput = {
    ourOffer: cfg.OUR_OFFER,
    lead,
    enrichment,
    outreachLang: cfg.OUTREACH_LANG,
    digestLang: cfg.DIGEST_LANG,
    verticalFacts: verticalFacts(vertical),
    ...(icpNote ? { icpNote } : {}),
    ...(reviewsText ? { reviewsText } : {}),
    ...(wt ? { winnersText: wt } : {}),
  };
  const provider: PersonalizationResult["provider"] =
    cfg.LLM_PROVIDER === "groq" ? "groq" : cfg.LLM_PROVIDER === "openai" ? "openai" : "anthropic";
  try {
    let personalized =
      cfg.LLM_PROVIDER === "groq"
        ? await callOpenAICompatible(cfg, input, {
            apiKey: cfg.GROQ_API_KEY,
            baseURL: "https://api.groq.com/openai/v1",
            model: cfg.GROQ_MODEL,
          })
        : cfg.LLM_PROVIDER === "openai"
          ? await callOpenAICompatible(cfg, input, {
              apiKey: cfg.OPENAI_API_KEY,
              baseURL: cfg.OPENAI_BASE_URL,
              model: cfg.OPENAI_MODEL,
            })
          : await callAnthropic(cfg, input);

    // Second pass: review against the rubric and rewrite weak/off-channel drafts.
    if (cfg.SELF_CRITIQUE) {
      try {
        personalized = await selfCritique(cfg, input, personalized);
      } catch (err) {
        console.warn(`[ai] self-critique skipped for ${lead.domain}: ${(err as Error).message}`);
      }
    }
    return { personalized, provider };
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

/** Provider-agnostic free-text generation (no schema) — used for reply drafts. */
async function generateText(cfg: AppConfig, system: string, user: string): Promise<string> {
  if (cfg.LLM_PROVIDER === "anthropic") {
    const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      model: cfg.ANTHROPIC_MODEL,
      max_tokens: 500,
      system: [{ type: "text", text: system }],
      messages: [{ role: "user", content: user }],
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }
  const isGroq = cfg.LLM_PROVIDER === "groq";
  const client = new OpenAI({
    apiKey: isGroq ? cfg.GROQ_API_KEY : cfg.OPENAI_API_KEY,
    baseURL: isGroq ? "https://api.groq.com/openai/v1" : cfg.OPENAI_BASE_URL,
  });
  const res = await client.chat.completions.create({
    model: isGroq ? cfg.GROQ_MODEL : cfg.OPENAI_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return (res.choices[0]?.message?.content ?? "").trim();
}

export interface ReplyContext {
  company: string;
  ourOffer: string;
  pitchedProcess?: string;
  pitchedAutomation?: string;
  theirReply: string;
}

/**
 * Draft a suggested response to a prospect's reply, so the operator can answer
 * fast (speed-to-lead) and move toward a call. Plain, short, no jargon.
 */
export async function suggestReply(cfg: AppConfig, ctx: ReplyContext): Promise<string> {
  const lang = LANG_NAME[cfg.OUTREACH_LANG] ?? "English";
  const system = `You help a small AI-automation studio reply to a prospect who responded to a cold email. Write the reply the operator should send: warm, concise (<=80 words), plain language (no jargon like "workflow/API/agentic"), and move toward a quick 15-minute call or a concrete next step. Answer their actual question (e.g. rough pricing range, how it works) honestly; if unsure, offer to cover it on a short call. Write in ${lang}. Output ONLY the reply body (no subject, no signature).`;
  const user = [
    `Our offer: ${ctx.ourOffer}`,
    ctx.pitchedProcess ? `We pitched fixing: ${ctx.pitchedProcess}` : "",
    ctx.pitchedAutomation ? `What we proposed: ${ctx.pitchedAutomation}` : "",
    `\nThe prospect (${ctx.company}) replied:\n"${ctx.theirReply}"`,
    `\nDraft the reply to send:`,
  ]
    .filter(Boolean)
    .join("\n");
  return generateText(cfg, system, user);
}
