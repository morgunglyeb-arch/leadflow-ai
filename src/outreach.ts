import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config.js";
import type { OutputRow } from "./types.js";

export interface EmailDraft {
  to?: string;
  subject: string;
  body: string;
}

export interface EmailSequence {
  to?: string;
  subject: string;
  initial: string;
  followup_1: string;
  followup_2: string;
}

/**
 * Full sendable bodies for the 3-touch sequence (greeting + content + opt-out +
 * signature). Used by the autonomous campaign sender.
 */
export function assembleSequence(row: OutputRow, cfg: AppConfig): EmailSequence {
  const greet = greeting(row.company, seedFrom(row.domain));
  const sig = `— ${cfg.SENDER_SIGNATURE}`;
  const initialDraft = assembleDraft(row, cfg);
  // append a one-line opt-out to the first touch (compliance + deliverability)
  const initial = `${initialDraft.body}\n\n${cfg.OPT_OUT_TEXT}`;
  const fu = (text: string): string => `${greet}\n\n${text}\n\n${cfg.OPT_OUT_TEXT}\n\n${sig}`;
  // Follow-up #1 = the site self-serve invite (link kept OUT of the first touch).
  // Falls back to the AI-written nudge when the site CTA is disabled.
  const siteCta = cfg.SITE_CTA_ENABLED
    ? (cfg.SITE_CTA_LINE ?? "").replace("{site}", cfg.SITE_URL ?? "")
    : "";
  const fu1Body = siteCta || row.followup_1;
  return {
    ...(row.email ? { to: row.email } : {}),
    subject: initialDraft.subject,
    initial,
    followup_1: fu1Body ? fu(fu1Body) : "",
    followup_2: row.followup_2 ? fu(row.followup_2) : "",
  };
}

/**
 * Stable per-lead seed from the domain. The same lead always varies the same
 * way, so a thread's follow-ups keep ONE consistent greeting, while different
 * leads (and so an inbox's stream) don't all share a byte-identical skeleton.
 */
function seedFrom(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Greeting addresses the BUSINESS, not a person — the recipient often isn't the
 * named contact, so a wrong first name hurts. We use a tidy short company name.
 * The template is varied deterministically per lead (`seed`) so the same phrase
 * doesn't prefix every single send — a templated-mail / fingerprint tell that
 * hurts deliverability when one inbox streams identical skeletons.
 */
function greeting(company: string, seed = 0): string {
  const short = company
    .split(/[-–—|,:]/)[0]
    ?.replace(/\b(ltd|limited|llp|inc|llc)\b\.?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!short || short.length < 2) {
    const bare = ["Hello,", "Hi there,", "Hi,"];
    return bare[seed % bare.length]!;
  }
  const named = [
    `Hi ${short} team,`,
    `Hello ${short} team,`,
    `Hi there at ${short},`,
    `Hi ${short},`,
  ];
  return named[seed % named.length]!;
}

function capitalize(s: string): string {
  const t = s.trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function stripTrailingPunct(s: string): string {
  return s.trim().replace(/[.!;,\s]+$/, "");
}

/**
 * Anti-duplicate guard. The email has exactly ONE call-to-action (the final CTA
 * line: "go to the site, or reply and we'll advise you"). The model sometimes
 * also tacks an ask onto the OFFER sentence ("…and I can send you a demo, just
 * reply yes"), which double-asks. Cut any such trailing ask clause from a line
 * so the only ask is the CTA. Deterministic, so it runs even with self-critique
 * off — this is the "no dupes in future" safety net.
 */
function stripEmbeddedAsk(s: string): string {
  const cut = s.replace(
    /[\s,;:—–-]+(?:and\s+|so\s+|then\s+)?(?:just\s+)?(?:reply|respond|get in touch|let me know|message me|i['’]?(?:ll| can| will)\s+send|i can send you|happy to send|we(?:'| a)?ll send|send(?:ing)?\s+you\s+a\s+(?:short\s+|quick\s+)?(?:demo|example|video|sample))\b.*$/i,
    "",
  );
  return cut.trim();
}

/**
 * Assemble a full, ready-to-review cold email from the AI fields. The pitch
 * (process → automation → benefit) is the body's spine; nothing here invents
 * facts — it only arranges what the model already grounded in the site text.
 * One unified format for every lead: hook → who-we-are + offer → services menu
 * → sales-y site CTA → signature.
 */
export function assembleDraft(row: OutputRow, cfg: AppConfig): EmailDraft {
  const subject = row.subject ?? `quick idea for ${row.company}`;
  const lines: string[] = [];
  lines.push(greeting(row.company, seedFrom(row.domain)));
  lines.push("");

  // Body shape (owner spec): personalized hook FIRST (earns the read), then a
  // one-line "who we are" so it's clear we're an automation studio, then the one
  // concrete offer, then a short menu of what else we could set up, then one soft
  // ask, then the Opero + site signature. The hook must stay first — leading with
  // the self-intro reads as mass-mail and buries the reason they'd reply.
  const observation = [row.icebreaker, row.opener]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s))
    .join(" ");
  if (observation) {
    lines.push(observation);
    lines.push("");
  }

  // Who we are + the one concrete, done-for-you offer, together as one short para.
  // Strip any ask the model embedded in the offer — the only ask is the CTA.
  const offerSrc = row.automation || row.services?.[0] || "";
  const offer = offerSrc ? `${capitalize(stripTrailingPunct(stripEmbeddedAsk(offerSrc)))}.` : "";
  const intro = (cfg.STUDIO_INTRO ?? "").trim();
  if (intro || offer) {
    lines.push([intro, offer].filter(Boolean).join(" "));
    lines.push("");
  }

  // Short menu of suitable automations so the owner sees the range up front.
  // Kept to 3 concrete, plain items; we drop the one already used as the offer
  // line. Items are added only while the body stays under MAX_BODY_WORDS, so a
  // verbose offer can't push the email out of the high-reply zone (keeps every
  // email roughly the same length).
  const services = (row.services ?? [])
    .map((s) => stripTrailingPunct(s))
    .filter(Boolean)
    .filter((s) => !offer || capitalize(s) + "." !== offer)
    .slice(0, 3);
  const servicesIntro = cfg.SERVICES_INTRO ?? "A few things we could set up for you:";
  // The menu is a REQUIRED part of every email (owner-locked format) — always
  // show it (up to 3 bullets) when we have services. NO word-cap gating: an
  // earlier cap silently dropped the menu whenever the hook/offer ran long,
  // which is most leads — that's the "I don't see the menu" bug.
  if (cfg.SHOW_SERVICES_MENU && services.length >= 2) {
    lines.push(servicesIntro);
    for (const s of services) lines.push(`• ${capitalize(s)}`);
    lines.push("");
  }

  lines.push((cfg.CALL_TO_ACTION ?? "").replace("{site}", cfg.SITE_URL ?? ""));
  lines.push("");
  lines.push(`— ${cfg.SENDER_SIGNATURE}`);

  return {
    ...(row.email ? { to: row.email } : {}),
    subject,
    body: lines.join("\n"),
  };
}

