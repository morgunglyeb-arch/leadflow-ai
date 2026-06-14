# LeadFlow AI — Case Study

> [Українська версія](./PORTFOLIO.uk.md)

**Stack:** TypeScript (Node 20, ESM, strict, `noUncheckedIndexedAccess`) · Anthropic SDK (tool-use + prompt caching) · Groq via OpenAI SDK · zod · googleapis · Resend · native fetch · custom `pLimit`.
**Surface:** CLI. **No n8n. No Zapier. No "AI wrapper."**
**Repo:** `morgunglyeb-arch/leadflow-ai`

---

## The problem

Cold-outreach lists die at two predictable points:

1. **Enrichment is brittle.** A scraping pass blows up on the third broken site and the whole batch is dead.
2. **Personalization hallucinates.** The model invents a Series B, a customer logo, a headcount number — and one bad opener sinks the sender reputation of the whole domain.

LeadFlow AI is a small, honest pipeline that fixes both. It treats enrichment as a **deterministic data step** and the LLM as a **constrained writer that only sees real context**.

---

## What it does

```
leads.csv  ──►  enrich (fetch site)  ──►  LLM (structured)  ──►  validate  ──►  CSV / Sheets / Email
```

- **Input:** company + domain (+ optional name, role, email, linkedin) — CSV or Google Sheets
- **For each lead** (in parallel, with a configurable concurrency cap):
  - Fetch `https://<domain>` and `/about`, parse title / meta / H1-H2 / body text, trim to ~4000 chars
  - Detect a fixed set of rule-based signals (`pricing | saas | ecommerce | b2b | careers | …`)
  - Call **one** structured LLM call: opener, icebreaker, subject, `fit_score 1–5`, reason
  - Validate the output through a single zod schema — any deviation → fallback template
- **Output:** `data/out/leads_enriched.csv`, optional Google Sheets append, optional Resend test email

---

## The anti-hallucination design (the part I'm proud of)

The model never sees anything the code didn't extract. The system prompt is short and *enforceable*:

> *Use ONLY the company context provided in the user message. Never invent facts, funding, headcount, customers, product names, or numbers that are not literally present. If the context is thin, write a clean generic opener and set fit_score ≤ 2.*

Then the schema enforces structure regardless of what the model wrote:

```ts
const PersonalizedSchema = z.object({
  opener:     z.string().min(5).max(400),
  icebreaker: z.string().min(3).max(280),
  subject:    z.string().min(3).max(120),
  fit_score:  z.number().int().min(1).max(5),
  reason:     z.string().min(3).max(280),
});
```

Provider differences are hidden:

- **Anthropic**: `tool_choice: { type: "tool", name: "emit_personalization" }` with `input_schema`, plus `cache_control: { type: "ephemeral" }` on the system prompt so repeated runs hit the cache.
- **Groq** (`openai/gpt-oss-120b`): `response_format: { type: "json_object" }`, same zod schema, same fallback path.

Both paths converge on `PersonalizedSchema.parse(...)`. Anything that doesn't parse — invalid JSON, missing field, off-range `fit_score` — falls back to a clean template opener. **One lead never takes down a batch.**

---

## Resilience details that matter in production

- **Per-domain JSON cache** (`data/cache/<domain>.json`) — second run on the same list does not touch the network.
- **Idempotency** — the output CSV is read back at start; leads matching by `email` or `domain` are skipped unless `--force`.
- **Timeout + UA + content-type guard** on every fetch — non-HTML responses, redirects to login walls, 5xx errors, all marked `enrichment_failed` without aborting.
- **Polite concurrency** via a tiny custom `pLimit` (no dependency); default 5, configurable.
- **Mock mode** — `--mock` reads `data/fixtures/<domain>.txt` instead of fetching, so CI and demo runs are deterministic and offline.

---

## What it demonstrates as a portfolio piece

| Capability | Where to look |
|---|---|
| Agentic pipeline w/ deterministic data + constrained LLM | `src/orchestrator.ts`, `src/ai.ts` |
| Provider-portable structured output (Claude tool-use + Groq json_object) behind one schema | `src/ai.ts` |
| Anti-hallucination by *construction*, not just by prompt | `src/ai.ts` system prompt + zod schema + fallback |
| Resilient web enrichment (timeout, UA, content-type, redirects, cache) | `src/enrich.ts`, `src/cache.ts` |
| Concurrency without a dep | `src/pLimit.ts` |
| Source adapters (CSV, Sheets) behind one interface | `src/sources/index.ts` |
| Idempotent batch with `--force` escape hatch | `src/orchestrator.ts`, `src/output.ts` |
| Demo-friendly (no creds, no network) | `scripts/gen-demo.ts`, `data/fixtures/`, `--mock --dry` |

---

## Why no n8n

n8n is great when the work is *moving data around between SaaS tools you already pay for*. It stops being great when the work is *constraining an LLM and keeping a batch alive when one thing fails*. Both of those are easier in code:

- A zod schema is one line — the n8n equivalent is a "Code" node that already broke the visual flow.
- Concurrency with backoff and a per-domain cache is ~30 lines of TypeScript; in n8n it's two sub-workflows and a queue.
- A fallback template that the model can't bypass is trivial here; in n8n it's an `if` branch with the wrong default.

So this is a deliberate "**code-first agentic workflow**" — the same shape as a Clay/Apollo flow, but maintained as a typed module rather than a screenshot.

---

## Roadmap

- Apollo / Clearbit enricher behind the existing adapter slot
- Per-company recent-news context (one call to a search API, folded into LLM input)
- A/B opener variants with diversity constraints
- Direct delivery to Instantly / Smartlead instead of one Resend smoke test
- Email validation + role-inbox filtering

---

**Author:** Glyeb Morgun — [github.com/morgunglyeb-arch](https://github.com/morgunglyeb-arch)
