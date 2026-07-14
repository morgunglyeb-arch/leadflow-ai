import type { ReplyRecord } from "./store.js";

/**
 * Classify a reply snippet by sentiment. Heuristic (no LLM call): replies are
 * short and routing only needs to (a) always stop the sequence and (b) tag the
 * reply so the digest + learning loop know what landed.
 */
/**
 * An EXPLICIT legal opt-out (PECR/GDPR/CAN-SPAM): we must stop AND permanently
 * suppress. Kept narrow on purpose — only unambiguous "stop contacting me"
 * phrasing. A soft "no thanks" is NOT a hard opt-out (see classifyReply →
 * soft_decline): it stops the sequence but does not earn a permanent ban
 * without the operator confirming. (F7: a false permanent suppress is
 * irreversible, so the bar for it is high.)
 */
export function isHardOptOut(snippet: string): boolean {
  return /(unsubscribe|remove me|take me off|stop emailing|stop contacting|do ?n[o']?t (contact|email|message)|piss off|fuck off)/.test(
    snippet.toLowerCase(),
  );
}

/**
 * Keep ONLY the new reply, above any quoted original. Critical: a bare "No" with
 * OUR own email quoted below ("…happy to send a 2-minute example…") otherwise
 * matches the positive regex on OUR words and reads as "interested" (real bug,
 * Perfect Install LTD 2026-07-04). Cut at the earliest quote / signature marker.
 */
export function topReply(text: string): string {
  const markers = [
    /\n?On\b.{0,160}\bwrote:/i, // Gmail: "On Sat, 4 Jul 2026, 13:02 X wrote:"
    /-{3,}\s*Original Message\s*-{3,}/i,
    /\n_{5,}/, // Outlook separator
    /\nFrom:\s/i, // Outlook quoted header
    /\n\s*>/, // quoted ">" lines
    /\nSent from my /i,
  ];
  let cut = text.length;
  for (const m of markers) {
    const i = text.search(m);
    if (i >= 0 && i < cut) cut = i;
  }
  const top = text.slice(0, cut).trim();
  return top || text.trim(); // never return empty
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

/**
 * From a holiday / out-of-office auto-reply, extract the date they say they'll be
 * BACK — so follow-ups pause only until then, not a blind 2 weeks. Requires a
 * return cue ("back / until / returning …"): a standing auto-responder with NO
 * return date returns null, so those keep their normal follow-up (owner's rule:
 * many auto-replies are permanent, not holidays). Returns the day AFTER the stated
 * return, or null if nothing parseable / not within a sane future window.
 */
export function parseReturnDate(snippet: string, now: Date = new Date()): Date | null {
  const s = topReply(snippet);
  if (!/\b(back|return(ing)?|until|till|reachable again|in the office)\b/i.test(s)) return null;

  const build = (day: number, mon: number, year?: number): Date | null => {
    if (!(day >= 1 && day <= 31) || !(mon >= 0 && mon <= 11)) return null;
    const y = year ?? now.getUTCFullYear();
    let d = new Date(Date.UTC(y, mon, day));
    if (year === undefined && d.getTime() < now.getTime() - 86_400_000) {
      d = new Date(Date.UTC(y + 1, mon, day)); // no year given + already passed → next year
    }
    return d;
  };

  let d: Date | null = null;
  let m = s.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?/i,
  );
  if (m) d = build(Number(m[1]), MONTHS[(m[2] ?? "").toLowerCase()] ?? -1, m[3] ? Number(m[3]) : undefined);
  if (!d) {
    m = s.match(
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i,
    );
    if (m) d = build(Number(m[2]), MONTHS[(m[1] ?? "").toLowerCase()] ?? -1, m[3] ? Number(m[3]) : undefined);
  }
  if (!d) {
    m = s.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/); // UK day-first DD/MM[/YY]
    if (m) {
      let y = m[3] ? Number(m[3]) : undefined;
      if (y !== undefined && y < 100) y += 2000;
      d = build(Number(m[1]), Number(m[2]) - 1, y);
    }
  }
  if (!d) return null;
  const ms = d.getTime() - now.getTime();
  if (ms <= 0 || ms > 180 * 86_400_000) return null; // must be future + within ~6 months
  return new Date(d.getTime() + 86_400_000); // resume the day AFTER they're back
}

