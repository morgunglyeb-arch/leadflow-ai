import { loadConfig } from "./config.js";
import { runProspecting, type ProspectFlags } from "./prospect.js";

function parseFlags(argv: string[]): ProspectFlags {
  const flags: ProspectFlags = {
    dry: false,
    mock: false,
    force: false,
    sendTest: false,
    digest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--dry") flags.dry = true;
    else if (a === "--mock") flags.mock = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--send-test") flags.sendTest = true;
    else if (a === "--digest") flags.digest = true;
    else if (a === "--limit") flags.limit = Number.parseInt(argv[++i] ?? "0", 10);
    else if (a.startsWith("--limit=")) flags.limit = Number.parseInt(a.slice("--limit=".length), 10);
    else if (a === "--concurrency") flags.concurrency = Number.parseInt(argv[++i] ?? "0", 10);
    else if (a.startsWith("--concurrency="))
      flags.concurrency = Number.parseInt(a.slice("--concurrency=".length), 10);
    else if (a === "--min-fit") flags.minFit = Number.parseInt(argv[++i] ?? "0", 10);
    else if (a.startsWith("--min-fit=")) flags.minFit = Number.parseInt(a.slice("--min-fit=".length), 10);
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return flags;
}

function printHelp(): void {
  console.log(`LeadFlow AI — prospecting agent (discover → enrich → pitch → draft)

Usage:
  npm run prospect -- [flags]

Reads your ICP from config/icp.json, discovers leads via DISCOVERY_SOURCE
(search | maps | vibe), enriches each from its site, writes an automation
pitch, and queues a personalized draft email per lead for your review.

Flags:
  --dry                Print rows, don't write CSV / drafts
  --mock               Use discovery + site fixtures (no network)
  --limit=N            Cap total discovered leads (overrides MAX_LEADS)
  --concurrency=N      Override CONCURRENCY (default 5)
  --min-fit=N          Mark leads with fit_score < N as 'skipped'
  --force              Ignore cache + idempotency
  --digest             Email the digest (RU analysis + EN drafts) to EMAIL_DIGEST_TO
  --send-test          Email the top row through Resend (smoke test)
  --help, -h           Show this message

Examples:
  npm run prospect -- --mock --dry              # offline discovery → pitch demo
  npm run prospect -- --limit=50 --min-fit=3    # 50 leads, drop weak fits
  npm run prospect -- --digest --min-fit=3      # daily: find, filter, email me
`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const flags = parseFlags(process.argv.slice(2));
  const cfg = loadConfig();
  runProspecting(cfg, flags).catch((err) => {
    console.error("[prospect] fatal:", err);
    process.exit(1);
  });
}

export { runProspecting };
