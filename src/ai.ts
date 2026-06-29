import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { DiscoveredLead, Enrichment, Lead, Personalized } from "./types.js";
import { matchVertical, verticalFacts, verticalFromQuery } from "./vertical.js";
import { existingAutomations } from "./enrich.js";
import { fetchWinners } from "./ops-emit.js";

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

/** Max length per string field, mirroring PersonalizedSchema. */
const FIELD_MAX: Record<string, number> = {
  opener: 400,
  icebreaker: 280,
  subject: 120,
  reason: 280,
  process: 240,
  automation: 280,
  est_benefit: 240,
  brief: 700,
  followup_1: 500,
  followup_2: 500,
  subject_b: 120,
  demo: 320,
};

/** Trim a string to `max`, cutting at the last word boundary so we don't end mid-word. */
function clampStr(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max - 40 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/**
 * Clamp model output to the schema's field limits BEFORE Zod parse. A model that
 * runs a field one char over its max (common with reason/automation) would
 * otherwise throw and drop a real lead to the generic fallback. We'd rather keep
 * the (good) personalization and trim the overflow.
 */
function coerceToSchema(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  for (const [key, max] of Object.entries(FIELD_MAX)) {
    if (typeof obj[key] === "string") obj[key] = clampStr(obj[key] as string, max);
  }
  if (Array.isArray(obj.services)) {
    obj.services = (obj.services as unknown[])
      .filter((x): x is string => typeof x === "string")
      .slice(0, 4)
      .map((x) => clampStr(x, 100));
  }
  return obj;
}

export type Segment = "trade" | "proserv" | "clinic";

/** Classify a lead's vertical (priced name or query) into a copy segment, so the
 * system prompt pitches the RIGHT automations + pain (a plumber must never be told
 * to think about "patients / recall / treatment-plans"). Defaults to "trade" (the
 * broadest active ICP); medical → "clinic" (parked but kept working). */
export function segmentOf(vertical?: string): Segment {
  const v = (vertical ?? "").toLowerCase();
  if (
    /account|bookkeep|estate|letting|lettings|property manage|broker|mortgage|insuranc|financ|advis|wealth|ifa|solicitor|\blaw\b|legal|conveyanc/.test(
      v,
    )
  )
    return "proserv";
  if (
    /dental|dentist|clinic|physio|chiro|osteo|\bgp\b|medical|doctor|optician|optometr|\bvet|veterinary|fertility|ivf|aesthetic|botox|salon|barber|surgery|practice|hygienist/.test(
      v,
    )
  )
    return "clinic";
  return "trade";
}

// What to pitch, per segment — the single most important fix: the clinic list
// (patients/recall/treatment-plan/intake) misfires on a plumber or an accountant.
const MENU_BLOCK: Record<Segment, string> = {
  trade: `⭐ For the MENU and the main OFFER, PREFER these high-value automations — rarely already in place for a trades/home-services business, and worth real money:
- MISSED-CALL TEXT-BACK (the wedge — usually the single biggest leak): the second a call goes unanswered, auto-text the caller ("sorry we missed you — what's the job + postcode? we'll call you straight back") so they book YOU, not the next number on Google. For TRADES this is NOT saturated — most still don't have it; lead with it unless they clearly already do.
- QUOTE / ESTIMATE FOLLOW-UP: chase every quote that went quiet until they say yes or no — most trades send a price once and never follow up, and the job goes to whoever chased.
- INSTANT WEB-ENQUIRY / "request a quote" reply: answer enquiry forms within seconds, day or night.
- REVIEW ASK after each job: auto-text for a Google review when the work's done — reviews are how the next customer picks you.
- REBOOK / SERVICE REMINDER: nudge past customers for the annual boiler service, gutter clean, or recheck.`,
  proserv: `⭐ For the MENU and the main OFFER, PREFER these high-value automations — rarely already in place for an accountant / agent / broker / adviser, and worth real money:
- INSTANT LEAD RESPONSE & qualify: the first firm to reply to a new enquiry usually wins it — auto-answer and qualify new enquiries in seconds so the client doesn't go to whoever replied first.
- PROPOSAL / FEE-QUOTE FOLLOW-UP: chase sent proposals and quotes that went quiet, until they convert.
- ONBOARDING / DOCUMENT CHASING: automatically collect the paperwork a new client owes (ID, statements, signed engagement letter) so nobody chases by hand.
- MISSED-CALL TEXT-BACK + after-hours capture: never lose an enquiry that rang out.
- RENEWAL / DEADLINE / ANNUAL-REVIEW reminders (tax deadline, policy renewal, mortgage rate end) that bring clients back.`,
  clinic: `⭐ For the MENU (and as alternative offers when an agent doesn't fit), PREFER these LESS-OBVIOUS, higher-value automations — rarely already in place, worth real money:
- REACTIVATION / RECALL: automatically reach out to patients overdue for a check-up, cleaning, eye test or review and get them rebooked — lapsed patients are the biggest untapped revenue and almost nobody automates it
- FILL CANCELLATIONS: when a slot frees up, auto-offer it to a waitlist so last-minute gaps don't sit empty
- TREATMENT-PLAN / QUOTE FOLLOW-UP: gently chase patients given a plan or quote who never booked, until they convert
- NEW-PATIENT INTAKE & FORMS: send and collect medical-history / consent / pre-visit forms automatically, so reception isn't chasing paperwork
- POST-VISIT REVIEWS + feedback: auto-request a Google review after each visit, and catch unhappy feedback privately first
- COMMON-QUESTION handling: answer pricing / insurance / parking / hours questions instantly, day and night
- a simple weekly REPORT of enquiries, bookings, no-shows and who's due a recall

SATURATED — use only as a last resort, NEVER the default: instant text-back to missed calls, basic appointment reminders. Most clinics ALREADY have these, so they make a weak, obvious pitch.`,
};

// A concrete GOOD-hook example the model imitates — must match the segment.
const GOOD_HOOK: Record<Segment, string> = {
  trade: `- GOOD hook example (specific, loss-framed, NO rating): icebreaker "Your site leads with emergency call-outs and free quotes." opener "The calls that ring out while you're on a job just dial the next plumber on Google — that's a booked job gone, and you never even saw it."`,
  proserv: `- GOOD hook example (specific, loss-framed, NO rating): icebreaker "You offer a free first consultation for new clients." opener "A new enquiry usually goes with whoever replies first — a form that comes in at 6pm and sits till morning is often already booked someone else by then."`,
  clinic: `- GOOD hook example (specific, loss-framed, NO rating): icebreaker "Your site pushes Invisalign and free consults hard." opener "The consults that don't book on the day usually go cold — nobody chases them, and an Invisalign case is months of revenue gone quiet."`,
};

// Tone differs: a tradesperson reads on their phone between jobs.
const TONE_LINE: Record<Segment, string> = {
  trade:
    "TONE: the reader is a tradesperson reading on their phone between jobs — short, blunt, plain, even shorter than usual (~50-65 words). No polish; sound like a text from someone who gets their trade.",
  proserv:
    "TONE: the reader is a professional (accountant / agent / broker / adviser) — tight but a touch more considered; one clean specific line beats slang.",
  clinic:
    "TONE: the reader is a busy practice owner/manager — warm, plain, concrete; respect their time.",
};

function buildSystemPrompt(
  outreachLang: string,
  digestLang: string,
  segment: Segment = "trade",
): string {
  const outName = LANG_NAME[outreachLang] ?? "English";
  const digName = LANG_NAME[digestLang] ?? "Russian";
  return `You are a senior consultant for a studio that builds custom AI assistants and automations for small businesses. For each lead you find the SINGLE most valuable thing this business has NOT yet automated — something we can build and sell them — and write a short, plain cold email that sells it.

What we can build — pick the ONE best fit as the main OFFER (the \`automation\` field), then list THREE OTHER automations as the menu (\`services\`). The menu must be 3 DIFFERENT automations, NOT three features of the same agent.

The strongest headline OFFER is usually a smart AGENT — one assistant that does, automatically, the customer-facing thing the business now does by hand:
- a booking / enquiry AGENT that answers and books appointments by itself on the channel their customers actually use — their website chat or phone, or social DMs (Instagram/WhatsApp) where DM-booking is genuinely how that business takes bookings. Describe it as ONE thing ("an agent that takes bookings on your site automatically"), don't stretch it across three menu bullets.

${MENU_BLOCK[segment]}

GROUNDING (no hallucination):
- Use ONLY the company context + DETECTED SIGNALS provided. Never invent facts, numbers, tools, or channels that aren't evidenced.
- State the problem as a FACT from the evidence — NO hedging words ("likely", "probably", "maybe", "скорее всего").
- If you cannot see ONE specific gap from the evidence, do NOT say "unclear" — instead pitch the most popular automation for this SECTOR (from INDUSTRY FACTS) and frame the process as the sector-typical manual task most of these businesses still do by hand. Only set process to "unclear from site" if you have NO idea what the business even is.
- Don't pitch what they ALREADY have (see ALREADY AUTOMATED in the lead). If they already have online booking and a chatbot, find a DIFFERENT gap (missed-call text-back, review collection, no-show reminders, follow-ups, reactivation of past customers). If everything obvious is already automated, lower the fit_score to 1-2.
- GAP-AWARE PITCHING — propose a COMPLEMENT, not a duplicate. If they already run a website chatbot OR a social-DM auto-responder (Instagram/Messenger), that text channel is handled → pitch the thing it does NOT cover: missed PHONE calls, after-hours, no-show reminders, reactivation of past customers, or automatic review collection. Name what they have, then offer the piece that sits alongside it. Never re-sell a channel they already automate.

WHO WE TARGET (ICP — this matters):
- Our customers are SMALL, INDEPENDENT local businesses (≈1-3 locations, owner close to the day-to-day) that have NOT yet automated and want to look modern like bigger competitors. The ideal lead still does things by hand (answers every call themselves, no after-hours cover, no auto follow-up). Small + independent also means our email actually reaches the decision-maker.
- We do NOT target premium/luxury operations, CHAINS or FRANCHISES, or businesses that already run booking + chat + CRM + reviews automation — they already have what we sell AND the email won't reach the owner. If the evidence shows a slick, fully-automated, multi-location/franchise/luxury operation, that is a POOR fit → set fit_score 1-2 and say so in the brief.
- Personalize from BOTH the site AND any social/review evidence in the context: ground the icebreaker in one concrete, real detail (a service they highlight, a recent post, what reviews praise) — never a bare merge-tag. If social/review facts are present, prefer one of those for the icebreaker so the email reads researched, not templated.
- A simple/old/basic website with a phone number and no booking/chat is a GREAT fit, not a bad one — that's a business that would benefit most.

CHANNEL REALISM (very important — pitch only what pays off for THEM):
- A social link (instagram, telegram, facebook in the footer) usually means a MARKETING presence, NOT that customers book or enquire there. Do NOT assume people book via Instagram/Telegram. Only pitch automating a social channel if there's REAL evidence customers use it to enquire/book — e.g. "DM us to book", a WhatsApp click-to-chat button, or an industry where DM-booking is genuinely normal (beauty, aesthetics, barbers, salons, nails, tattoo, restaurants).
- Match the pitch to how customers in THAT industry actually contact the business:
  • Dental / medical / physio / chiro / osteo / private GP / opticians / vets / fertility / dental hygienist / legal / accountants / trades (plumbers, electricians, roofers, HVAC): customers book by PHONE and via the website (form or online booking). The money channel is the phone. This holds EVEN IF the clinic has an active Instagram/Facebook — a social presence is marketing, not the booking channel; do NOT pivot a clinic to an Instagram/DM angle. Their booking channel is the phone + website. For the OFFER, default to a website booking/enquiry AGENT or one of the LESS-OBVIOUS high-value automations (reactivation/recall, fill cancellations, treatment-plan follow-up, intake forms, post-visit reviews) — NOT missed-call text-back (saturated; only if clearly absent).
  • Beauty / aesthetics / med spas / salons / barbers / restaurants: Instagram & WhatsApp DMs ARE often a real booking channel → a social-DM assistant can fit. (Note: these are NOT our cold-email targets — we reach them as an inbound/site service. If you are drafting a cold email, the lead is a clinic/trade/professional from the line above; default to the phone/web gap.)
  • Ecommerce: website chat, email, returns/order questions.
- The problem must be one that costs them REAL money and where the fix clearly pays for itself. If the only "gap" is a channel their customers don't actually use to book, that's a weak pitch — pick the phone/web enquiry gap instead, or lower the fit_score.
- whatsapp signal = a real click-to-chat channel (people do message businesses on WhatsApp). instagram/telegram signals alone = treat as marketing unless evidence says otherwise.

ECONOMICS (make it obviously worth their money):
- Frame the gap as lost MONEY, not lost convenience, using the INDUSTRY FACTS ticket size. E.g. for a dental implant clinic: "with implant cases worth thousands, even one missed enquiry a week is serious money walking to a competitor." For a plumber: "every missed emergency call is a £100–£500 job gone to the next number."
- Use the ticket size qualitatively ("cases worth thousands", "jobs worth hundreds") — do NOT invent precise totals, percentages, or hours saved. The point: one or two recovered customers pays for the whole thing.
- LOSS framing beats gain framing — people feel a loss about twice as hard as an equal gain. Frame around what they're LOSING right now ("the calls going unanswered after 5pm are booking with the next clinic on Google") rather than a generic upside ("get more bookings"). Name the leak, not the dream.

WRITING FOR A NON-TECHNICAL OWNER (critical):
- The owner does NOT know what "automation", "AI agent", "workflow" or "integration" means. Write so a busy shop/clinic owner instantly gets it.
- BANNED words in opener/subject/automation/est_benefit/followups: agentic, workflow, pipeline, LLM, GPT, API, integration, "AI-driven", TypeScript, "solution", "leverage", "streamline", "synergy".
- BANNED sales-speak phrases (fillers that read as machine-written; say the plain thing instead): "walking out the door", "walking to a competitor", "is gold", "hidden revenue", "I'm guessing", "I imagine", "clearly", "showing how much your patients value your care", "drift away", "rest assured", "look no further", "in today's world".
- Describe what it DOES in concrete terms, e.g. "a helper that answers every WhatsApp message and books the slot for you, even after hours" — not "an AI workflow".
- Never call the prospect or their company "small" / "a small business" in the email — it can read as belittling. Say "your business", "your practice/clinic", or "businesses like yours". (The small/independent filter is OUR internal targeting, never client-facing wording.)
- Lead with the pain and the result (e.g. lapsed patients drifting to another clinic; quotes that never got chased; the front desk buried in forms; empty slots after a cancellation), not the technology. Vary the angle to the gap you ACTUALLY found — do NOT default every email to "missed calls". No flattery clichés, no "I hope this finds you well", "I came across your".
- The email must make sense and feel worth a reply on its own — it should sell itself.

STRUCTURE (the shape that gets replies — proven on small-business cold email):
- Order: (1) a specific opening line about THEM, (2) the exact problem it's costing them, (3) the one thing we'd set up to fix it, in plain words, (4) one soft yes/no ask. Pain first, then the fix — never lead with us or the tech.
- 4-5 short lines, lots of white space, reads on a phone in ~15 seconds. Under ~80 words. But NOT a one-liner — an email under ~40 words reads templated and gets ignored; say enough to make the case real.

OPENING LINE (decides if they read on):
- Show you actually looked at a SPECIFIC detail (a service, a page, what a review says) — and vary HOW you open across leads (don't start every email with "Saw…"; a question, a direct observation, or a "most clinics like yours…" frame all work). Convey RESEARCH, not hope.
- BANNED openers (instantly read as a mass-mail and binned): "Loved your post…", "Congrats on…", "I hope you're well", "I came across your website", "As a [role], you…". ALSO BANNED — opening on or praising the RATING / REVIEW COUNT: "your impressive/fantastic/amazing/exceptional 4.9 rating", "your 82 five-star reviews show…", "clearly a busy/well-regarded practice". Praising numbers everyone has = worse than no personalization, and spam filters flag it as sales-speak.
${GOOD_HOOK[segment]}
- ${TONE_LINE[segment]}

THE ASK — exactly ONE soft, binary question (this is the single biggest reply lever):
- One CTA only. Make it a low-friction yes/no they can answer in one word — e.g. "Want me to send a 2-minute example built for {Business}?" or "Worth a look at winning back patients who've drifted off?"
- A reply-or-interest ask beats asking for a meeting by ~2.5x, and a soft ask beats a hard pitch ~3x. Never stack two asks. (Calls are already banned below — the ask is a reply or a sent example, never a call.)

TRUST WITHOUT CASE STUDIES (we're new — no testimonials to lean on):
- Earn it by being SPECIFIC about their exact situation (proves real research) and by REMOVING THEIR RISK: offer to show a short example/video built for them first, so they see it work before deciding anything. No obligation.
- NEVER invent proof — no fake client counts, percentages, "trusted by 100s", or made-up results. Specificity + a free no-risk look is the credibility.

NEVER PROPOSE A CALL OR MEETING. The sender does not take live calls. The only ask is a REPLY (e.g. "reply and I'll send a short example/video"). Banned: "jump on a call", "15-minute call", "hop on a quick call", "book a meeting", "schedule a chat". Offering to SEND a short recorded video or example is fine (it's async).

SHOW A FEW SERVICES (people often don't know what's possible):
- services: exactly 4 short, concrete automations we could set up for THIS business — FOUR DIFFERENT automations, each a separate idea, NOT four features of the main offer/agent (if the offer is a booking agent, the menu lists OTHER things, not "books appointments / answers chat / qualifies leads" — those are all just the agent). Draw from the LESS-OBVIOUS, higher-value list above — e.g. "Win back patients who haven't booked in a while", "Auto-fill last-minute cancellations from a waitlist", "Chase unbooked treatment plans until they convert", "Send & collect new-patient forms before the visit", "Ask for a Google review after each visit". Each <=12 words, plain, no jargon. AVOID the saturated obvious ones (missed-call text-back, basic reminders) unless clearly nothing else fits. Only list channels their customers actually use (don't list Instagram booking for a dentist). NO DUPLICATES: each menu item DIFFERENT from the others AND from the main offer.

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
- icebreaker: ONE concrete, specific observation about THIS business — a service they push, a page, a recent post, or what a review actually SAYS. NOT the star rating or the review COUNT (everyone has those; they prove nothing). <=18 words.
- opener: the implication/cost that FOLLOWS from the icebreaker — what it's quietly costing them. ⚠️ CRITICAL: icebreaker + opener are GLUED into one 2-sentence hook the reader sees, in that order, so the opener must NOT repeat the icebreaker's fact, its number, or its first word ("Saw…"). If the icebreaker named the fact, the opener goes straight to the consequence. Read the two back-to-back before emitting — if the same fact/number/verb appears twice, rewrite. Do NOT introduce yourself; no greeting line. <=22 words.
- subject: <= 50 chars and <= 6 words, lowercase, written like a quick note to a colleague — NOT a marketing headline. Short, specific subjects (often 3-4 words) get the most replies. No emojis, no ALL CAPS, no spammy words ("free", "guarantee", "limited"), no fake "Re:"/"Fwd:". CRITICAL: the subject must reflect the OFFER's actual angle, and must NOT default to "missed call(s)" — use a missed-call subject ONLY if missed calls are genuinely the gap you chose. Otherwise lead the subject with the angle you picked (reactivation/recall, web enquiries, no-shows, treatment-plan follow-up, forms, reviews). Across a batch the subjects must VARY — a subject that would fit any clinic is a weak subject. A subject phrased as a short question often lifts opens — use one when it fits the angle.
- fit_score: 1 (no fit) to 5 (excellent). High when there is a clear unautomated, sellable gap.
- reason: one line justifying the score, grounded in evidence.
- process: the EXACT unautomated, manual thing they do now — stated as fact, naming the channel from the signals. No hedging. If no specific gap is visible, use the sector-typical manual task (see INDUSTRY FACTS) rather than "unclear from site".
- automation: one plain sentence that makes the OFFER unmistakable — name WHAT we'd set up and that it runs AUTOMATICALLY with no work for their team, in their channel. The reader must instantly get what they're being offered. e.g. "We'd set up an assistant that automatically messages patients who haven't been in for a while and offers them a slot — so lapsed patients rebook themselves, hands-off." Not vague ("a system that helps with calls"); concrete, done-for-you, no jargon. DESCRIBE ONLY WHAT WE'D BUILD — do NOT add any ask, reply request, or demo/example offer here ("just reply", "reply yes", "I can send you a demo/example/video"). The email has exactly ONE ask, and it lives in the final line — never repeat it in the offer.
- est_benefit: a concrete owner outcome (e.g. "never miss a booking, less time on the phone, fewer no-shows"). No invented numbers.
- brief: see LANGUAGE above.
- followup_1, followup_2: see FOLLOW-UPS above (offer to SEND an example/video; never a call).
- services: see "SHOW A FEW SERVICES" above.
- subject: the main subject line. subject_b: a SECOND subject on a DIFFERENT angle (e.g. one curiosity-led, one benefit/outcome-led) for A/B testing. Both <=50 chars and <=6 words, lowercase, conversational like a note to a colleague, no emojis/ALL CAPS/spam words.
- demo: ONE concrete, tangible example of the assistant in action for THIS business — the actual message a customer would receive, using the real business name, e.g. "Hi from Smile Dental — it's been a while since your last check-up. Reply BOOK and we'll find you a slot this month." Specific and realistic, in ${outName}. NEVER use bracketed placeholders like [phone number] or [Clinic]; use the real name or just leave that detail out so it reads like a finished message.

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
      minItems: 4,
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
  webContext?: string;
  verticalFacts?: string;
  winnersText?: string;
  segment?: Segment;
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
  // F1: prefer the hub (source of truth — learned on WON across persistent
  // contacts, min-N gated); fall back to the local winners.json (hub down /
  // offline), then empty (cold-start is safe — the prompt has a hardcoded example).
  const hub = await fetchWinners();
  if (hub) {
    winnersCache = hub as Winner[];
    return winnersCache;
  }
  try {
    const w = JSON.parse(await readFile("data/campaign/winners.json", "utf8"));
    winnersCache = Array.isArray(w) ? (w as Winner[]) : [];
  } catch {
    winnersCache = [];
  }
  return winnersCache;
}

function winnersText(winners: Winner[], vertical?: string): string | undefined {
  // F8: only emulate winners from the SAME vertical — a dental opener must not
  // leak into a physio email. If the vertical has no winners yet, return none
  // (the system prompt's hardcoded GOOD example carries the cold-start).
  const scoped = vertical ? winners.filter((w) => w.vertical === vertical) : winners;
  const good = scoped.filter((w) => w.opener).slice(0, 5);
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
  // Cap the per-request context so a single call stays well under the tightest
  // free-tier budget (Groq = 8000 tokens/min). System prompt ≈2.5k tokens; these
  // caps keep the whole request ≈5k, leaving headroom. ~4 chars ≈ 1 token.
  const context = enrichment.ok && enrichment.summary_text
    ? clampStr(enrichment.summary_text, 4500)
    : "(no website context available — write a generic, clean opener and set fit_score <= 2)";
  const signals = enrichment.signals.length > 0 ? enrichment.signals.join(", ") : "(none)";
  const already = existingAutomations(enrichment.signals);
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
      ? `- google rating: ${lead.rating}${lead.reviews !== undefined ? ` from ${lead.reviews} reviews` : ""} (BACKGROUND ONLY — do NOT open the email with the rating or review count, and do NOT praise it; everyone has reviews, so it proves no research. Open on a specific service / page / what a review SAYS instead.)`
      : null,
    "",
    input.verticalFacts ? `${input.verticalFacts}\n` : null,
    `COMPANY CONTEXT (from ${lead.domain}, use ONLY this):`,
    context,
    "",
    input.reviewsText
      ? `REAL GOOGLE REVIEWS (use to spot what customers value and any pain like slow replies / hard to book; reference something specific and TRUE, never quote a made-up review):\n${clampStr(input.reviewsText, 1500)}\n`
      : null,
    input.webContext
      ? `WEB SEARCH CONTEXT (recent news, events, mentions — use naturally if relevant, never fabricate):\n${clampStr(input.webContext, 1000)}\n`
      : null,
    `DETECTED SIGNALS (how they contact customers / book): ${signals}`,
    already.length > 0
      ? `\nALREADY AUTOMATED — they ALREADY HAVE: ${already.join(", ")}. Do NOT pitch any of these; pick a DIFFERENT gap. If they already have most of what we sell, they are NOT our ICP (we target small businesses not yet automated) → set fit_score 1-2.`
      : `\nALREADY AUTOMATED: none detected — good ICP fit (a small business not yet automated).`,
    "",
    `Now: pick the ONE most valuable thing they have NOT automated (use the signals to name the exact channel), state the problem as fact (no hedging), and write the email in plain owner-language with NO jargon. If you cannot pin a specific gap from the evidence, pitch the most popular automation for THIS sector (see INDUSTRY FACTS "Automations that genuinely sell here") and set the process to that sector-typical manual task — do NOT say "unclear from site".`,
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
      "We'd set up an assistant that automatically messages patients who haven't been in for a while and offers them a slot, so lapsed patients rebook themselves — hands-off for your team.",
    est_benefit: "Lapsed patients come back without anyone on your team chasing them.",
    brief,
    followup_1: `Just floating this back to the top of your inbox — happy to show a quick example of what we'd set up for ${lead.company}.`,
    followup_2: `I'll assume the timing isn't right for now — happy to leave the door open if things change.`,
    subject_b: `a quick win for ${lead.company}`,
    demo: "",
    services: [
      "Win back patients who haven't been in for a while",
      "Auto-fill last-minute cancellations from a waitlist",
      "Chase unbooked treatment plans until patients book",
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
  return PersonalizedSchema.parse(coerceToSchema(toolUse.input));
}

function callAnthropic(cfg: AppConfig, input: AiInput): Promise<Personalized> {
  return callAnthropicRaw(
    cfg,
    buildSystemPrompt(input.outreachLang, input.digestLang, input.segment ?? "trade"),
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
 * Any error that means "this key/provider can't serve us right now" — so we
 * should rotate to the next key (and eventually the next provider) rather than
 * give up. Covers rate limits (429), dead/invalid keys (401), exhausted
 * quota/credit (402/403), and provider outages (5xx, overloaded). The whole
 * point: a single bad key must never dead-end the run.
 */
function isKeyError(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  const status = e?.status;
  if (status === 429 || status === 401 || status === 402 || status === 403 || status === 408)
    return true;
  if (typeof status === "number" && status >= 500) return true;
  return /\b(429|401|402|403|5\d\d)\b|rate limit|quota|credit|insufficient|exhausted|overloaded|unavailable|invalid api key|too large/i.test(
    e?.message ?? "",
  );
}

/**
 * A PERSISTENT provider failure — daily quota exhausted, org restricted/banned,
 * invalid/forbidden key, out of credit, or a per-DAY cap. These won't recover
 * within the run, so the provider is circuit-broken (skipped for the rest of it).
 * A plain per-MINUTE 429 rate-limit is NOT persistent (clears in seconds) — we
 * let the next lead retry instead of killing the provider for the whole run.
 */
function isPersistentProviderError(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  if (e?.status === 401 || e?.status === 402 || e?.status === 403) return true;
  return /quota|exceeded your current|organization has been restricted|per[- ]?day|insufficient|out of credit|billing|account.*(suspend|restrict)/i.test(
    e?.message ?? "",
  );
}

/**
 * One call against any OpenAI-compatible endpoint (Groq, Gemini, Cerebras,
 * OpenRouter, OpenAI…). Retries transient 429s, honoring the provider's
 * "try again in Xs" hint when present.
 */
const JSON_KEYS_HINT =
  "Return ONLY a JSON object with keys: opener (string), icebreaker (string), " +
  "subject (string <=50 chars, lowercase), fit_score (integer 1-5), reason (string), " +
  "process (string), automation (string), est_benefit (string), brief (string), " +
  "followup_1 (string), followup_2 (string), subject_b (string), demo (string), " +
  "services (array of 2-4 short strings).";

/**
 * Pull the JSON object out of a model reply. Free models (notably OpenRouter's
 * `gpt-oss-120b:free`) ignore `response_format` and wrap the JSON in a markdown
 * code fence (```json … ``` / ```json5), sometimes with prose around it — a raw
 * JSON.parse then fails and the whole lead falls back. Strip any fence and slice
 * the outermost {…}.
 */
export function extractJsonObject(text: string): string {
  let t = text.trim();
  t = t.replace(/^```[a-z0-9]*\s*/i, ""); // opening fence (```json / ```json5 / ```)
  t = t.replace(/\s*```\s*$/i, ""); // closing fence
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) t = t.slice(first, last + 1);
  return t.trim();
}

/**
 * Escape raw control characters that appear INSIDE string literals (these models
 * often emit literal newlines in a string value → "Bad control character in
 * string literal"). String-aware so structural whitespace between tokens is left
 * untouched. A best-effort repair tried only after a normal parse fails.
 */
export function repairJsonControlChars(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      out += ch;
      continue;
    }
    const code = s.charCodeAt(i);
    if (inStr && code < 0x20) {
      out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Tolerant parse for free-model replies: fence-strip + object-slice, then a
 * control-char repair pass before giving up. */
export function parseModelJson(text: string): unknown {
  const candidate = extractJsonObject(text);
  try {
    return JSON.parse(candidate);
  } catch {
    return JSON.parse(repairJsonControlChars(candidate));
  }
}

// LLM-spend instrumentation: accumulate token usage across a run so prospect can
// emit it to the ops hub (cost-per-lead / unit economics). Cost ≈ 0 on the free
// tiers, but the token VOLUME is the leading indicator before paid Gemini kicks in.
let tokensThisRun = 0;
/** Read the run's accumulated LLM token usage and reset the counter. */
export function drainTokenUsage(): number {
  const t = tokensThisRun;
  tokensThisRun = 0;
  return t;
}

async function callOpenAIRaw(
  cfg: AppConfig,
  system: string,
  userContent: string,
  opts: { apiKeys: (string | undefined)[]; baseURL: string; model: string },
): Promise<Personalized> {
  const keys = opts.apiKeys.length ? opts.apiKeys : [undefined];
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: userContent },
  ];

  // Try every key on a 429 before sleeping: a different key may have quota.
  // Only once we've cycled through all keys do we back off and retry.
  const maxAttempts = Math.max(cfg.LLM_MAX_RETRIES + 1, keys.length);
  const start = keyCursor++; // round-robin: each call begins at the next key
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const apiKey = keys[(start + attempt) % keys.length];
    const client = new OpenAI({ apiKey, baseURL: opts.baseURL });
    try {
      const res = await client.chat.completions.create({
        model: opts.model,
        response_format: { type: "json_object" },
        messages,
      });
      tokensThisRun += res.usage?.total_tokens ?? 0;
      const text = res.choices[0]?.message?.content ?? "";
      let parsed: unknown;
      try {
        parsed = parseModelJson(text);
      } catch (err) {
        throw new Error(`response was not valid JSON: ${(err as Error).message}`);
      }
      return PersonalizedSchema.parse(coerceToSchema(parsed));
    } catch (err) {
      lastErr = err;
      // Rotate to the next key on ANY key/provider error (rate limit, dead key,
      // exhausted quota, outage) — not just 429. A single bad key never stops us.
      if (isKeyError(err) && attempt < maxAttempts - 1) {
        const cycledAllKeys = (attempt + 1) % keys.length === 0;
        // Only BACK OFF for real rate limits (429). Dead/invalid keys (401/402)
        // won't recover by waiting, so just skip to the next key immediately.
        if (cycledAllKeys && isRateLimit(err)) {
          const delay = retryDelayMs(err, attempt);
          console.warn(`[ai] all keys rate-limited, retrying in ${(delay / 1000).toFixed(1)}s…`);
          await sleep(delay);
        } else {
          console.warn(`[ai] key error (${(err as { status?: number }).status ?? "?"}), rotating…`);
        }
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
  opts: { apiKeys: (string | undefined)[]; baseURL: string; model: string },
): Promise<Personalized> {
  const system = buildSystemPrompt(input.outreachLang, input.digestLang, input.segment ?? "trade");
  const userContent = `${buildUserMessage(input)}\n\n${JSON_KEYS_HINT}`;
  return callOpenAIRaw(cfg, system, userContent, opts);
}

/**
 * Keys for the OpenAI-compatible (Gemini) provider. Prefers OPENAI_API_KEYS
 * (comma/space separated) for rotation; falls back to the single OPENAI_API_KEY.
 */
function openaiKeys(cfg: AppConfig): (string | undefined)[] {
  // Gemini keys look like `AQ.Ab8…` (one dot after AQ, then alnum/_/-). Extract
  // every token so any separator the owner pastes by hand works — commas,
  // spaces, or stray trailing periods between keys. Dedup, preserve order.
  const raw = `${cfg.OPENAI_API_KEYS ?? ""} ${cfg.OPENAI_API_KEY ?? ""}`;
  const found = raw.match(/AQ\.[A-Za-z0-9_-]+/g);
  if (found && found.length) return [...new Set(found)];
  return cfg.OPENAI_API_KEY ? [cfg.OPENAI_API_KEY] : [];
}

/**
 * Keys for Groq. Prefers GROQ_API_KEYS (comma/space separated) for rotation on
 * 429; falls back to the single GROQ_API_KEY. Lets us pool several free keys.
 */
function groqKeys(cfg: AppConfig): (string | undefined)[] {
  // Groq keys are `gsk_` + alphanumerics (no dots), so extract every token
  // regardless of how they're separated (commas, spaces, stray periods…) — the
  // owner pastes them by hand and the delimiters vary. Dedup, preserve order.
  const raw = `${cfg.GROQ_API_KEYS ?? ""} ${cfg.GROQ_API_KEY ?? ""}`;
  const found = raw.match(/gsk_[A-Za-z0-9]+/g);
  if (found && found.length) return [...new Set(found)];
  return cfg.GROQ_API_KEY ? [cfg.GROQ_API_KEY] : [];
}

function openrouterKeys(cfg: AppConfig): (string | undefined)[] {
  // OpenRouter keys are `sk-or-v1-` + alphanumerics. Extract every token so any
  // separator the owner pastes works. Dedup, preserve order.
  const raw = `${cfg.OPENROUTER_API_KEYS ?? ""} ${cfg.OPENROUTER_API_KEY ?? ""}`;
  const found = raw.match(/sk-or-v1-[A-Za-z0-9]+/g);
  if (found && found.length) return [...new Set(found)];
  return cfg.OPENROUTER_API_KEY ? [cfg.OPENROUTER_API_KEY] : [];
}

interface OAProvider {
  name: "groq" | "openai" | "openrouter";
  apiKeys: (string | undefined)[];
  baseURL: string;
  model: string;
}

/**
 * The FREE OpenAI-compatible providers to try, in order, with keys. When the
 * current provider exhausts every key (all rate-limited / dead / out of quota),
 * we fall through to the next provider so the run never dead-ends. Anthropic is
 * deliberately NOT in this chain (it costs money — owner's call only). Only
 * providers that actually have a key are included.
 */
/**
 * Per-RUN circuit breaker. Once a provider has exhausted its WHOLE key pool
 * (daily quota / org restriction — not a one-off blip), stop trying it for every
 * subsequent lead: re-trying N dead keys × every lead burns ~N wasted requests
 * per lead against the SAME (often shared-project) quota, accelerating the wall
 * and grinding the run. Module-level, so it resets each process (one CLI run).
 */
const deadProviders = new Set<string>();

/**
 * Round-robin cursor across a provider's key pool. Rotation used to always start
 * at key[0], so key[0]'s project absorbed every successful call and hit its daily
 * free quota first while the other keys idled. Starting each call at the next key
 * spreads load evenly → N separate free projects give ~N× the daily headroom.
 */
let keyCursor = 0;

function freeProviderChain(cfg: AppConfig): OAProvider[] {
  const gemini: OAProvider = {
    name: "openai",
    apiKeys: openaiKeys(cfg),
    baseURL: cfg.OPENAI_BASE_URL,
    model: cfg.OPENAI_MODEL,
  };
  const groq: OAProvider = {
    name: "groq",
    apiKeys: groqKeys(cfg),
    baseURL: "https://api.groq.com/openai/v1",
    model: cfg.GROQ_MODEL,
  };
  const openrouter: OAProvider = {
    name: "openrouter",
    apiKeys: openrouterKeys(cfg),
    baseURL: "https://openrouter.ai/api/v1",
    model: cfg.OPENROUTER_MODEL,
  };
  // Primary two ordered by LLM_PROVIDER; OpenRouter is the final free fallback
  // (kicks in when Gemini is at its daily quota and Groq is down/banned).
  const ordered =
    cfg.LLM_PROVIDER === "groq" ? [groq, gemini, openrouter] : [gemini, groq, openrouter];
  return ordered.filter((p) => p.apiKeys.some(Boolean) && !deadProviders.has(p.name));
}

function providerCall(cfg: AppConfig, system: string, userContent: string): Promise<Personalized> {
  if (cfg.LLM_PROVIDER === "groq") {
    return callOpenAIRaw(cfg, system, `${userContent}\n\n${JSON_KEYS_HINT}`, {
      apiKeys: groqKeys(cfg),
      baseURL: "https://api.groq.com/openai/v1",
      model: cfg.GROQ_MODEL,
    });
  }
  if (cfg.LLM_PROVIDER === "openai") {
    return callOpenAIRaw(cfg, system, `${userContent}\n\n${JSON_KEYS_HINT}`, {
      apiKeys: openaiKeys(cfg),
      baseURL: cfg.OPENAI_BASE_URL,
      model: cfg.OPENAI_MODEL,
    });
  }
  return callAnthropicRaw(cfg, system, userContent);
}

const CRITIQUE_RUBRIC = `You are a strict reviewer of a cold email a colleague drafted. Improve it ONLY where it fails a check; otherwise keep it essentially as-is. Checks:
1. CHANNEL FIT: does the pitch match how this industry actually books (see INDUSTRY FACTS)? If it pitches a channel customers don't book through (e.g. an Instagram booking bot for a dentist), REWRITE it to the real money channel (usually phone/web for clinics, trades, legal).
2. MONEY: is the cost framed in real money using the ticket size (qualitatively)? If not, add it.
3. TIGHT: first email ~40-80 words, 4-5 short lines, plain owner-language, no banned jargon, problem stated as fact (no hedging). Pain before fix. Tighten if bloated; if it's a thin one-liner, add the missing piece (the cost or the fix). Exactly ONE soft yes/no ask — never a call, never two asks.
4. GROUNDED: nothing invented — only the provided context. No fabricated proof (client counts, %, "trusted by…"). Remove anything unverifiable.
5. OPENING: a specific, researched first line ("Saw [real fact] — [implication]"), NOT flattery ("loved your post", "congrats"). SUBJECT <=50 chars, <=6 words, lowercase, not spammy.
6. HUMAN (anti-AI-tell): it must read like a busy person typed it, not marketing. Strip em-dashes, rule-of-three lists, negative parallelism ("not X, but Y"), and tell-words ("delve", "elevate", "seamless", "robust", "streamline", "leverage", "in today's fast-paced"). Kill any templated opener ("I hope this finds you", "I came across your"). Prefer contractions and plain words.
Keep the language rules. Return the full corrected object via the emit_personalization tool (all fields), even fields you didn't change.`;

async function selfCritique(
  cfg: AppConfig,
  input: AiInput,
  draft: Personalized,
): Promise<Personalized> {
  const system = `${buildSystemPrompt(input.outreachLang, input.digestLang, input.segment ?? "trade")}\n\n${CRITIQUE_RUBRIC}`;
  const userContent =
    `${buildUserMessage(input)}\n\nCURRENT DRAFT (review against the checks, fix only what fails):\n` +
    JSON.stringify(draft);
  return providerCall(cfg, system, userContent);
}

export interface PersonalizationResult {
  personalized: Personalized;
  provider: "anthropic" | "groq" | "openai" | "openrouter" | "fallback";
}

export async function personalize(
  cfg: AppConfig,
  lead: DiscoveredLead,
  enrichment: Enrichment,
  icpNote?: string,
  reviewsText?: string,
  webContext?: string,
): Promise<PersonalizationResult> {
  const vertical = await matchVertical(
    `${lead.discovery_query ?? ""} ${lead.company} ${enrichment.title ?? ""} ${enrichment.summary_text.slice(0, 400)}`,
  );
  // Filter few-shot winners by the SAME vertical key the funnel/hub use
  // (verticalFromQuery == contacts.industry), not the priced matchVertical name,
  // so winner.vertical and the lead's key agree (F8).
  const wt = winnersText(await loadWinners(), verticalFromQuery(lead.discovery_query));
  const input: AiInput = {
    ourOffer: cfg.OUR_OFFER,
    lead,
    enrichment,
    outreachLang: cfg.OUTREACH_LANG,
    digestLang: cfg.DIGEST_LANG,
    verticalFacts: verticalFacts(vertical),
    segment: segmentOf(lead.discovery_query),
    ...(icpNote ? { icpNote } : {}),
    ...(reviewsText ? { reviewsText } : {}),
    ...(webContext ? { webContext } : {}),
    ...(wt ? { winnersText: wt } : {}),
  };
  let provider: PersonalizationResult["provider"] =
    cfg.LLM_PROVIDER === "groq" ? "groq" : cfg.LLM_PROVIDER === "openai" ? "openai" : "anthropic";
  try {
    let personalized: Personalized;
    if (cfg.LLM_PROVIDER === "anthropic") {
      personalized = await callAnthropic(cfg, input);
    } else {
      // Try each free provider in order; the first one with a working key wins.
      // If a provider exhausts ALL its keys, fall through to the next provider
      // (Gemini ↔ Groq) so a key/quota wall never dead-ends the run.
      const chain = freeProviderChain(cfg);
      let got: Personalized | undefined;
      let lastErr: unknown;
      for (const p of chain) {
        try {
          got = await callOpenAICompatible(cfg, input, {
            apiKeys: p.apiKeys,
            baseURL: p.baseURL,
            model: p.model,
          });
          provider = p.name;
          break;
        } catch (err) {
          lastErr = err;
          if (isPersistentProviderError(err)) {
            deadProviders.add(p.name); // quota/ban → skip for the rest of the run
            console.warn(
              `[ai] provider ${p.name} down for ${lead.domain} (${(err as Error).message.slice(0, 80)}) — skipping it for the rest of this run`,
            );
          } else {
            console.warn(
              `[ai] provider ${p.name} failed for ${lead.domain} (${(err as Error).message.slice(0, 80)}), trying next…`,
            );
          }
        }
      }
      if (!got) throw lastErr ?? new Error("no free provider available");
      personalized = got;
    }

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
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
  // Same resilience as the structured path: rotate keys on ANY key error and
  // fall through the free provider chain (Gemini ↔ Groq). Otherwise, when one
  // provider is down (rate-limited / restricted), every translation silently
  // fails and the digest + Mini App lose the Russian text.
  const chain = freeProviderChain(cfg);
  let lastErr: unknown;
  for (const p of chain) {
    const keys = p.apiKeys.length ? p.apiKeys : [undefined];
    const maxAttempts = Math.max(cfg.LLM_MAX_RETRIES + 1, keys.length);
    const start = keyCursor++; // round-robin start so keys deplete evenly
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const client = new OpenAI({ apiKey: keys[(start + attempt) % keys.length], baseURL: p.baseURL });
      try {
        const res = await client.chat.completions.create({ model: p.model, messages });
        tokensThisRun += res.usage?.total_tokens ?? 0;
        return (res.choices[0]?.message?.content ?? "").trim();
      } catch (err) {
        lastErr = err;
        if (isKeyError(err) && attempt < maxAttempts - 1) {
          if (isRateLimit(err) && (attempt + 1) % keys.length === 0)
            await sleep(retryDelayMs(err, attempt));
          continue;
        }
        break; // non-key error or keys exhausted → fall through to next provider
      }
    }
    // circuit-break ONLY on a persistent failure (quota/ban) — a transient
    // per-minute rate-limit must not kill the provider for the whole run.
    if (isPersistentProviderError(lastErr)) deadProviders.add(p.name);
  }
  throw lastErr ?? new Error("no free provider available for generateText");
}

/**
 * Translate an already-written email into the operator's language for the
 * digest, so they can read exactly what's going out. Faithful translation only
 * — no rewriting, no added/removed content. Returns "" on failure (the digest
 * just shows the original then).
 */
export async function translate(
  cfg: AppConfig,
  text: string,
  targetLang = "Russian",
): Promise<string> {
  if (!text.trim()) return "";
  const system = `You are a professional translator. Translate the user's text into ${targetLang}, faithfully and naturally. Keep the meaning, tone and line breaks. Do NOT add, remove, explain or comment — output ONLY the translation. Keep the sender's name/signature and any URLs as-is.`;
  try {
    return await generateText(cfg, system, text);
  } catch {
    return "";
  }
}

export interface ReplyContext {
  company: string;
  ourOffer: string;
  pitchedProcess?: string;
  pitchedAutomation?: string;
  theirReply: string;
}

/**
 * Draft a suggested response to a prospect's reply, for the operator to review
 * and send by hand (never auto-sent). Must read like a real person typed it —
 * no AI tells — and NEVER propose a call (the sender doesn't take live calls).
 */
export async function suggestReply(cfg: AppConfig, ctx: ReplyContext): Promise<string> {
  const lang = LANG_NAME[cfg.OUTREACH_LANG] ?? "English";
  const system = `You help a small AI-automation studio reply to a prospect who responded to a cold email. Write the reply the operator will send by hand.

Sound like a real person typing a quick reply on their phone — natural and a little informal, NOT polished marketing copy. Avoid anything that reads as AI-written: no "I hope this email finds you well", no "Furthermore/Moreover/Additionally", no neatly balanced three-part sentences, no bullet lists, no em-dash pile-ups, no corporate filler. Use contractions. One small imperfection is fine.

Keep it short (<=80 words), warm, plain language — no jargon ("workflow/API/agentic/leverage/solution"). Answer their actual question honestly (e.g. a rough price range, how it works); if you don't know, say you'll send a quick example or the details.

NEVER propose a call, meeting or "quick chat" — the sender does not take live calls. The only ask is a reply, or offering to SEND a short recorded example/video (async). Banned: "jump on a call", "15-minute call", "hop on a quick call", "book a meeting", "schedule a chat".

COMMON OBJECTIONS — answer the one they actually raised, briefly and without pushiness:
- "How much / what's the price?": give an honest ballpark in plain terms (it depends on what they want, most setups are a small one-off to get going plus a low monthly to keep it running), and offer to send a short example tailored to them so the price has context. Don't quote a hard figure you can't stand behind.
- "We already have a system / receptionist / booking tool": acknowledge it genuinely, don't argue. Point at the gap that tool usually leaves (e.g. after-hours and missed calls still go unanswered; web enquiries still wait) and offer to show a quick example of just that piece — it sits alongside what they have, doesn't replace it.
- "Send me more info / not now / busy": keep it easy — say you'll send a short example they can look at whenever, no pressure, and leave the door open. Never guilt-trip or chase.
- "Not interested / remove me": one short, gracious line confirming you won't follow up. Nothing else.
Pick the single best fit; never dump all four.

Write in ${lang}. Output ONLY the reply body — no subject, no signature. Greet by the real name or skip the greeting; never use bracketed placeholders like [name].`;
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
