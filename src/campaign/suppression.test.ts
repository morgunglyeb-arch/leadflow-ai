import { describe, expect, it } from "vitest";
import { isSuppressed } from "./suppression.js";

// The suppression list is the compliance backstop: anyone who opted out or hard-
// bounced must NEVER be emailed again. These guard the matching logic.
describe("isSuppressed", () => {
  const set = new Set(["opted-out.com", "stop@example.com"]);

  it("suppresses a listed domain", () => {
    expect(isSuppressed(set, "opted-out.com")).toBe(true);
  });

  it("suppresses a listed email regardless of domain", () => {
    expect(isSuppressed(set, "other.com", "stop@example.com")).toBe(true);
  });

  it("is case-insensitive on both domain and email", () => {
    expect(isSuppressed(set, "OPTED-OUT.COM")).toBe(true);
    expect(isSuppressed(set, "other.com", "STOP@Example.com")).toBe(true);
  });

  it("does NOT suppress an address that isn't listed", () => {
    expect(isSuppressed(set, "fresh.com", "hi@fresh.com")).toBe(false);
  });

  it("treats domain and email independently (no false positive on partial match)", () => {
    // email listed, but a different lead at a non-listed domain must still send
    expect(isSuppressed(set, "fresh.com", "different@fresh.com")).toBe(false);
  });
});
