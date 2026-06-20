---
name: subject-lab
description: Use to generate and choose cold-email subject lines. Produces N candidates, screens them through the spam linter, ranks by historical reply-rate, and fills the A/B `subjectB` field. Trigger on "subject line", "subject A/B", "what subject", or when preparing a send.
---

# Subject lab

## Workflow
1. Generate 6–10 subject candidates for the lead/angle. Style: lowercase-ish, 2–5 words, specific, curiosity over hype. No "Re:" fakes, no ALL CAPS, no "$"/"free".
2. Screen each via `spamLint` (`src/spamlint.ts`) — drop any with `risky === true`.
3. Rank survivors by historical reply-rate from the learning loop (`src/campaign/learn.ts` / campaign state `winners`), if data exists; else by spam score then brevity.
4. Output the top 2 → primary `subject` + `subjectB` (the A/B variant the sender rotates in `src/campaign/run.ts:sendStep`).

## Constraints
- Match the human, non-AI voice (see **outreach-personalizer**).
- The send pipeline already does A/B (`lead.variant` A/B in `sendStep`) and the learning loop compares reply rates by variant — feed it good candidates.

Key files: `src/campaign/run.ts` (variant logic), `src/campaign/learn.ts`, `src/spamlint.ts`.
