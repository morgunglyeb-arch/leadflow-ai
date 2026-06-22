/**
 * UK PECR / GDPR compliance gate (the `compliance-guard` skill, enforced in code).
 *
 * For B2B cold email in the UK, **corporate subscribers** (Ltd, LLP, PLC, etc.)
 * may be emailed without prior consent provided the message identifies the sender
 * and offers a working opt-out. **Sole traders, partnerships and individuals** are
 * treated like consumers and need prior consent (soft opt-in). So we only
 * auto-send to clearly-incorporated entities; everything else is held for review.
 *
 * This is a heuristic on the business name (we rarely know the legal form for
 * certain), deliberately conservative: unknown → treat as NON-corporate (hold).
 */

// Ltd / Limited / LLP / PLC / Inc / Welsh "Cyf"(yngedig). Word-boundary, case-insensitive.
const CORPORATE_RE =
  /\b(ltd|ltd\.|limited|llp|plc|l\.?l\.?p|inc|inc\.|incorporated|cyf|cyfyngedig)\b/i;

/** True if the business name signals an incorporated entity (B2B-emailable under PECR). */
export function isCorporateEntity(company: string | undefined | null): boolean {
  if (!company) return false;
  return CORPORATE_RE.test(company);
}
