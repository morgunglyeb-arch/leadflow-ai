---
name: experiment-runner
description: Use to run and read A/B/N experiments across the campaign — not just subject lines but opener, send time, and length — writing results to Supabase so the learning loop reads from the DB. Trigger on "run an experiment", "A/B/N", "test opener vs", "what variant wins", or extending learn.ts.
---

# Experiment runner

Today A/B is limited to `subjectB` in `src/campaign/run.ts:sendStep`. This formalizes experiments across more dimensions and persists results.

## Workflow
1. Define an experiment: dimension (subject | opener | send_time | length), variants, and the metric (reply-rate; later positive-reply-rate).
2. Assign variants at send time (extend `sendStep`'s variant logic); record `experiment_id` + `variant` on the lead/event.
3. Write outcomes to **Supabase** (events/contacts in opero-ops, or a new `experiments` table) so analysis isn't trapped in a JSON file — `learn.ts` and **campaign-analyst** read from the DB.
4. Report winners with sample size; flag "early signal, N=…" for small samples.

## Constraints
- One variable at a time per experiment (don't confound).
- Never let an experiment override safety (suppression, warmup cap, send window).
- Pairs with **subject-lab** (subjects) and **campaign-analyst** (analysis).

Key files: `src/campaign/run.ts`, `src/campaign/learn.ts`, opero-ops Supabase.
