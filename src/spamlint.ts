// Lightweight spam-trigger linter — flags phrasing that hurts inbox placement
// so we can rewrite or down-rank before sending. Not a guarantee, a safety net.

const SPAM_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(free|100% free|risk[- ]?free)\b/i, label: '"free"' },
  { re: /\b(guarantee[d]?)\b/i, label: '"guarantee"' },
  { re: /\b(act now|limited time|urgent|don'?t miss)\b/i, label: "urgency" },
  { re: /\b(click here|buy now|order now|sign up free)\b/i, label: "hard CTA" },
  { re: /\b(cash|earn \$|make money|income|cheap|discount|% off|save \$)\b/i, label: "money words" },
  { re: /\b(winner|congratulations|you'?ve been selected|prize)\b/i, label: "prize" },
  { re: /\b(no obligation|no catch|amazing|incredible|revolutionary|breakthrough)\b/i, label: "hype" },
  { re: /!{2,}/, label: "multiple !!" },
  { re: /\b[A-Z]{5,}\b/, label: "ALL CAPS word" },
  { re: /\$\d/, label: "$ amount" },
];

export interface SpamReport {
  score: number; // count of triggers
  hits: string[];
  risky: boolean; // score >= 2
}

export function spamLint(text: string): SpamReport {
  const hits: string[] = [];
  for (const { re, label } of SPAM_PATTERNS) {
    if (re.test(text)) hits.push(label);
  }
  return { score: hits.length, hits, risky: hits.length >= 2 };
}
