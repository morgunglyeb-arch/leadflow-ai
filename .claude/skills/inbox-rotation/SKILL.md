---
name: inbox-rotation
description: Use when sending across multiple Gmail inboxes to pick the mailbox by remaining daily cap AND per-inbox reputation, instead of just pinning a thread to one inbox. Trigger when editing src/campaign/gmail.ts or policy.ts, or on "inbox rotation", "which inbox to send from", "spread sends across inboxes".
---

# Inbox rotation

Today `src/campaign/run.ts` round-robins first-touches across inboxes by remaining daily capacity, and PINS follow-ups to the originating inbox (correct for threading). This skill adds reputation-awareness.

## Workflow
1. For each inbox track: sent-today (`state.inbox_sent`), bounces/complaints attributed to it, and recent reply rate.
2. Compute a simple reputation score per inbox; bias first-touch selection toward healthier inboxes (still within each inbox's `warmupCap`).
3. If an inbox shows rising bounces/complaints, throttle or pause it and alert via the Opero Ops hub (`src/ops.ts` → `opsError`).
4. Keep follow-ups pinned to the original inbox (threading/deliverability) — never move a live thread.

## Constraints
- Never exceed per-inbox `warmupCap` or `SEND_DAILY_CAP`.
- Bounced addresses → `src/campaign/suppression.ts` (already wired in `pollReplies`).

Key files: `src/campaign/run.ts` (selection loop), `src/campaign/policy.ts`, `src/campaign/gmail.ts`.
