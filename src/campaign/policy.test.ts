import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config";
import type { CampaignState } from "./store";
import { coldRampReady, followupGaps, warmupCap } from "./policy";

describe("coldRampReady (cold-ramp гейт за прогревом)", () => {
  it("WARMUP_ENABLED=false → НЕ гейтит (true) — осознанный fail-open; в run есть громкий warn", () => {
    const cfg = { WARMUP_ENABLED: false, WARMUP_COLD_AFTER_DAYS: 7 } as unknown as AppConfig;
    expect(coldRampReady(cfg, 1)).toBe(true);
  });

  it("warmup ON + день < порога → держит холодные касания (false)", () => {
    const cfg = { WARMUP_ENABLED: true, WARMUP_COLD_AFTER_DAYS: 7 } as unknown as AppConfig;
    expect(coldRampReady(cfg, 3)).toBe(false);
  });

  it("warmup ON + день >= порога → пускает (true)", () => {
    const cfg = { WARMUP_ENABLED: true, WARMUP_COLD_AFTER_DAYS: 7 } as unknown as AppConfig;
    expect(coldRampReady(cfg, 7)).toBe(true);
    expect(coldRampReady(cfg, 14)).toBe(true);
  });
});

describe("warmupCap (линейный рамп с потолком SEND_DAILY_CAP)", () => {
  const cfg = {
    SEND_WARMUP_START: 10,
    SEND_WARMUP_STEP: 2,
    SEND_DAILY_CAP: 25,
  } as unknown as AppConfig;
  const st = (day: number): CampaignState => ({ warmup_day: day, leads: {} });

  it("день 1 = SEND_WARMUP_START", () => expect(warmupCap(st(1), cfg)).toBe(10));
  it("растёт на STEP в день", () => expect(warmupCap(st(3), cfg)).toBe(14));
  it("упирается в SEND_DAILY_CAP", () => expect(warmupCap(st(50), cfg)).toBe(25));
});

describe("followupGaps", () => {
  it("парсит '3,10' → [3, 10]", () => {
    expect(followupGaps({ FOLLOWUP_GAP_DAYS: "3,10" } as unknown as AppConfig)).toEqual([3, 10]);
  });

  it("отбрасывает мусор и неположительные", () => {
    expect(followupGaps({ FOLLOWUP_GAP_DAYS: "3, x, -1, 10" } as unknown as AppConfig)).toEqual([
      3, 10,
    ]);
  });
});
