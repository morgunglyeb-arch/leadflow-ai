import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import type { OutputRow } from "./types";
import { assembleSequence } from "./outreach";

const cfg = {
  SENDER_SIGNATURE: "Opero · opero-studio.com",
  OPT_OUT_TEXT: "Not relevant? Reply 'no' and I won't follow up.",
  CALL_TO_ACTION: "If that'd be useful, just reply. No call needed.",
  STUDIO_INTRO: "We're Opero, a studio that sets up automations for small businesses.",
  SERVICES_INTRO: "A few things we could set up for you:",
  SHOW_SERVICES_MENU: true,
} as unknown as AppConfig;

const row = (domain: string): OutputRow =>
  ({
    company: "Bright Smile Dental",
    domain,
    icebreaker: "Noticed you still take bookings by phone.",
    automation: "missed-call text-back",
    services: [
      "Auto text-back to every missed call",
      "Instant replies to website enquiries",
      "Automatic reminders to cut no-shows",
    ],
    followup_1: "Just floating this back up.",
    followup_2: "Last note from me.",
  }) as unknown as OutputRow;

const firstLine = (s: string): string => s.split("\n")[0] ?? "";

describe("assembleSequence greeting variation (anti-fingerprint)", () => {
  it("одна и та же первая строка (greeting) в initial и обоих фоллоуапах — консистентность треда", () => {
    const seq = assembleSequence(row("brightsmile.co.uk"), cfg);
    const g = firstLine(seq.initial);
    expect(firstLine(seq.followup_1)).toBe(g);
    expect(firstLine(seq.followup_2)).toBe(g);
    expect(g).toMatch(/Bright Smile Dental/);
  });

  it("разные домены дают РАЗНЫЕ варианты greeting (детерминированно по домену)", () => {
    const domains = ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com", "g.com", "h.com"];
    const greetings = new Set(domains.map((d) => firstLine(assembleSequence(row(d), cfg).initial)));
    expect(greetings.size).toBeGreaterThanOrEqual(2);
  });

  it("один домен → один и тот же greeting на повторных сборках (детерминизм)", () => {
    const a = firstLine(assembleSequence(row("smileclinic.co.uk"), cfg).initial);
    const b = firstLine(assembleSequence(row("smileclinic.co.uk"), cfg).initial);
    expect(a).toBe(b);
  });

  it("opt-out присутствует в каждом фоллоуапе", () => {
    const seq = assembleSequence(row("brightsmile.co.uk"), cfg);
    expect(seq.followup_1).toContain(cfg.OPT_OUT_TEXT);
    expect(seq.followup_2).toContain(cfg.OPT_OUT_TEXT);
  });

  it("первое письмо: идентичность студии + меню услуг + подпись Opero/сайт", () => {
    const seq = assembleSequence(row("brightsmile.co.uk"), cfg);
    expect(seq.initial).toContain("We're Opero");
    expect(seq.initial).toContain(cfg.SERVICES_INTRO);
    expect(seq.initial).toContain("• Instant replies to website enquiries");
    expect(seq.initial).toContain(`— ${cfg.SENDER_SIGNATURE}`);
  });

  it("меню не дублирует строку-оффер (automation уже в теле)", () => {
    const seq = assembleSequence(row("brightsmile.co.uk"), cfg);
    // 'missed-call text-back' is the offer line; the near-identical service
    // 'Auto text-back to every missed call' stays (different wording), but no
    // bullet should be a verbatim repeat of the offer sentence.
    expect(seq.initial).not.toContain("• Missed-call text-back");
  });
});
