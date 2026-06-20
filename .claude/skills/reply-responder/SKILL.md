---
name: reply-responder
description: Use to draft a reply to a prospect who answered a cold email, in the studio's human voice, sentiment-aware, never proposing a call. Trigger on "draft a reply", "respond to this reply", handling an inbound answer, or editing src/ai.ts:suggestReply.
---

# Reply responder

The richer, voice-faithful evolution of `src/ai.ts:suggestReply` (which already drafts a human, no-AI-tell, no-call reply and pushes it to Telegram via the hub for the operator to send themselves).

## Rules
- **Voice:** studio = «Ми»/«we». For a UK prospect use formal «ви». (See memory glyeb-voice.) Default outreach language = `OUTREACH_LANG`.
- **Sentiment-aware:** interested → concrete next step + a short example offer; objection → use the **objection-handler** few-shots; unclear → answer the question, ask one clarifier.
- **CTA = `/contact` or `/chat`, NEVER a phone/video call** (hard constraint).
- **Human, not AI/marketing:** no clich;s ("hope this finds you well"), no em-dashes, no rule-of-three, contractions, ~40-70 words. Run the **humanizer** skill as a final pass.
- **Never auto-send** — output is a draft for the operator. Prices only in a private proposal, never quoted as if from the site.

Key files: `src/ai.ts` (`suggestReply`), `src/campaign/run.ts` (`pollReplies`), opero-ops reply push.