export function classifyReply(snippet: string): ReplyRecord["sentiment"] {
  const s = topReply(snippet).toLowerCase();
  // Out-of-office / auto-responders: broad net so a holiday auto-reply is NEVER
  // treated as a human answer (no owner ping, no follow-up decision made off it).
  if (
    /(out of (the )?office|automatic reply|auto-?reply|autoreply|this is an? (automated|automatic)|do not reply to this|no-?reply|away from (my|the)|annual leave|on (annual )?leave\b|on holiday|on vacation|currently (away|out of the office|on leave|on holiday|on annual leave)|away until|out of the office until|be back (on|in)|will be back|returning (on|to the office)|limited access to (my )?e-?mail|will not be (monitored|checking)|unable to (access|respond to) (my )?e-?mails?|office (is )?closed|we are (currently )?closed|maternity leave|paternity leave|public holiday|bank holiday|thank you for your e-?mail\.? i am|в отпуске|автоответ|не в офисе|нахожусь в отпуске)/.test(
      s,
    )
  ) {
    return "auto";
  }
  // Form-acknowledgement / autoresponder templates: a submission confirmation, a
  // "we'll be in touch" promise, or an office-hours footer is NEVER a human answer.
  // These slipped through before — Arkwright's form-ack ("Thank you for submitting
  // your information … one of our representatives will be in contact") read as
  // "unclear" AND drafted a reply; Residential Mortgage Hub's office-hours footer
  // ("Working hours:- Monday to Friday …") read as a soft "no".
  if (
    /(thank(s| you)?[^.!]{0,40}for (submitting|contacting|your (enquiry|inquiry|submission|interest|message|request|e-?mail|details|information))|(we have|we've) received your (enquiry|inquiry|message|request|e-?mail|submission|details|information)|your (enquiry|inquiry|message|request|e-?mail|submission) has been received|one of (our|the) (team|representatives|advis[eo]rs|colleagues|agents|staff)[^.!]{0,50}(be in (contact|touch)|contact you|get back to you|reach out)|(will|we'?ll) be in (contact|touch) with you (shortly|soon|as soon as|in due course)|(working|office|opening|business) hours\s*[:\-]|for appointments (please )?use|use the following links?)/.test(
      s,
    )
  ) {
    return "auto";
  }
  // Explicit opt-out wins outright (must be honored + suppressed).
  if (isHardOptOut(s)) {
    return "not_interested";
  }
  // F7: a price/interest signal BEATS a soft decline so "no thanks, but how much
  // would it even cost?" reads as interested — not a permanent ban. Checked
  // BEFORE the decline bucket on purpose. A bare "interested" only counts when
  // it isn't negated ("not interested" must NOT read as interest).
  const positive =
    /(\byes\b|sounds good|tell me more|how much|pricing|\bprice\b|\bcost\b|quote|ballpark|\bbook\b|let'?s talk|\bkeen\b|when can|go ahead|happy to|send (me )?(an? )?(example|info|details))/;
  const negatedInterest = /\bnot (really |very )?interested\b/.test(s);
  if (positive.test(s) || (/\binterested\b/.test(s) && !negatedInterest)) {
    return "interested";
  }
  if (/(already have|we use|not right now|maybe later|too expensive|no budget|in-house|do this ourselves|busy)/.test(s)) {
    return "objection";
  }
  // Soft decline: a clear "no" WITHOUT an explicit opt-out request. Stops the
  // sequence but routes to the soft bucket — the operator confirms before any
  // permanent suppression.
  if (/(no thanks|no thank you|not interested|not for us|we'?re good|all set|no need)/.test(s)) {
    return "soft_decline";
  }
  // A bare "no"/"nope"/"nah" opening the reply is a decline, not "unclear". Real
  // replies often trail a SIGNATURE ("No\nBen Haulkham\nQuills\nMobile: 07876…") that
  // the quote-strip doesn't remove, so a length<=40 guard on the WHOLE text missed
  // them (→ "unclear"). Instead take just the OPENER — up to the first newline,
  // signature marker, contact detail, or UK phone number — and test that. Positive /
  // objection signals were already checked above, so reaching here + a leading "no"
  // is a genuine decline. ("no, but how much?" was caught as interested earlier.)
  const opener =
    s
      .split(
        /\n|-{2,}|\bregards\b|\bthanks\b\s*[,.]|\b(?:tel|mobile|phone|mob|email|website|fax)\b\s*[:.]|\b0\d[\d ]{7,}/i,
      )[0]
      ?.trim() ?? s;
  if (/^\W*(no|nope|nah)\b/.test(opener) && opener.length <= 40) {
    return "soft_decline";
  }
  return "unclear";
}

/**
 * Bucket WHY a negative reply said no, so the brain can learn "segment X rejects
 * because they already have a tool / it's too dear / bad timing" — the only market
 * feedback we get from cold. Heuristic (no LLM): reply snippets are short. Returns
 * undefined for non-negative or truly opaque replies (a bare "no" with no reason).
 * NEVER triggers an email — pure data capture (house rule: never auto-send to a no).
 */
export function classifyRejectionReason(snippet: string): string | undefined {
  const s = snippet.toLowerCase();
  if (/(already have|we use|we've got|in-house|do this ourselves|got (a|our) system|current provider|sorted)/.test(s)) {
    return "already_have";
  }
  if (/(too expensive|no budget|can'?t afford|pricey|pricey|cost too|not worth)/.test(s)) {
    return "price";
  }
  if (/(not right now|maybe later|not at the moment|bad time|too busy|revisit|down the line|in future)/.test(s)) {
    return "timing";
  }
  if (/(not relevant|not for us|does ?n'?t apply|wrong (fit|business)|we don'?t (get|miss)|no missed)/.test(s)) {
    return "not_relevant";
  }
  if (/(unsubscribe|remove me|take me off|stop )/.test(s)) {
    return "opt_out";
  }
  return undefined; // negative but no stated reason (e.g. a bare "no")
}

export function isStopReply(sentiment: ReplyRecord["sentiment"]): boolean {
  // any genuine human reply stops the sequence; auto-replies do NOT
  return sentiment !== "auto";
}

/** Detect a delivery bounce (so we stop + suppress the address). */
export function isBounce(from: string, snippet: string): boolean {
  const f = from.toLowerCase();
  const s = snippet.toLowerCase();
  if (/mailer-daemon|postmaster|mail delivery|delivery subsystem/.test(f)) return true;
  return /(wasn'?t delivered|delivery (has )?failed|address (couldn'?t|not) be found|undeliverable|delivery status notification|recipient .* (rejected|not found))/.test(
    s,
  );
}
