---
name: spam-doctor
description: Use when a cold-email draft is spam-flagged, or before sending, to explain WHY it tripped the spam linter and rewrite to clear it. Trigger on "spam score", "why was this flagged", "will this hit spam", spamlint output, or editing src/spamlint.ts.
---

# Spam doctor

`src/spamlint.ts` already FLAGS risky phrasing (`spamLint` → `{score, hits, risky}`) but gives no explanation or fix. This skill closes that loop.

## Workflow
1. Run `spamLint(text)` on the draft (subject + body).
2. For each entry in `hits`, explain in plain terms what tripped it and why it hurts inbox placement (e.g. `"$ amount"` → dollar figures in cold email read as sales spam).
3. Propose a concrete rewrite that removes the trigger while keeping the meaning (e.g. swap "FREE audit" → "a quick look, on me").
4. Re-run `spamLint` to confirm `risky === false` (score < 2). Iterate until clear.
5. Then run the **humanizer** skill for the AI-tell pass.

## Notes
- `risky` = score ≥ 2. Aim for 0–1.
- Don't over-sanitize into blandness — a human, specific line beats a sterile one. Clear the triggers, keep the voice.
- Pair with **subject-lab** for subject lines.

Key files: `src/spamlint.ts` (patterns), `src/outreach.ts`.
