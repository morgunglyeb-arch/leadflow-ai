---
name: crm-sync
description: Use to move LeadFlow campaign state out of the JSON file into the Supabase funnel (opero-ops), dedup contacts by domain/email, and keep one contact history across campaigns. Closes the "CRM is a JSON file" gap. Trigger on "CRM", "store leads in the database", "dedup contacts", "contact history", or editing src/campaign/store.ts / src/output.ts.
---

# CRM sync

Today the campaign funnel lives in `src/campaign/store.ts` (a JSON file) + a CSV — no DB funnel, no cross-campaign dedup, no per-contact history. opero-ops already has Supabase with a `leads` table. This skill unifies them.

## Workflow
1. Define/confirm a Supabase schema in opero-ops: a `contacts` table (unique on lowercased domain+email) with status, first_seen, last_touch, campaign refs; link to existing `leads`. Use the Supabase MCP for migrations.
2. On campaign writes (`enqueueLeads`, `sendStep`, `pollReplies`), upsert the contact: dedup by domain/email, append a touch/event to history rather than overwriting.
3. Backfill: import the current JSON state + CSV into Supabase once.
4. Reads: the Opero Ops Mini App / digest query Supabase, not the JSON file.

## Constraints
- **Dedup is the point:** never create a second contact for the same domain/email; merge history.
- Respect `src/campaign/suppression.ts` — suppressed contacts stay suppressed across campaigns (store the flag on the contact).
- Don't break the existing JSON/CSV flow until the DB path is verified — write to both during transition, then cut over.
- Emit nothing sensitive to logs.

Key files: `src/campaign/store.ts`, `src/output.ts`, opero-ops `supabase/migrations/`, `lib/writes.ts`.