function draftMarkdown(row: OutputRow, draft: EmailDraft, cfg: AppConfig): string {
  const meta = [
    `**Company:** ${row.company}`,
    `**Domain:** ${row.domain}`,
    row.name ? `**Contact:** ${row.name}${row.role ? ` (${row.role})` : ""}` : "",
    draft.to
      ? `**To:** ${draft.to}${row.email_source === "site" ? " _(found on site)_" : ""}`
      : "**To:** _(no email — find before sending)_",
    row.phone ? `**Phone:** ${row.phone}` : "",
    `**Fit:** ${row.fit_score ?? "?"} / 5 · **Status:** ${row.status}`,
    `**Source:** ${row.discovery_source}${row.discovery_query ? ` · "${row.discovery_query}"` : ""}`,
    row.signals ? `**Signals:** ${row.signals}` : "",
  ]
    .filter(Boolean)
    .join("  \n");

  const briefBlock = row.brief ? `\n> **Разбор:** ${row.brief}\n` : "";

  const greet = greeting(row.company, seedFrom(row.domain));
  // Mirror the real cadence + opt-out so the preview == what actually sends —
  // including the site self-serve invite that REPLACES the AI nudge in FU#1.
  const days = cfg.FOLLOWUP_GAP_DAYS.split(",").map((s) => Number.parseInt(s.trim(), 10));
  const siteCta = cfg.SITE_CTA_ENABLED
    ? (cfg.SITE_CTA_LINE ?? "").replace("{site}", cfg.SITE_URL ?? "")
    : "";
  const followups = [siteCta || row.followup_1, row.followup_2]
    .map((f, i) => {
      if (!f) return "";
      return `\n---\n\n**Follow-up ${i + 1}** _(send ~${days[i]} days later if no reply — same thread, subject "Re: ${draft.subject}")_\n\n${greet}\n\n${f}\n\n${cfg.OPT_OUT_TEXT}\n\n— ${cfg.SENDER_SIGNATURE}`;
    })
    .join("\n");

  const altSubject = row.subject_b ? `**Subject (B-variant):** ${row.subject_b}\n\n` : "";
  const demoBlock = row.demo
    ? `\n💬 **Example to show them** (drop into your reply): _${row.demo}_\n`
    : "";

  return `# Draft — ${row.company}

${meta}
${briefBlock}${demoBlock}
---

### Email 1 — initial

**Subject:** ${draft.subject}

${altSubject}${draft.body}

${cfg.OPT_OUT_TEXT}
${followups}
`;
}

const DRAFT_CSV_COLUMNS = [
  "status",
  "company",
  "domain",
  "name",
  "role",
  "email",
  "phone",
  "fit_score",
  "discovery_source",
  "process",
  "automation",
  "est_benefit",
  "subject",
] as const;

function csvEscape(v: unknown): string {
  if (v === undefined || v === null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function domainSlug(domain: string): string {
  return domain.replace(/[^a-z0-9.]+/gi, "_");
}

export interface DraftsResult {
  count: number;
  dir: string;
  csv: string;
}

export async function writeDrafts(cfg: AppConfig, rows: OutputRow[]): Promise<DraftsResult> {
  await mkdir(cfg.DRAFTS_DIR, { recursive: true });
  // The queue mirrors this run — clear stale .md drafts from previous runs.
  try {
    const stale = (await readdir(cfg.DRAFTS_DIR)).filter((f) => f.endsWith(".md"));
    await Promise.all(stale.map((f) => rm(join(cfg.DRAFTS_DIR, f), { force: true })));
  } catch {
    /* dir was empty/new */
  }
  for (const row of rows) {
    const draft = assembleDraft(row, cfg);
    const path = join(cfg.DRAFTS_DIR, `${domainSlug(row.domain)}.md`);
    await writeFile(path, draftMarkdown(row, draft, cfg), "utf8");
  }

  const header = DRAFT_CSV_COLUMNS.join(",");
  const body = rows
    .map((r) => DRAFT_CSV_COLUMNS.map((c) => csvEscape(r[c as keyof OutputRow])).join(","))
    .join("\n");
  await mkdir(dirname(cfg.DRAFTS_CSV_PATH), { recursive: true });
  await writeFile(cfg.DRAFTS_CSV_PATH, "﻿" + header + "\n" + body + "\n", "utf8");

  return { count: rows.length, dir: cfg.DRAFTS_DIR, csv: cfg.DRAFTS_CSV_PATH };
}
