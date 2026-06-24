import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import { hunterKeys } from "./verify-email";

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
