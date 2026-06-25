import { describe, expect, it } from "vitest";
import { spamLint } from "./spamlint";

describe("spamLint — AI-tell safety nets (hook dup + flattery)", () => {
  it("flags a repeated 4-word phrase (the icebreaker+opener dup bug)", () => {
    const dup =
      "Saw your impressive 4.9 rating from 164 reviews. Strand Dental has an impressive 4.9 rating from 164 reviews — every plan is gold.";
    expect(spamLint(dup).hits).toContain("repeated phrase (hook dup)");
  });
  it("flags opening that praises the rating/review count", () => {
    expect(spamLint("Saw your fantastic 82 five-star reviews").hits).toContain(
      "flattery-on-reviews opener",
    );
  });
  it("clean, varied hook is not flagged for dup/flattery", () => {
    const clean =
      "Your site pushes Invisalign and free consults hard. Those consults that don't book on the day usually go cold and nobody chases them.";
    const hits = spamLint(clean).hits;
    expect(hits).not.toContain("repeated phrase (hook dup)");
    expect(hits).not.toContain("flattery-on-reviews opener");
  });
});

describe("spamLint", () => {
  it("ловит классические спам-триггеры и помечает risky", () => {
    const r = spamLint("FREE!! ACT NOW — guaranteed income, click here");
    expect(r.score).toBeGreaterThanOrEqual(2);
    expect(r.risky).toBe(true);
    expect(r.hits).toContain('"free"');
  });

  it("чистый человеческий текст не флагается", () => {
    const r = spamLint(
      "Hi Sarah, noticed your clinic still takes bookings by phone — happy to share how a couple of dentists automated missed-call follow-ups.",
    );
    expect(r.risky).toBe(false);
    expect(r.score).toBeLessThan(2);
  });

  it("score = числу совпавших паттернов, hits без дублей", () => {
    const r = spamLint("amazing incredible breakthrough");
    // все три ловятся одним паттерном «hype» → один хит
    expect(r.hits.length).toBe(r.score);
  });
});
