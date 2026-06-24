import { describe, expect, it } from "vitest";
import { detectMultiSite, detectSignals } from "./enrich";

describe("detectMultiSite", () => {
  it("flags a 3-location clinic by enumerated 'Location 3' marker", () => {
    const text =
      "London Fertility Clinic. Location 1 - W1G 8YP, London. Location 2 - WD6 3BS, London. Location 3 - W1G 9PF, London.";
    expect(detectMultiSite(text)).toBe(true);
    expect(detectSignals(text)).toContain("multi_site");
  });

  it("flags 3+ distinct UK postcodes even without 'Location N' wording", () => {
    expect(detectMultiSite("Visit us at W1G 8YP, WD6 3BS or N1 7GU.")).toBe(true);
  });

  it("does NOT flag a single-site independent (one postcode)", () => {
    const text = "Bright Smile Dental, 12 High Street, SW1A 1AA. Open Mon–Fri.";
    expect(detectMultiSite(text)).toBe(false);
    expect(detectSignals(text)).not.toContain("multi_site");
  });

  it("does NOT flag a 2-site medium business (owner rule: 1–2 sites still qualify)", () => {
    const text = "Our practice has two locations: SW1A 1AA and EC1A 1BB.";
    expect(detectMultiSite(text)).toBe(false);
  });
});
