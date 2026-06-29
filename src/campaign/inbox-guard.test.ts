import { describe, it, expect } from "vitest";
import { evaluateInboxGuard, inboxSamples } from "./inbox-guard.js";
import type { CampaignState, CampaignLead } from "./store.js";

const cfg = {
  INBOX_GUARD_ENABLED: true,
  INBOX_BOUNCE_PAUSE_RATE: 0.06,
  INBOX_BOUNCE_MIN_SENT: 20,
  INBOX_PAUSE_DAYS: 2,
} as unknown as Parameters<typeof evaluateInboxGuard>[3];

// Build a state whose leads are pinned to `inbox`: `sent` of them have step>=1,
// of which `bounces` are status "bounced" (the rest "sent").
function stateWith(inbox: string, sent: number, bounces: number): CampaignState {
  const leads: Record<string, CampaignLead> = {};
  for (let i = 0; i < sent; i++) {
    leads[`d${i}.com`] = {
      inbox,
      step: 1,
      status: i < bounces ? "bounced" : "sent",
    } as unknown as CampaignLead;
  }
  return { warmup_day: 5, leads, inbox_pauses: {} };
}

const NONE = new Set<string>();
const NOW = new Date("2026-06-29T12:00:00Z");

describe("inboxSamples", () => {
  it("counts lifetime sent and bounces per inbox", () => {
    const s = stateWith("emma@opero-team.com", 25, 3);
    const [sample] = inboxSamples(s, ["emma@opero-team.com"]);
    expect(sample).toEqual({ inbox: "emma@opero-team.com", sent: 25, bounces: 3 });
  });
});

describe("evaluateInboxGuard", () => {
  it("pauses an inbox whose bounce rate exceeds the threshold", () => {
    const s = stateWith("emma@opero-team.com", 20, 3); // 15% > 6%
    const r = evaluateInboxGuard(s, ["emma@opero-team.com"], NONE, cfg, NOW);
    expect(r.pausedNow.map((p) => p.inbox)).toEqual(["emma@opero-team.com"]);
    expect(r.activePaused.has("emma@opero-team.com")).toBe(true);
    const until = new Date(s.inbox_pauses!["emma@opero-team.com"].until).getTime();
    expect(until).toBe(NOW.getTime() + 2 * 86_400_000); // INBOX_PAUSE_DAYS
  });

  it("does NOT pause below the minimum sample size", () => {
    const s = stateWith("emma@opero-team.com", 10, 3); // 30% but only 10 sent (<20)
    const r = evaluateInboxGuard(s, ["emma@opero-team.com"], NONE, cfg, NOW);
    expect(r.pausedNow).toHaveLength(0);
    expect(r.activePaused.size).toBe(0);
  });

  it("does NOT pause an acceptable bounce rate", () => {
    const s = stateWith("emma@opero-team.com", 40, 1); // 2.5% < 6%
    const r = evaluateInboxGuard(s, ["emma@opero-team.com"], NONE, cfg, NOW);
    expect(r.pausedNow).toHaveLength(0);
  });

  it("pauses a blacklisted domain regardless of bounce rate", () => {
    const s = stateWith("jack@withopero.com", 5, 0); // clean, tiny sample
    const r = evaluateInboxGuard(s, ["jack@withopero.com"], new Set(["withopero.com"]), cfg, NOW);
    expect(r.pausedNow[0]?.reason).toMatch(/DNSBL/);
    expect(r.activePaused.has("jack@withopero.com")).toBe(true);
  });

  it("auto-resumes a pause once it expires", () => {
    const s = stateWith("emma@opero-team.com", 0, 0);
    s.inbox_pauses = { "emma@opero-team.com": { until: "2026-06-28T00:00:00Z", reason: "old" } };
    const r = evaluateInboxGuard(s, ["emma@opero-team.com"], NONE, cfg, NOW);
    expect(r.resumedNow).toEqual(["emma@opero-team.com"]);
    expect(r.activePaused.size).toBe(0);
    expect(s.inbox_pauses!["emma@opero-team.com"]).toBeUndefined();
  });

  it("does not re-pause or extend an already-paused inbox", () => {
    const s = stateWith("emma@opero-team.com", 50, 20); // 40% — would pause
    const future = "2026-07-10T00:00:00Z";
    s.inbox_pauses = { "emma@opero-team.com": { until: future, reason: "existing" } };
    const r = evaluateInboxGuard(s, ["emma@opero-team.com"], NONE, cfg, NOW);
    expect(r.pausedNow).toHaveLength(0);
    expect(s.inbox_pauses!["emma@opero-team.com"].until).toBe(future); // untouched
    expect(r.activePaused.has("emma@opero-team.com")).toBe(true);
  });

  it("when disabled, adds no new pauses but still auto-resumes expired ones", () => {
    const disabled = { ...cfg, INBOX_GUARD_ENABLED: false } as typeof cfg;
    const s = stateWith("emma@opero-team.com", 50, 20); // would breach
    s.inbox_pauses = { "old@x.com": { until: "2026-06-01T00:00:00Z", reason: "expired" } };
    const r = evaluateInboxGuard(s, ["emma@opero-team.com"], NONE, disabled, NOW);
    expect(r.pausedNow).toHaveLength(0);
    expect(r.resumedNow).toEqual(["old@x.com"]);
  });
});
