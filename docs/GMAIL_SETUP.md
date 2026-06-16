# Gmail setup — autonomous sending (one-time, ~5 min)

The campaign agent sends and reads replies through **your Gmail**. You do this
once; after that the daily run is fully automatic.

> ⚠️ Use a **separate sending domain/inbox** for cold outreach if you can — not
> your main personal Gmail. Cold email can hurt a domain's reputation. Warm the
> inbox first (the agent ramps volume automatically), and keep `SEND_DAILY_CAP`
> conservative.

## 1. Create a Google OAuth client

1. Go to <https://console.cloud.google.com/> → create a project (or pick one).
2. **APIs & Services → Library** → search **Gmail API** → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**. Fill the app name + your email. Add yourself as a
     **Test user** (so you can authorize without app verification).
   - Scopes: you can leave default; the app requests `gmail.send` + `gmail.readonly`.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Desktop app**. Name it anything.
   - **Download JSON**.
5. Save that file as `secrets/gmail_credentials.json` in the project.

## 2. Authorize the app

```bash
npm run campaign -- --auth
```

- It prints a URL. Open it, sign in with the **sending Gmail**, click **Allow**.
- You'll be redirected to `http://localhost:42813` — the command **captures the
  code automatically** (modern loopback flow; no copy-paste).
- A token is saved to `secrets/gmail_token.json` (gitignored). Done.

> If your browser shows "site can't be reached" at localhost:42813, that's fine
> as long as the URL bar shows `?code=...` — the local server already grabbed it.

## 3. Configure `.env`

```
SENDING_ENABLED=true                 # master switch — must be true to send
GMAIL_SENDER=you@yourdomain.com      # the From: address (your authorized Gmail)
SEND_DAILY_CAP=40                    # ceiling once warmed up
SEND_WARMUP_START=10                 # day-1 volume
SEND_WARMUP_STEP=5                   # +N per day
SEND_MIN_SCORE=9                     # only send leads at/above this ROI score
FOLLOWUP_GAP_DAYS=3,7                # follow-up #1 at +3 days, #2 at +7
OPT_OUT_TEXT="Not relevant? Reply 'no' and I won't follow up."
```

## 4. Run it

```bash
# safe preview — discovers, enqueues, shows what it WOULD send (no emails sent):
npm run campaign -- --top-up --dry-run

# go live (after --auth and SENDING_ENABLED=true):
npm run campaign -- --top-up

# check the campaign state any time:
npm run campaign -- --status
```

Each run: polls replies (stops the sequence on any reply), tops up the queue
with fresh qualified leads, sends the strongest ones up to today's warmup cap,
sends due follow-ups to non-repliers, and updates the learning file.

## 5. Schedule it daily

```bash
# edit deploy/com.leadflow.daily.plist to call: npm run campaign -- --top-up
cp deploy/com.leadflow.daily.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.leadflow.daily.plist
```

## How "how many to send" is decided

You don't set a fixed number. Each day the agent sends
`min(warmup-cap-today, leads above SEND_MIN_SCORE)` — strongest first. Volume
ramps with warmup and is gated by lead quality, so it never blasts and always
leads with your best prospects. Spam-flagged drafts are held for manual review.
