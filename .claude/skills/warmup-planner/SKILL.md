---
name: warmup-planner
description: Use to plan or adjust the cold-email warmup ramp. Computes the daily-volume curve from SEND_WARMUP_* and inbox count toward a target, and writes the plan into the campaign. Trigger on "warmup", "ramp up sending", "how many can I send", "increase volume safely".
---

# Warmup planner

Sits on top of the warmup config and `src/campaign/policy.ts` (`warmupCap`, `advanceWarmup`).

## Inputs (`.env`)
- `SEND_WARMUP_START` (day-1 per-inbox volume), `SEND_WARMUP_STEP` (+N/day), `SEND_DAILY_CAP` (per-inbox ceiling), number of inboxes in `GMAIL_ACCOUNTS`.

## Workflow
1. **Precondition:** confirm `deliverability-audit` PASSED for all inboxes. If not, stop — ramping a broken domain burns it.
2. Compute the ramp: dayN per-inbox = min(START + STEP*(N-1), DAILY_CAP); combined/day = that × inbox count. Show the week-by-week table until full volume.
3. Sanity-check against safe cold norms (don't exceed ~40/inbox/day cold; gentle first 2 weeks).
4. Report the curve + the date full volume is reached; suggest `SEND_WARMUP_*` tweaks if too aggressive/slow.

## Constraints
- Respect `SEND_WINDOW` and `SEND_JITTER_SEC` (human-like cadence).
- Sending only happens when `SENDING_ENABLED=true` — keep planning safe to run while it's false.

Key files: `src/campaign/policy.ts`, `src/campaign/run.ts`, `.env`.
