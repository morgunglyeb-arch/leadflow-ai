import { describe, expect, it } from "vitest";
import { classifyReply, isHardOptOut, isStopReply, isBounce } from "./classify";

describe("classifyReply — intent priority (F7)", () => {
  it("⭐ price curiosity BEATS a soft 'no thanks' — not a permanent ban", () => {
    // THE bug: "no thanks" matched before the price question → not_interested →
    // irreversible suppress. A money-curious lead must read as interested.
    expect(classifyReply("No thanks, but how much would it even cost?")).toBe("interested");
    expect(classifyReply("not really interested... what's the ballpark price though?")).toBe(
      "interested",
    );
  });

  it("explicit interest signals → interested", () => {
    expect(classifyReply("Yes, tell me more")).toBe("interested");
    expect(classifyReply("sounds good, what's the pricing?")).toBe("interested");
    expect(classifyReply("can you send me an example?")).toBe("interested");
  });

  it("⭐ ignores the QUOTED original — a bare 'No' with our email below is NOT interested", () => {
    // THE 2026-07-04 bug: the reply "No" + Gmail-quoted original ("…happy to send a
    // 2-minute example…") matched the positive regex on OUR OWN words → "interested".
    const quoted =
      "No\n\nOn Sat, 4 Jul 2026, 13:02 Emma Walsh <emma@opero-team.com> wrote:\n" +
      "Hi Perfect Install team, Happy to send a 2-minute video showing the exact text...";
    expect(classifyReply(quoted)).toBe("soft_decline");
    expect(classifyReply("no\n--- Regards, Daniel\n> our pitch here happy to help")).toBe(
      "soft_decline",
    );
  });

  it("⭐ a 'No' followed by an email SIGNATURE reads as decline, not 'unclear'", () => {
    // Replies trail a signature the quote-strip can't remove; the whole-text length
    // guard missed them → "unclear". The OPENER (before the sig/phone) is a bare no.
    expect(
      classifyReply("No Ben Haulkham Quills Mobile: 07876 501044 Website: www.quillswills.com"),
    ).toBe("soft_decline");
    expect(classifyReply("no --- Regards, Daniel Crathorne. 01527 758 974 Unit 9")).toBe(
      "soft_decline",
    );
    expect(classifyReply("no Paul Smith Associates Tel. 01278 427678")).toBe("soft_decline");
    // …but a curious "No idea, can you explain?" must NOT be forced to a decline.
    expect(classifyReply("No idea what you mean, can you explain what this does?")).toBe("unclear");
  });

  it("a bare soft 'no' (no opt-out request) → soft_decline, NOT not_interested", () => {
    expect(classifyReply("No thanks, we're good")).toBe("soft_decline");
    expect(classifyReply("not interested, thanks")).toBe("soft_decline");
    expect(classifyReply("not for us")).toBe("soft_decline");
  });

  it("an EXPLICIT opt-out → not_interested (must be suppressed)", () => {
    expect(classifyReply("please unsubscribe me")).toBe("not_interested");
    expect(classifyReply("remove me from your list")).toBe("not_interested");
    expect(classifyReply("stop emailing me")).toBe("not_interested");
    expect(classifyReply("do not contact me again")).toBe("not_interested");
  });

  it("objections stay objections (handled, not banned)", () => {
    expect(classifyReply("we already have a system for this")).toBe("objection");
    expect(classifyReply("maybe later, too busy right now")).toBe("objection");
  });

  it("auto-replies are auto (do NOT stop the sequence)", () => {
    expect(classifyReply("I am out of office until Monday")).toBe("auto");
    expect(isStopReply("auto")).toBe(false);
  });

  it("every genuine human reply stops the sequence", () => {
    for (const s of ["interested", "soft_decline", "not_interested", "objection", "unclear"] as const) {
      expect(isStopReply(s)).toBe(true);
    }
  });
});

describe("isHardOptOut — narrow, only explicit opt-outs", () => {
  it("true only for explicit stop-contacting phrasing", () => {
    expect(isHardOptOut("unsubscribe")).toBe(true);
    expect(isHardOptOut("take me off your list")).toBe(true);
    expect(isHardOptOut("don't email me")).toBe(true);
  });
  it("false for a soft decline (no permanent ban from 'no thanks')", () => {
    expect(isHardOptOut("no thanks, not interested")).toBe(false);
    expect(isHardOptOut("not for us right now")).toBe(false);
  });
});

describe("isBounce", () => {
  it("detects delivery failures by sender + body", () => {
    expect(isBounce("mailer-daemon@googlemail.com", "")).toBe(true);
    expect(isBounce("someone@x.com", "Your message wasn't delivered")).toBe(true);
    expect(isBounce("a@clinic.co.uk", "thanks, sounds interesting")).toBe(false);
  });
});
