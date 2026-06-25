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

export function classifyReply(snippet: string): ReplyRecord["sentiment"] {
  const s = snippet.toLowerCase();
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
  return "unclear";
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
