import { describe, expect, it } from "vitest";
import type { OutputRow } from "./types";
import { isKnownChain, roiScore } from "./prospect";

const mk = (over: Partial<OutputRow>): OutputRow =>
  ({ company: "X", domain: "x.co.uk", fit_score: 5, ...over }) as unknown as OutputRow;

describe("roiScore — ранг независимости, не размера", () => {
  it("маленький независимый (личная почта, owner_run) обгоняет крупного (дженерик почта, тысячи отзывов, уже автоматизирован)", () => {
    const independent = mk({
      signals: "owner_run|phone_booking",
      email: "drsmith@bright.co.uk",
      reviews: 120,
    });
    const big = mk({
      signals: "online_booking|has_review_tool",
      email: "service@bigchain.com",
      reviews: 2000,
    });
    expect(roiScore(independent)).toBeGreaterThan(roiScore(big));
  });

  it("огромное число отзывов мягко понижает ранг (а не исключает)", () => {
    const huge = mk({ email: "info@a.co.uk", reviews: 5000 });
    const normal = mk({ email: "info@a.co.uk", reviews: 150 });
    expect(roiScore(huge)).toBeLessThan(roiScore(normal));
  });

  it("личная почта ценится выше дженерик-ящика", () => {
    const personal = mk({ email: "john@a.co.uk", reviews: 100 });
    const generic = mk({ email: "reception@a.co.uk", reviews: 100 });
    expect(roiScore(personal)).toBeGreaterThan(roiScore(generic));
  });
});

describe("isKnownChain — national UK brands (anti-ICP)", () => {
  it("ловит сети по названию (то, что пропускал multi_site)", () => {
    expect(isKnownChain("CREATE Fertility Southampton", "createfertility.co.uk")).toBe(true);
    expect(isKnownChain("Specsavers Opticians", "specsavers.co.uk")).toBe(true);
    expect(isKnownChain("Vets4Pets Bridgwater", "vets4pets.com")).toBe(true);
    expect(isKnownChain("London Women's Clinic Cambridge", "londonwomensclinic.com")).toBe(true);
  });
  it("ловит сеть по домену (односложные бренды) даже при чистом названии", () => {
    expect(isKnownChain("The Optical Place", "specsavers.co.uk")).toBe(true);
    expect(isKnownChain("Town Vets", "medivet.co.uk")).toBe(true);
  });
  it("НЕ ловит независимых (упоминание бренда на сайте ≠ имя)", () => {
    expect(isKnownChain("Orrell Opticians", "orrellopticians.co.uk")).toBe(false);
    expect(isKnownChain("Bright Smile Dental", "brightsmile.co.uk")).toBe(false);
  });
});
