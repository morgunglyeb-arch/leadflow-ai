---
name: outreach-localizer
description: Use to localize winning outreach angles across languages (UA / EN / RU) — adaptation, not literal translation, keeping voice and length. Trigger on "localize the outreach", "translate the winners", "send in Ukrainian/Russian", or editing winners.json / DIGEST_LANG / OUTREACH_LANG.
---

# Outreach localizer

## Workflow
1. Take a winning angle/opener (from `winners.json` / `learn.ts`) and ADAPT it to the target language (`OUTREACH_LANG`), not word-for-word — keep the hook, voice, and ~length.
2. Preserve human voice (see **outreach-personalizer**/**reply-responder**): studio «Ми»/«we»; UK = «ви». No AI tells; run **humanizer**.
3. Keep proper nouns / brand stacks ("Twilio · WhatsApp") in original.
4. If a new vertical/term is introduced, respect the `config/verticals.json` ↔ `glyeb-site/config/industries.ts` sync rule.

## Constraints
- Don't degrade a winning angle in translation — if it doesn't land naturally in the target language, rewrite the angle for that market rather than force it.
- Spam-screen the localized version (**spam-doctor**) — triggers differ by language.

Key files: `winners.json`, `src/ai.ts:translate`, `config/verticals.json`.
