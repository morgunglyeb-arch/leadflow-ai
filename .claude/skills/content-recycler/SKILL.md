---
name: content-recycler
description: Use to turn winning OUTBOUND angles into INBOUND content topics — outbound teaches inbound. Trigger on "turn this into posts", "content from what's working", "recycle the winners", "inbound topics", or planning Opero social/blog content.
---

# Content recycler

Closes the loop between outbound and inbound: what hooks prospects in cold email is exactly what should fuel Opero's inbound content.

## Workflow
1. Pull winning angles/hooks from `src/campaign/learn.ts` / `winners.json` (highest reply-rate openers, by vertical).
2. Turn each into inbound content topics: short social posts, a landing-page angle, an FAQ entry. Keep the Opero brand voice + strict B&W brand (see memory glyeb-palette / brand-review skill).
3. Hand off to the sibling content tools in `~/` (OmniPost, carousel) for production; pair with marketing:content-creation / canva-creator for assets.
4. Feed recurring prospect questions (from the site agent + replies) back into FAQ + content.

## Constraints
- No prices in public content (memory glyeb-no-prices).
- Match the site's existing voice/i18n (EN + UK).
- Inbound content should pull leads to `/contact`//`/chat` — same funnel, no call.

Key files: `src/campaign/learn.ts`, `winners.json`, sibling `~/OmniPost`/`~/carousel`, `glyeb-site`.
