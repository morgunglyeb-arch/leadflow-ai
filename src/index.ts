import { loadConfig } from "./config.js";
import { runEnrichment, type RunFlags } from "./orchestrator.js";

function parseFlags(argv: string[]): RunFlags {
  const flags: RunFlags = { dry: false, mock: false, force: false, sendTest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--dry") flags.dry = true;
    else if (a === "--mock") flags.mock = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--send-test") flags.sendTest = true;
    else if (a === "--input") flags.input = argv[++i];
    else if (a.startsWith("--input=")) flags.input = a.slice("--input=".length);
    else if (a === "--limit") flags.limit = Number.parseInt(argv[++i] ?? "0", 10);
    else if (a.startsWith("--limit=")) flags.limit = Number.parseInt(a.slice("--limit=".length), 10);
    else if (a === "--concurrency")
      flags.concurrency = Number.parseInt(argv[++i] ?? "0", 10);
    else if (a.startsWith("--concurrency="))
      flags.concurrency = Number.parseInt(a.slice("--concurrency=".length), 10);
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return flags;
}

function printHelp(): void {
  console.log(`LeadFlow AI — agentic lead enrichment + cold-outreach personalization

Usage:
  npm run leads -- [flags]        # enrich + personalize an existing CSV/Sheet
  npm run prospect -- [flags]     # discover NEW leads, then enrich + pitch + draft

Flags:
  --dry                Print rows, don't write CSV / drafts / Sheets / send email
  --mock               Use fixtures (no network) — sites and discovery results
  --input=PATH         (leads) Use a different leads CSV than LEADS_CSV_PATH
  --limit=N            Process only the first N leads
  --concurrency=N      Override CONCURRENCY (default 5)
  --force              Ignore cache + idempotency (reprocess everything)
  --send-test          Email the first row through Resend (smoke test)
  --help, -h           Show this message

Examples:
  npm run leads -- --mock --dry              # offline demo on fixtures
  npm run leads -- --input=data/leads.csv    # real list, write CSV + drafts
  npm run prospect -- --mock --dry           # offline discovery → pitch demo
`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const flags = parseFlags(process.argv.slice(2));
  const cfg = loadConfig();
  runEnrichment(cfg, flags).catch((err) => {
    console.error("[leadflow] fatal:", err);
    process.exit(1);
  });
}

export { runEnrichment };
