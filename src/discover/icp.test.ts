import { describe, expect, it } from "vitest";
import { expandQueries, type IcpConfig } from "./icp";

const base = (over: Partial<IcpConfig>): IcpConfig =>
  ({
    location: "United Kingdom",
    segments: [{ market: "local_smb", queries: ["dental clinics", "opticians"] }],
    ...over,
  }) as IcpConfig;

describe("expandQueries — geo by city", () => {
  it("без cities: один общенациональный запрос на вертикаль (старое поведение)", () => {
    const q = expandQueries(base({}));
    expect(q.map((x) => x.full)).toEqual([
      "dental clinics in United Kingdom",
      "opticians in United Kingdom",
    ]);
  });

  it("с cities: кросс-произведение вертикаль × город, с привязкой к стране (location)", () => {
    const q = expandQueries(base({ cities: ["Carlisle", "Hereford"] }));
    expect(q.map((x) => x.full)).toEqual([
      "dental clinics in Carlisle, United Kingdom",
      "dental clinics in Hereford, United Kingdom",
      "opticians in Carlisle, United Kingdom",
      "opticians in Hereford, United Kingdom",
    ]);
  });

  it("привязка к стране отсекает ambiguous US-тёзки (Washington UK ≠ Washington DC)", () => {
    const q = expandQueries(base({ cities: ["Washington"] }));
    expect(q[0]?.full).toBe("dental clinics in Washington, United Kingdom");
  });

  it("пустой/пробельный город игнорируется → fallback на location", () => {
    const q = expandQueries(base({ cities: ["  ", ""] }));
    expect(q[0]?.full).toBe("dental clinics in United Kingdom");
  });
});
