---
name: cost-tracker
description: Use to track LLM token spend per lead and surface outbound unit economics (cost_per_lead). Trigger on "how much does a lead cost", "LLM cost", "token spend", "unit economics", or instrumenting src/ai.ts calls.
---

# Cost tracker

Makes the outbound machine's unit economics visible — today token cost is invisible.

## Workflow
1. Instrument the LLM calls in `src/ai.ts` (Anthropic + Groq + Gemini) to record input/output tokens per call and per lead.
2. Convert tokens → cost using current per-provider rates; accumulate `cost_per_lead` and `cost_per_qualified_lead`.
3. Write the figure onto the run / contact (opero-ops Supabase) so it shows in the digest and **campaign-analyst**.
4. Surface: cost per lead, per qualified lead, per positive reply — the real CAC of the outbound channel.

## Constraints
- Most LLM usage is on FREE tiers (Gemini ~1500/day, Groq) — cost is often ~$0, but track anyway so scaling decisions are data-backed.
- Don't add latency to the send path — record async/best-effort.

Key files: `src/ai.ts`, `src/campaign/run.ts`, opero-ops Supabase (`leadflow_runs`/`contacts`).
