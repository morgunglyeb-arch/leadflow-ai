# LeadFlow AI

> Agentic TypeScript pipeline that **enriches B2B leads from their websites** and writes **AI-personalized cold-outreach copy** — opener, ice-breaker, subject line, and an honest fit score. CSV / Google Sheets in, CSV / Sheets / Resend out. Anthropic or Groq. **No n8n, no Zapier — just code.**

```
 leads.csv  ──►  enrich (fetch site)  ──►  LLM (structured)  ──►  validate  ──►  CSV / Sheets / Email
                       │                         │
                       ▼                         ▼
                  data/cache/             zod schema + tool-use
                  (per-domain JSON)       (Claude tool_choice, Groq response_format)
```

It's the "Clay / SDR lite" pattern, built as a clean, typed pipeline:

- Drop in a list of `company, domain, name, role, email`
- For each lead it fetches the site, extracts a small structured context, and asks one LLM call to write the personalization
- AI **only writes from real context** — it cannot invent funding, customers, or numbers
- Failed fetches, LLM errors, malformed JSON — none of them drop the batch; the lead is marked and gets a fallback opener
- Outputs `data/out/leads_enriched.csv` (and optionally appends to a Google Sheet, and/or sends a Resend test email)

---

## Quickstart (offline, no API keys)

```bash
git clone https://github.com/morgunglyeb-arch/leadflow-ai
cd leadflow-ai
npm install
npm run gen:demo                       # creates data/leads.csv + data/fixtures/
npm run leads -- --mock --dry          # runs the full pipeline on fixtures, no network
```

You'll see each lead enriched from its fixture, with a fallback opener if no LLM key is configured. Add `ANTHROPIC_API_KEY` (or `GROQ_API_KEY`) to `.env` and rerun to see real personalization.

---

## Quickstart (live)

```bash
cp .env.example .env                   # set ANTHROPIC_API_KEY + OUR_OFFER
npm run leads -- --input=data/leads.csv
# → data/out/leads_enriched.csv
```

---

## Why it's built this way

| Concern | How LeadFlow handles it |
|---|---|
| **Anti-hallucination** | LLM only sees real text scraped from the lead's site; system prompt forbids inventing facts; thin context → fit_score ≤ 2 |
| **Structured output** | Anthropic tool-use (`tool_choice` + `input_schema`) **or** Groq `response_format: json_object`, both validated by a single zod schema |
| **Graceful failure** | Bad fetch / non-HTML / timeout → lead is marked `enriched:false`, batch keeps going. LLM error → fallback template. |
| **Resumable** | Per-domain JSON cache (`data/cache/<domain>.json`); already-processed leads (by email or domain) are skipped without `--force` |
| **Polite concurrency** | Custom `pLimit` so we never blast a site or melt the LLM rate limit |
| **Demo without secrets** | `--mock` uses `data/fixtures/<domain>.txt` so CI / screenshots / "show me how it works" runs deterministically with no network |
| **Provider-portable** | `LLM_PROVIDER=anthropic\|groq` toggles the call site; the schema, prompt and fallback are shared |

---

## CLI

```
npm run leads -- [flags]

  --dry                Print rows, don't write CSV / Sheets / send email
  --mock               Use fixtures in data/fixtures/<domain>.txt (no network)
  --input=PATH         Use a different leads CSV than LEADS_CSV_PATH
  --limit=N            Process only the first N leads
  --concurrency=N      Override CONCURRENCY (default 5)
  --force              Ignore cache + idempotency (reprocess everything)
  --send-test          Email the first row through Resend (smoke test)
  --help, -h           Show usage
```

### Examples

```bash
npm run leads -- --mock --dry           # offline demo for CI / screenshots
npm run leads -- --input=my_list.csv    # real CSV, write to default output
npm run leads -- --limit=10             # try the first 10 leads
npm run leads -- --concurrency=3        # be gentler on the LLM
npm run leads -- --force                # re-enrich, ignore cache + idempotency
```

---

## Inputs

### `data/leads.csv`

```
company,domain,name,role,email
Northwind Logistics,northwindlogistics.example,Marcus Hale,VP Operations,marcus.hale@northwindlogistics.example
Lumen Health,lumenhealth.example,Priya Anand,Head of Product,priya.anand@lumenhealth.example
…
```

Required columns: `company`, `domain`. Everything else is optional and gets passed to the AI when present. `linkedin` is also accepted.

### Google Sheets (instead of CSV)

Set `LEADS_SOURCE=sheets`, drop a service-account JSON into `GOOGLE_SERVICE_ACCOUNT_JSON`, point `GOOGLE_SHEETS_ID` at your sheet, and the same parser is reused after pulling rows via the Sheets API.

---

## Outputs

### `data/out/leads_enriched.csv`

