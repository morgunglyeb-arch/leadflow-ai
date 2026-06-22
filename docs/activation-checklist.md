# Activation checklist — turning the engine on

Everything here is **operator action** (Claude can't enter secrets or manage
Vercel env). Order is deliberate. Nothing here sends cold mail to a prospect
until the very last step, and only after `SENDING_ENABLED=true`.

## 0. Status (what's already done)
- Code: gates (deliverability/PECR/spam), enrichment (Firecrawl/Hunter/web), peer
  warmup, telemetry — all shipped, `origin/main`. 31 tests green.
- LeadFlow → hub env (`OPERO_OPS_URL`, `INGEST_BEARER_TOKEN`) already set; emits on
  any real run.
- `heyopero.com` deliverability: SPF/DKIM/DMARC/MX all green. 3 inboxes live.
- `opero-team.com` + `withopero.com` went Active 2026-06-22 (Cloudflare integration).
- Real lead list built: `data/out/drafts/` (8 UK clinics) — review these.
- Companies House key live (HTTP 200); PECR gate validated on real clinics (3/5 of
  the batch confirmed registered → emailable; 2 held as not-found, correct PECR).

## Mailbox roster — 9 inboxes / 3 domains (sending identities)
British names on purpose (trust with UK clinics). First-name local part.

| Domain | Email | First | Last |
|---|---|---|---|
| heyopero.com | anna@heyopero.com | Anna | Bennett |
| heyopero.com | sofia@heyopero.com | Sofia | Carter |
| heyopero.com | james@heyopero.com | James | Hughes |
| opero-team.com | emma@opero-team.com | Emma | Walsh |
| opero-team.com | daniel@opero-team.com | Daniel | Reed |
| opero-team.com | grace@opero-team.com | Grace | Turner |
| withopero.com | thomas@withopero.com | Thomas | Clarke |
| withopero.com | lucy@withopero.com | Lucy | Hayes |
| withopero.com | jack@withopero.com | Jack | Ellis |

⚠️ **LeadFlow still sends from 3 personal @gmail accounts**, NOT these 9. Before
warmup/send: set `.env` `GMAIL_ACCOUNTS` to the 9 addresses above (+ `GMAIL_SENDER`
to one of them), then `rm secrets/gmail_token_*.json` and `npm run campaign -- --auth`
to OAuth each. Warming the wrong (personal) inboxes for 2–3 weeks would be wasted.

## 1. Start warmup on the 3 live inboxes NOW (don't wait for 9)
Peer-warmup needs ≥2 inboxes; you have 3 on `heyopero.com`. Start the 2–3 week
clock today; the other domains join the rotation when they go Active.

**1a. Re-authorize all 3 inboxes for the new `gmail.modify` scope.**
⚠️ GOTCHA: `--auth` SKIPS any inbox that already has a token file, so it will NOT
request the new scope on its own. Delete the old tokens first:
```sh
cd /Users/a1/LeadFlow-AI
rm -f secrets/gmail_token_*.json          # forces a fresh consent
npm run campaign -- --auth                # approve each of the 3 inboxes
```
(Approve the consent screen that now lists "read, compose, send, and permanently
delete" — that's `gmail.modify`, needed to rescue warmup mail from Spam.)

**1b. Enable warmup** in `.env`:
```
WARMUP_ENABLED=true
```
(Defaults are already the safe protocol: ramp 2→8/inbox/day over 3 weeks, reply
rate 0.33, cold first-touches held until warmup day 14.)

**1c. Schedule the warmup pass once a day.** LeadFlow is a local CLI, so this
needs the Mac awake. `crontab -e` and add:
```
30 10 * * * cd /Users/a1/LeadFlow-AI && /usr/bin/npm run campaign -- --warmup >> ~/leadflow-warmup.log 2>&1
```
Verify a pass by hand first: `npm run campaign -- --warmup` (with WARMUP_ENABLED=true).

## 1.5 ⚠️ BLOCKER before any send — Companies House API key (free)
The PECR gate (`SEND_CORPORATE_ONLY=true`, on by default) only auto-sends to
clearly-incorporated entities. Most clinics trade under a plain name ("Balham
Physio", "Dentaprime UK") with no "Ltd" in it, so the name heuristic alone
**holds nearly all of them** — your funnel silently empties even with great leads.

The fix is the Companies House register lookup, which confirms the real legal
entity behind the trading name. It's free:
1. Register at `developer.company-information.service.gov.uk` → create an
   application → get an API key.
2. Add to LeadFlow `.env`: `COMPANIES_HOUSE_API_KEY=...`

With it set, "Balham Physio" → resolves to its registered company → emailable.
Without it, either accept that only "...Ltd"-named clinics send, or (riskier
under PECR) set `SEND_CORPORATE_ONLY=false`. Recommended: get the key.

## 2. opero-ops Vercel env (energize the analytics)
`vercel.com/morgunglyeb-5974s-projects/opero-ops/settings/environment-variables`
- `SENDING_DOMAINS=heyopero.com` (add `,opero-team.com,withopero.com` when Active).
  Production scope → Save → Redeploy. (Until set, the blacklist-sweep cron no-ops.)
- (optional, later) `GCP_SERVICE_ACCOUNT_JSON` for Postmaster Stage 2 — steps in
  `../../../opero-ops/docs/inbox-analytics.md`.
- Confirm `INGEST_BEARER_TOKEN` here equals the one in LeadFlow `.env` (the site
  already uses it, so it should match).

## 3. Rotate the leaked keys (dashboards; you enter the values)
- **Hunter:** hunter.io → API → Regenerate → put it in LeadFlow `.env` `HUNTER_API_KEY`.
- **Vercel token:** vercel.com/account/tokens → Revoke old, Create new → update wherever used.
- **Telegram bot:** @BotFather → `/revoke` → new token → update `TELEGRAM_BOT_TOKEN`
  in opero-ops Vercel → re-run `setWebhook` with the secret.

## 4. Verify the loop is alive (safe, no sending)
```sh
cd /Users/a1/LeadFlow-AI
npm run prospect -- --top-up --dry        # discovers + emits run.start/run.end to the hub
```
You should get a Telegram digest from opero-ops. That confirms LeadFlow → hub works.

## 5. (Weeks later, after warmup matures) first real sends
- Re-run `deliverability-audit` on every Active domain → all green + Postmaster Good/High.
- Set `SEND_PER_RUN_CAP` (e.g. 5) and add an hourly campaign cron in 9–18 to spread volume.
- Only then flip `SENDING_ENABLED=true`. Start tiny; watch bounce/spam in opero-ops.

---
_Parallel, no-warmup path to client #1 (start today): see `gtm-assets.md`._
