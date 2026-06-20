---
name: objection-handler
description: Use when a prospect reply is an objection (too expensive / no time / already have a vendor / not now) — supplies proven counter-angles as few-shot examples for the reply draft. Trigger on "handle objection", "they said too expensive", "they have a provider already", or sentiment=objection.
---

# Objection handler

A small library of honest, human counters to the common cold-email objections, fed into **reply-responder** as few-shot examples.

## Canonical objections → angle (keep human, no pressure, no call)
- **"Too expensive / no budget"** → reframe to one recovered job/lead paying for it; offer to show a quick example sized to them.
- **"No time"** → that's the point — it's done-for-you; ask for 2 lines about their busiest manual task.
- **"Already have someone / in-house"** → don't fight it; offer to cover the one gap they mentioned, no switch needed.
- **"Not right now / maybe later"** → leave the door open, offer to send a short example they can keep for when it's time.
- **"Does it actually work for [vertical]?"** → 1 concrete vertical-specific example from `config/verticals.json`.

## Rules
- Honest, specific, never salesy. CTA = reply by email or "I'll send an example" — never a call.
- Match studio voice (see **reply-responder**). Final pass: **humanizer**.

Key files: `config/verticals.json`, `src/ai.ts`.