```
company,domain,name,role,linkedin,email,enriched,enrichment_source,signals,ai_provider,subject,opener,icebreaker,fit_score,reason
Northwind Logistics,northwindlogistics.example,Marcus Hale,VP Operations,,marcus.hale@…,true,mock,logistics|ecommerce|b2b|careers,anthropic,"last-mile cost ideas for Northwind","Saw Northwind connects last-mile routing into Shopify checkout — most agentic-ops work we do for mid-market 3PLs starts exactly there…","Curious whether dispatcher workload is the bottleneck as you scale past 14 hubs.",4,"Tight overlap with our SMB/3PL ops automation work"
…
```

Idempotency: a second run with the same input will skip leads whose `email` or `domain` already appears in the output CSV. Use `--force` to override.

### Google Sheets append (optional)

Set `SHEETS_OUTPUT_ENABLED=true` and provide the same service-account creds; rows are appended to `GOOGLE_SHEETS_WRITE_RANGE`.

### Resend test email (optional)

`--send-test` sends a single rendered cold email (subject + greeting + opener + icebreaker) of the first row to `EMAIL_TEST_TO` — handy as a smoke test before you hand the CSV to a real sender (Instantly, Smartlead, Lemlist, etc).

---

## Configuration (`.env`)

| Key | Default | Notes |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` | or `groq` |
| `ANTHROPIC_API_KEY` | — | required when provider=anthropic |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | |
| `GROQ_API_KEY` | — | required when provider=groq |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | |
| `OUR_OFFER` | — | **important.** One paragraph: what you sell, who for. The AI uses this to score fit and tailor the opener. |
| `LEADS_SOURCE` | `csv` | or `sheets` |
| `LEADS_CSV_PATH` | `data/leads.csv` | |
| `ENRICH_TIMEOUT_MS` | `8000` | per-request timeout for site fetch |
| `ENRICH_USER_AGENT` | LeadFlowAI/1.0 | sent on outbound fetches |
| `ENRICH_CACHE_DIR` | `data/cache` | per-domain JSON cache |
| `CONCURRENCY` | `5` | parallel enrichment+LLM workers |
| `OUTPUT_CSV_PATH` | `data/out/leads_enriched.csv` | |
| `SHEETS_OUTPUT_ENABLED` | `false` | append to a Google Sheet tab too |
| `RESEND_API_KEY` / `EMAIL_FROM` / `EMAIL_TEST_TO` | — | only needed for `--send-test` |

Full template: [`.env.example`](.env.example).

---

## What the AI gets — and what it can't get

**Input to the model (per lead):**
- Your offer (`OUR_OFFER`)
- The lead row (`company, domain, name?, role?`)
- The scraped site context: title, meta description, top H1/H2 headings, body text trimmed to ~4000 chars
- A list of rule-detected signals (e.g. `pricing | careers | saas | b2b | ai`)

**System prompt rules (enforced in code by the schema, in spirit by the prompt):**
- Use only the provided context, never invent facts
- If context is thin, write a generic-but-clean opener and set `fit_score ≤ 2`
- Reference at most one specific detail per message
- Banned phrases: "I hope this finds you well", "I came across your", "love what you're doing", flattery clichés
- `subject ≤ 60 chars`, no emojis, no ALL CAPS
- Honest fit scoring 1–5 against your offer

**Output schema (zod-validated; failure → fallback):**

```ts
{
  opener: string;     // 1-2 sentences, first line of cold email
  icebreaker: string; // short observation
  subject: string;    // <= 60 chars
  fit_score: 1..5;
  reason: string;     // one-line justification
}
```

---

## Architecture

```
src/
  index.ts          CLI — flag parsing + entrypoint
  config.ts         zod env validation
  types.ts          Lead, Enrichment, Personalized, OutputRow
  orchestrator.ts   runEnrichment — the pipeline
  sources/
    index.ts        LeadsSource interface + factory + domain normalizer
    csv.ts          CSV parser (quote-tolerant)
    sheets.ts       Google Sheets reader (JWT service account)
  enrich.ts         fetchSite, HTML → text, signal rules, fixture loader
  ai.ts             Claude tool-use + Groq json_object + zod + fallback
  cache.ts          per-domain JSON cache
  pLimit.ts         tiny concurrency limiter
  output.ts         CSV writer, Sheets append, Resend test email
scripts/
  gen-demo.ts       seeded demo leads + matching fixtures
data/
  leads.csv         demo input (generated)
  fixtures/         offline site texts keyed by domain
  cache/            per-domain enrichment cache (gitignored)
  out/              enriched CSV output (gitignored)
```

Each step is a typed function, the orchestrator is one screen, and provider differences live behind one schema.

---

## Roadmap

- Apollo / Clearbit enricher behind the same `Enricher` interface
- Per-company news (recent announcements) folded into the LLM context
- Direct send via Instantly / Smartlead instead of a single Resend test
- A/B opener variants per lead (n=2..3) with diversity constraints
- Email validation + dedupe (catchall + role inboxes)
- Per-segment prompt overrides (`OUR_OFFER` per ICP)

---

## License

MIT — see [LICENSE](LICENSE).
