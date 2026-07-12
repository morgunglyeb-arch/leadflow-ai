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

export function classifyReply(snippet: string): ReplyRecord["sentiment"] {
  const s = topReply(snippet).toLowerCase();
  if (/(out of office|automatic reply|auto-?reply|away from|annual leave|on holiday)/.test(s)) {
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
