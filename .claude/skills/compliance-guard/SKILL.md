---
name: compliance-guard
description: Use before sending cold email to global/EU recipients to check GDPR / CAN-SPAM compliance — sender identification, a working one-click opt-out, a physical postal address, and a lawful suppression list. Trigger on "compliance", "GDPR", "CAN-SPAM", "is this legal to send", "opt-out", or before enabling sending.
---

# Compliance guard

Cold email to global/EU is regulated; today the pipeline only has `OPT_OUT_TEXT`. Wire these checks into `src/campaign/policy.ts` as a pre-send gate.

## Pre-send checklist (block send if any fail)
1. **Sender identity** — real person/business name in the email (not anonymous).
2. **Physical postal address** present in the footer (CAN-SPAM requirement).
3. **Working opt-out** — a clear unsubscribe instruction that actually lands the address in `src/campaign/suppression.ts` (one-click/reply-STOP both honored).
4. **Suppression honored** — `isSuppressed` checked before every send (already in `runCampaign`); opt-outs/bounces never re-contacted.
5. **Lawful basis / targeting** — B2B business addresses, relevant offer (legitimate interest); no consumer/personal inboxes.
6. **Truthful subject + from** — no deceptive headers (pairs with spamlint).

## Output
A PASS/FAIL report; on FAIL, the exact footer text / config to add. Recommend keeping send gated until PASS.

Key files: `src/campaign/policy.ts`, `src/campaign/suppression.ts`, `.env` (`OPT_OUT_TEXT`, sender fields).
