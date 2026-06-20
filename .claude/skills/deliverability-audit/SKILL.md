---
name: deliverability-audit
description: Use before or during cold-email sending to audit deliverability — SPF, DKIM, DMARC, MX records, and blacklist (Spamhaus etc.) status for each sending domain/inbox. The biggest unclosed gap — warmup is pointless if auth/reputation is broken. Trigger on "deliverability", "SPF/DKIM/DMARC", "blacklist", "landing in spam", "inbox placement", or setting up a new sending inbox.
---

# Deliverability audit

Run this for every sending domain in `GMAIL_ACCOUNTS` (`.env`) before relying on warmup.

## Checklist (per sending domain)
1. **SPF** — TXT record exists, includes the sending source, single record, not >10 lookups.
2. **DKIM** — selector present and key published; signatures verify.
3. **DMARC** — `_dmarc` TXT exists; policy at least `p=none` with `rua=` for reports; recommend ramp to `quarantine`.
4. **MX** — resolves; matches the mailbox provider.
5. **Blacklists** — check the domain + sending IP against Spamhaus (zen.spamhaus.org) and common RBLs.
6. **Alignment** — DKIM/SPF domains align with the From domain (DMARC alignment).

## How
- Resolve records with `dig`/DNS (TXT for `domain`, `selector._domainkey.domain`, `_dmarc.domain`; MX for `domain`).
- For blacklists, query the DNSBL or a reputation API.
- Report a per-domain PASS/FAIL table + the exact DNS records to add for any FAIL.

## Constraints
- Don't raise warmup volume (`warmup-planner`) until all domains PASS SPF+DKIM+DMARC.
- Bounces/complaints must already feed `src/campaign/suppression.ts` — flag if not.

Key files: `.env` (`GMAIL_ACCOUNTS`, `GMAIL_SENDER`), `src/campaign/gmail.ts`.
