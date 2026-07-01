import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import { hunterKeys, normalizeEmail } from "./verify-email";

describe("normalizeEmail — recover scrape artifacts", () => {
  it("URL-decodes a %20-prefixed mailto artifact into a clean address", () => {
    expect(normalizeEmail("%20info@sjwplumbing.co.uk")).toBe("info@sjwplumbing.co.uk");
    expect(normalizeEmail("%20hello@arkdentistry.co.uk")).toBe("hello@arkdentistry.co.uk");
  });
  it("trims whitespace and strips wrapping <>/quotes, lowercases", () => {
    expect(normalizeEmail("  Info@Example.COM ")).toBe("info@example.com");
    expect(normalizeEmail("<jane@example.com>")).toBe("jane@example.com");
  });
  it("returns the clean address for already-valid input (idempotent)", () => {
    expect(normalizeEmail("info@example.com")).toBe("info@example.com");
  });
  it("returns '' for anything without a salvageable address", () => {
    expect(normalizeEmail("not-an-email")).toBe("");
    expect(normalizeEmail("")).toBe("");
  });
  it("drops Cloudflare/obfuscation hex-hash localparts (machine junk → hard bounce)", () => {
    expect(normalizeEmail("e42ae442664e4360b7809c127fb93618@leepaccountants.co.uk")).toBe("");
    // but a short hex-ish real localpart is fine
    expect(normalizeEmail("abc123@example.com")).toBe("abc123@example.com");
  });
});

const HEX_A = "a".repeat(40);
const HEX_B = "b".repeat(40);

describe("hunterKeys — tolerant multi-key parse", () => {
  it("extracts 40-hex keys from HUNTER_API_KEYS regardless of separator", () => {
    expect(hunterKeys({ HUNTER_API_KEYS: `${HEX_A}, ${HEX_B}` } as AppConfig)).toEqual([
      HEX_A,
      HEX_B,
    ]);
    expect(hunterKeys({ HUNTER_API_KEYS: `${HEX_A}\n${HEX_B}` } as AppConfig)).toEqual([
      HEX_A,
      HEX_B,
    ]);
  });

  it("merges the legacy HUNTER_API_KEY and dedupes", () => {
    const keys = hunterKeys({ HUNTER_API_KEY: HEX_A, HUNTER_API_KEYS: `${HEX_A} ${HEX_B}` } as AppConfig);
    expect(keys).toEqual([HEX_A, HEX_B]);
  });

  it("returns [] when no key is set", () => {
    expect(hunterKeys({} as AppConfig)).toEqual([]);
  });
});
