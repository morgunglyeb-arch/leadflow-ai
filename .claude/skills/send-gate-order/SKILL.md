---
name: send-gate-order
description: "Auto-apply before ANY cold send, when editing the send path (src/campaign/run.ts), or before flipping SENDING_ENABLED. Enforces the house GATE ORDER so a send can never skip a check: compliance → suppression → warmup/ramp → deliverability → send. Trigger on 'send', 'enable sending', 'go live', 'flip SENDING_ENABLED', or any edit to the campaign send loop."
---

# Send gate order (house rule — never reorder, never skip)

Every cold first-touch MUST pass these gates **in this order** before it leaves. They are enforced in code (`src/campaign/run.ts` + helpers); this skill is the checklist so a refactor never drops one.

1. **Compliance (PECR/GDPR)** — `isEmailableEntity` (src/compliance.ts): corporate-only gate (Ltd/LLP, Companies House-confirmed). Sole traders/individuals are HELD for consent. Never email a non-corporate without consent. See skill `compliance-guard`.
2. **Suppression (cross-channel)** — `isSuppressed` over the local `data/campaign/suppression.txt` **merged with** the hub `contacts.suppressed` (`fetchSuppression`, #11 D1). An opt-out on ANY channel (site/manual/reply) blocks the send. Never contact a suppressed address/domain.
3. **Warmup / ramp** — `warmupCap` + per-inbox AND per-domain daily caps (`SEND_DOMAIN_DAILY_CAP`). Follow-ups count against the same caps. Don't crank. See skills `warmup-planner`, `inbox-rotation`.
4. **Deliverability** — all active sending domains must PASS SPF/DKIM/DMARC/MX (`DELIVERABILITY_GATE`). Warmup is pointless if auth is broken. See skill `deliverability-audit` (run BEFORE any volume increase).
5. **Send** — only now `sendStep`, gated by `live = SENDING_ENABLED && !dryRun`. EMAIL_VERIFY should be true for first-touches. Persist state immediately after each send (no double-send on replay).

**Order matters:** a suppressed corporate entity is still suppressed (2 can't be skipped because 1 passed); a warm inbox on a broken domain still must not send (4 gates 5). If you add a step, slot it in the right place and update this list.

**Before flipping `SENDING_ENABLED=true`:** confirm 1–4 are all true for the batch + owner explicit "да" (never flip autonomously).
