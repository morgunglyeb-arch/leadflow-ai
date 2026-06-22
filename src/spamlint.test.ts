import { describe, expect, it } from "vitest";
import { spamLint } from "./spamlint";

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
