import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { sendStep } from "./run.js";
import type { CampaignLead } from "./store.js";

// §5 — the most expensive failure class is "send when we shouldn't" (sending with
// the gate off, or replaying an already-sent lead). This pins the enforcement point:
// sendStep must NOT send (and must not mutate the lead toward "sent") when its live
// gate is false. No network is touched on these paths.
function lead(overrides: Partial<CampaignLead> = {}): CampaignLead {
  return {
    domain: "example.co.uk",
    company: "Example Clinic",
    email: "hi@example.co.uk",
    status: "queued",
    step: 0,
    score: 1,
    history: [],
    emails: {
      initial: "Hi — I had a quick idea for your front desk and wanted to share it.",
      followup_1: "Just following up on my earlier note.",
      followup_2: "Last note from me on this.",
    },
    snapshot: {},
    ...overrides,
  };
}

describe("send gate (§5)", () => {
  it("does NOT send and does NOT mark the lead sent when live=false", async () => {
    const l = lead();
    const sent = await sendStep({} as AppConfig, l, "initial", false);
    expect(sent).toBe(false);
    expect(l.status).toBe("queued"); // unchanged — nothing left the building
    expect(l.step).toBe(0);
  });

  it("never sends a lead with an empty body (even when live=true)", async () => {
    const l = lead({ emails: { initial: "", followup_1: "", followup_2: "" } });
    const sent = await sendStep({} as AppConfig, l, "initial", true);
    expect(sent).toBe(false);
    expect(l.status).toBe("queued");
  });
});
