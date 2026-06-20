---
name: outreach-personalizer
description: Use when writing or reviewing LeadFlow cold-email openers / personalization. Enforces the house rules — exactly one concrete site fact + one review/social fact, a clich; ban-list, a hard length cap, and a final humanizer pass. Trigger when editing src/outreach.ts or src/enrich.ts, or on requests like "personalize this", "write the opener", "improve the cold email", "make it less templated".
---

# Outreach personalizer

Codifies what currently lives loosely in the `src/ai.ts` prompts so every opener is consistent and doesn't read as AI/marketing.

## Hard rules for any opener/email body
1. **One real site fact + one review/signal fact.** Pull from the enrichment in `src/enrich.ts` (`signals`, `process`) and reviews. No generic flattery ("I love your website").
2. **Ban-list (reject if present):** "I hope this email finds you well", "I came across your", "reach out", "leverage", "seamless", "robust", "streamline", "in today's fast-paced", "synergy", em dashes, rule-of-three lists, exclamation spam, emoji.
3. **Length:** opener ≤ 2 sentences; full body ≤ ~90 words.
4. **No phone/video call** — the operator doesn't take calls (limited English). Every CTA = reply-by-email or "I'll send a short example". Mirror `CALL_TO_ACTION` in `.env`.
5. **Plain language**, no automation jargon (workflow/API/agentic).
6. **Final pass:** run the draft through the `humanizer` skill before it's queued.

## Workflow
1. Read the lead's `signals`/`process` from enrichment.
2. Draft per rules above; pick the single strongest gap to pitch (use `roiScore` intuition in `src/prospect.ts`).
3. Run `spamlint` (use the **spam-doctor** skill if it flags) and the **humanizer** skill.
4. Keep the EN outreach voice; the operator digest is RU (see `DIGEST_LANG`).

Key files: `src/outreach.ts`, `src/enrich.ts`, `src/ai.ts`, `config/verticals.json`.
