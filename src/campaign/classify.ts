import type { ReplyRecord } from "./store.js";

/**
 * Classify a reply snippet by sentiment. Heuristic (no LLM call): replies are
 * short and routing only needs to (a) always stop the sequence and (b) tag the
 * reply so the digest + learning loop know what landed.
 */
export function classifyReply(snippet: string): ReplyRecord["sentiment"] {
  const s = snippet.toLowerCase();
  if (/(out of office|automatic reply|auto-?reply|away from|annual leave|on holiday)/.test(s)) {
    return "auto";
  }
  if (/(unsubscribe|remove me|stop|not interested|no thanks|no thank you|don'?t contact|piss off|fuck off)/.test(s)) {
    return "not_interested";
  }
  if (/(yes|interested|sounds good|tell me more|how much|pricing|call|book|let'?s talk|keen|when can|sure|happy to)/.test(s)) {
    return "interested";
  }
  if (/(already have|we use|not right now|maybe later|too expensive|no budget|in-house|do this ourselves)/.test(s)) {
    return "objection";
  }
  return "unclear";
}

export function isStopReply(sentiment: ReplyRecord["sentiment"]): boolean {
  // any genuine human reply stops the sequence; auto-replies do NOT
  return sentiment !== "auto";
}
