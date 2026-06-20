---
name: campaign-analyst
description: Use for periodic (weekly) campaign analysis — break reply-rate down by angle × vertical × subject, surface A/B winners, and recommend what to change next. Trigger on "campaign analysis", "what's working", "reply rate by", "weekly review", "which angle/subject wins".
---

# Campaign analyst

Upgrades the learning loop (`src/campaign/learn.ts`) and digest (`src/digest.ts`) from flat summaries to a cohort cut with an action.

## Workflow
1. Pull campaign state + events (from `src/campaign/store.ts` JSON, or Supabase once **crm-sync** lands).
2. Cut reply-rate by: **angle/opener**, **vertical** (from `config/verticals.json`), **subject variant** (A vs B from `sendStep`), **inbox**, and **warmup day**.
3. Identify statistically meaningful winners/losers (guard against tiny samples — note N).
4. Output: a short RU summary for the operator (matches `DIGEST_LANG`) with 2–3 concrete recommendations — which angle to push, which subject to retire, which vertical to lean into — and update `winners.json` if used.
5. Optionally push the summary to the Opero Ops digest (`src/ops.ts`).

## Constraints
- Don't over-claim on small samples; say "early signal, N=…".
- Recommendations only — never auto-change sending behavior without the operator's nod.
- Pairs with **subject-lab** (feeds it reply-rate data) and the **data:*** plugin skills for dashboards.

Key files: `src/campaign/learn.ts`, `src/digest.ts`, `src/campaign/store.ts`, `config/verticals.json`.
