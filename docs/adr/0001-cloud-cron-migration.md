# ADR 0001 — Move the send/warmup crons off the Mac (Mac SPOF)

**Status:** proposed · scaffold shipped (state restore), activation owner-gated
**Date:** 2026-07-01

## Context
The whole outbound pipeline (warmup + cold send + reply-detection) runs from
**launchd crons on the owner's Mac** (8/12/14/16). If the Mac sleeps, is shut, loses
power, or reboots, **all sending stops** — a single point of failure on the one
revenue channel. The audit rated this a blocker. State lives in a local
`data/campaign/state.json` (warmup day, per-inbox counters, per-lead sequencing).

## Decision
Make the pipeline **runnable off the Mac**, in two shipped-now + one owner-gated part:

1. **State is now portable (SHIPPED).**
   - Save: `emitStateBackup(state)` already upserts the full state to Supabase
     (`campaign_state_backup`, id="campaign") at the end of every run.
   - Restore (new): `GET /api/state/leadflow` (opero-ops, bearer-guarded) returns it;
     LeadFlow's `runCampaignBody` pulls it when `STATE_REMOTE=true` **and** there's no
     local `state.json` (a fresh/replaced Mac or a cloud runner). Default off → the
     Mac is unaffected.
2. **A cloud runner (OWNER-GATED).** Options:

| Option | Fit | Cost | Notes |
|---|---|---|---|
| **Small VPS** (Hetzner/DO, cron+launchd-equiv) | ✅ best for a long-running send loop | ~$4–6/mo | full node env, Gmail OAuth token file, `caffeinate` not needed. **Recommended.** |
| GitHub Actions cron | ⚠️ ok but limits | free tier ~2000 min/mo | ephemeral FS (needs `STATE_REMOTE`); 4×/day × multi-min runs eats minutes; secrets in Actions. **Ready-to-use workflow: `.github/workflows/campaign-cloud.yml`** (opt-in, one `SECRETS_TARBALL` secret). |
| Fly.io / Railway | ✅ | ~$0–5/mo | persistent volume or `STATE_REMOTE`; simple deploy. |

## Runbook (owner, to activate)
1. Provision the runner (VPS recommended). Clone the repo, `npm ci`.
2. Copy secrets to the runner's env (NOT committed): the full `.env` incl. Gmail
   OAuth (`token.json`/`GMAIL_*`), `OPERO_OPS_URL`, `INGEST_BEARER_TOKEN`, all API keys.
3. Set **`STATE_REMOTE=true`** on the runner (so it restores state from the hub).
4. Cron the same commands (`npm run campaign -- --warmup` and `-- --top-up`) on the
   same schedule.
5. **Disable the Mac crons** (`launchctl unload …send.plist …warmup.plist`) — the
   run-lock is a LOCAL pidfile, so it will NOT stop a Mac + cloud double-send. Only
   one host may run the crons at a time. (Or point the Mac at `STATE_REMOTE` too and
   keep exactly one enabled.)
6. Verify: first cloud run logs `[state] restored from hub backup` with the right
   warmup day; check the Mini App "отправлено" + inbox_health.

## Consequences
- ✅ Sending survives Mac death/power-loss once on the runner.
- ✅ State round-trips through Supabase — no data loss on host swap.
- ⚠️ Exactly-one-host rule (no cross-host lock). Document + owner-enforced.
- ⚠️ Gmail OAuth token must be present on the runner (owner copies; never committed).
- Not done here: provisioning + secrets (owner accounts). Code is ready.
