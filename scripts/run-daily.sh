#!/usr/bin/env bash
# Daily LeadFlow prospecting run.
#   - discovers up to MAX_LEADS new leads from config/icp.json
#   - skips domains/emails already in the output CSV (idempotent: new ones daily)
#   - filters by --min-fit, finds emails, writes drafts + digest
#   - emails the digest to EMAIL_DIGEST_TO (RU analysis + EN drafts)
#
# Wire it to cron or launchd (see README "Daily automation").
set -euo pipefail

# Resolve project root from this script's location (works under cron/launchd).
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

# Ensure node/npm are on PATH under launchd (adjust if you use nvm/Homebrew).
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

MIN_FIT="${MIN_FIT:-3}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] LeadFlow daily run starting (min-fit=$MIN_FIT)"
npm run prospect -- --digest --min-fit="$MIN_FIT"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] LeadFlow daily run done"
