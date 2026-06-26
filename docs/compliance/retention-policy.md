# Data Retention Policy — Opero

_Owner-set 2026-06-25. Plain-English operational policy; not legal advice — a solicitor/DPA should confirm before scaling._

Opero processes personal data for B2B outreach (UK clinics/allied-health) and inbound enquiries. We keep the **minimum data for the minimum time** needed to do the job.

## Retention periods

| Data | Kept for | Then |
|------|----------|------|
| **Leads & conversations** (someone replied / enquired via site / became a prospect we're in contact with) | **12 months after the last contact** | Deleted (contacts + leads + history) |
| **Non-responder prospects** (cold-listed, never engaged) | Until they **opt out**, OR **6 months with no reply** | Deleted |
| **Suppression / never-contact record** (opt-outs, bounces) | **Indefinite** (minimal: email/domain + reason + date) | Kept — needed to honour the opt-out; lawful under ICO guidance |
| **Won clients** | Duration of the relationship + standard business-records period | Per the client contract |

> Why suppression is kept forever: to *respect* an opt-out we must remember it. ICO explicitly allows retaining a minimal suppression record (just enough to recognise the person and not re-contact them). We keep only email/domain + reason + date — no marketing profile.

## Where the data lives
- **Supabase** (`contacts`, `leads`) — the ops hub / single source of truth.
- **LeadFlow** local `data/campaign/suppression.txt` — never-contact list (mirrors hub `contacts.suppressed` via the D1 bridge).
- **Outbound tracker** CSV (manual channel) — named individuals; subject to the same periods.

## Erasure / DSAR
Anyone can ask us to access or delete their data (via the site request form or by reply). We action it promptly using the **erase procedure** (`scripts/erase-contact` in opero-ops) which removes the person from `contacts`, `leads`, the tracker, and — except for the minimal suppression record — everywhere. We add them to suppression so we never re-contact them.

## Review
Re-confirm these periods before any volume increase and at least annually.
