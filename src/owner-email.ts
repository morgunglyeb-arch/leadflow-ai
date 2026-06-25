// Derive the OWNER's personal email when a clinic's site only exposed a role inbox
// (info@/reception@). Companies House gives the active director's name; we build
// the likely localpart patterns and SMTP-verify them. A named owner inbox reaches
// the decision-maker (reply ≫ role) and protects sender reputation.
//
// SAFETY: a guessed address is used ONLY if a real mailbox-level check says it's
// deliverable. An MX-record hit (domain accepts mail) is NOT enough for a GUESS —
// sending to a non-existent first@ would bounce, which hurts reputation MORE than a
// delivered-but-ignored info@. So we require a Hunter/ZeroBounce "deliverable"
// verdict; if verification is unavailable (quota out), we decline and stay role-only.
import { getActiveDirectorName } from "./companies-house.js";
import type { AppConfig } from "./config.js";
import { verifyEmail } from "./verify-email.js";

/** Only a real mailbox-level "deliverable" blesses a GUESSED address (not MX-only). */
function isStrongDeliverable(reason: string): boolean {
  return reason.startsWith("hunter:deliverable") || reason.startsWith("zerobounce:valid");
}

/**
 * Returns a verified personal owner address, or null (→ stay on the role inbox).
 * Spends at most `maxVerify` verification calls (Hunter free tier = 25/mo), so the
 * caller should also cap how many leads per run get derivation.
 */
export async function deriveOwnerEmail(
  cfg: AppConfig,
  company: string,
  domain: string,
  maxVerify = 2,
): Promise<string | null> {
  const name = await getActiveDirectorName(cfg, company);
  if (!name) return null;
  const [first, last] = name.split(/\s+/);
  if (!first || !last) return null;
  const root = domain.replace(/^www\./, "").toLowerCase();
  const f = first.toLowerCase().replace(/[^a-z]/g, "");
  const l = last.toLowerCase().replace(/[^a-z]/g, "");
  if (!f || !l) return null;

  // Most-likely localparts for a small UK clinic, in order.
  const candidates = [...new Set([`${f}@${root}`, `${f}.${l}@${root}`, `${f[0]}${l}@${root}`])].slice(
    0,
    Math.max(1, maxVerify),
  );
  for (const cand of candidates) {
    const v = await verifyEmail(cfg, cand);
    if (v.ok && isStrongDeliverable(v.reason)) return cand;
  }
  return null;
}
