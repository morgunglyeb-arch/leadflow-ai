import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config";
import { type WarmupState, warmupDailyTarget } from "./warmup";

const cfg = {
  WARMUP_DAILY: 2,
  WARMUP_DAILY_MAX: 8,
  WARMUP_RAMP_DAYS: 21,
} as unknown as AppConfig;
const st = (day: number): WarmupState => ({ day, sent: {} });

describe("warmupDailyTarget (линейный рамп WARMUP_DAILY → WARMUP_DAILY_MAX)", () => {
  it("день 1 = WARMUP_DAILY", () => expect(warmupDailyTarget(st(1), cfg)).toBe(2));
  it("последний день рампа = WARMUP_DAILY_MAX", () => expect(warmupDailyTarget(st(21), cfg)).toBe(8));
  it("за рампом не превышает MAX", () => expect(warmupDailyTarget(st(40), cfg)).toBe(8));
  it("середина рампа лежит строго между границами", () => {
    const mid = warmupDailyTarget(st(11), cfg);
    expect(mid).toBeGreaterThan(2);
    expect(mid).toBeLessThan(8);
  });
});
