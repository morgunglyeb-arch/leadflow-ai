import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import type { OutputRow } from "./types";
import { assembleSequence, assembleDraft, assembleDraftRu, CLINIC_MENU, CLINIC_MENU_RU } from "./outreach";

const cfg = {
  SENDER_SIGNATURE: "Opero · opero-studio.com",
  OPT_OUT_TEXT: "Not relevant? Reply 'no' and I won't follow up.",
  CALL_TO_ACTION: "If that'd be useful, just reply. No call needed.",
  STUDIO_INTRO: "We're Opero, a studio that sets up automations for businesses.",
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

  it("первое письмо: идентичность студии + курируемое меню + подпись Opero/сайт", () => {
    const seq = assembleSequence(row("brightsmile.co.uk"), cfg);
    expect(seq.initial).toContain("We're Opero");
    expect(seq.initial).toContain(cfg.SERVICES_INTRO);
    expect(seq.initial).toContain(`• ${CLINIC_MENU[0]}`); // headline agent offer
    expect(seq.initial).toContain(`— ${cfg.SENDER_SIGNATURE}`);
  });
});

describe("RU review body — fixed menu RU, hook translated separately", () => {
  it("uses the FIXED CLINIC_MENU_RU (not an LLM mistranslation) + the passed hook", () => {
    const ru = assembleDraftRu(row("brightsmile.co.uk"), cfg, "Заметил, что вы продвигаете импланты.");
    expect(ru).toContain(`• ${CLINIC_MENU_RU[0]}`);
    expect(ru).toContain("Дожимаем неоплаченные планы лечения до записи");
    expect(ru).toContain("Заметил, что вы продвигаете импланты."); // translated hook spliced in
    expect(ru).toContain(`— ${cfg.SENDER_SIGNATURE}`);
    expect(ru).not.toMatch(/преследовани/i); // the bad "chase"→stalking translation
    expect(ru).not.toContain(CLINIC_MENU[3]); // not the English menu line
  });
});

describe("opt-out в карточке ревью (== реальному письму)", () => {
  it("assembleDraft заканчивается строкой opt-out — карточка байт-в-байт равна письму", () => {
    const body = assembleDraft(row("brightsmile.co.uk"), cfg).body;
    expect(body).toContain(cfg.OPT_OUT_TEXT);
    expect(body.trim().endsWith(cfg.OPT_OUT_TEXT)).toBe(true);
  });

  it("initial содержит opt-out ровно ОДИН раз (нет дубля после фикса)", () => {
    const seq = assembleSequence(row("brightsmile.co.uk"), cfg);
    const occurrences = seq.initial.split(cfg.OPT_OUT_TEXT).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("курируемый список — один список из 5, без отдельного абзаца-оффера", () => {
  it("рендерит ровно все 5 пунктов CLINIC_MENU и НЕ выдумывает из row.services", () => {
    const r = {
      ...row("x.co.uk"),
      automation: "Auto text-back to every missed call",
      services: ["Some model-invented thing", "Another one"],
    } as unknown as OutputRow;
    const body = assembleDraft(r, cfg).body;
    const bullets = body.split("\n").filter((l) => l.startsWith("• "));
    expect(bullets).toHaveLength(CLINIC_MENU.length);
    expect(body).toContain(`• ${CLINIC_MENU[0]}`);
    expect(body).not.toContain("model-invented"); // model services are ignored
  });
  it("нет отдельной строки-оффера: 'We're Opero' стоит прямо перед списком", () => {
    const body = assembleDraft(row("brightsmile.co.uk"), cfg).body;
    const intro = body.indexOf("We're Opero");
    const menu = body.indexOf(cfg.SERVICES_INTRO);
    // intro paragraph is immediately followed by the menu (no offer sentence between)
    expect(body.slice(intro, menu)).not.toMatch(/missed call|book/i);
  });
});

describe("единый формат: меню есть у всех (нет короткого режима)", () => {
  it("меню присутствует на разных доменах (одинаковый формат для всех)", () => {
    for (const d of ["a.co.uk", "b.co.uk", "c.co.uk", "d.co.uk", "e.co.uk"]) {
      expect(assembleDraft(row(d), cfg).body).toContain(cfg.SERVICES_INTRO);
    }
  });
});

describe("site-CTA в follow-up #1 (ссылка НЕ в первом письме)", () => {
  const siteCfg = {
    ...cfg,
    SITE_CTA_ENABLED: true,
    SITE_URL: "opero-studio.com",
    SITE_CTA_LINE: "Faster way: go to {site}, type your trade, see what fits.",
  } as unknown as AppConfig;

  it("первое письмо без ссылки на сайт", () => {
    const seq = assembleSequence(row("brightsmile.co.uk"), siteCfg);
    expect(seq.initial).not.toContain("opero-studio.com/"); // no site link in touch 1
    expect(seq.initial).not.toContain("go to opero-studio.com");
  });

  it("follow-up #1 = приглашение на сайт-движок со ссылкой", () => {
    const seq = assembleSequence(row("brightsmile.co.uk"), siteCfg);
    expect(seq.followup_1).toContain("opero-studio.com");
    expect(seq.followup_1).toContain("type your trade");
  });
});
