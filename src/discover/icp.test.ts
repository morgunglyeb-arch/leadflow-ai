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

  it("с cities: кросс-произведение вертикаль × город", () => {
    const q = expandQueries(base({ cities: ["Carlisle", "Hereford"] }));
    expect(q.map((x) => x.full)).toEqual([
      "dental clinics in Carlisle",
      "dental clinics in Hereford",
      "opticians in Carlisle",
      "opticians in Hereford",
    ]);
  });

  it("пустой/пробельный город игнорируется → fallback на location", () => {
    const q = expandQueries(base({ cities: ["  ", ""] }));
    expect(q[0]?.full).toBe("dental clinics in United Kingdom");
  });
});
