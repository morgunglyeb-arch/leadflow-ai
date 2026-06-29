// One-time pre-cold-flip checkpoint reminder (fires via launchd on 5 July 2026).
// Runs light deliverability DNS checks on the 3 sending domains and posts a
// reminder + flip-checklist to the owner's Telegram via the opero-ops error ingest
// (same path as LeadFlow error alerts). Best-effort; no-op without OPERO_OPS_URL.
require("dotenv").config();
const { execSync } = require("node:child_process");

const DOMAINS = ["heyopero.com", "opero-team.com", "withopero.com"];

function dig(args) {
  try {
    return execSync(`dig +short ${args}`, { timeout: 8000 }).toString().trim();
  } catch {
    return "";
  }
}
function checkDomain(d) {
  const spf = /v=spf1/i.test(dig(`TXT ${d}`));
  const dmarc = /v=DMARC1/i.test(dig(`TXT _dmarc.${d}`));
  const dkim = /(v=DKIM1|p=)/i.test(dig(`TXT google._domainkey.${d}`));
  const mx = dig(`MX ${d}`).length > 0;
  const ok = spf && dmarc && dkim && mx;
  return `${ok ? "✅" : "⚠️"} ${d}: SPF ${spf ? "✓" : "✗"} DKIM ${dkim ? "✓" : "✗"} DMARC ${dmarc ? "✓" : "✗"} MX ${mx ? "✓" : "✗"}`;
}

async function main() {
  const base = process.env.OPERO_OPS_URL;
  const token = process.env.INGEST_BEARER_TOKEN;
  const perDomain = DOMAINS.map(checkDomain);
  const fails = perDomain.filter((l) => l.startsWith("⚠️"));
  const dnsSummary = fails.length === 0 ? "✅ DNS ОК на 3 доменах" : `⚠️ ПРОБЕЛЫ:\n${fails.join("\n")}`;

  // Telegram message — kept < 500 chars (opero-ops error-ingest title cap).
  const title = [
    "⏰ ПРЕД-ФЛИП ЧЕКПОЙНТ — прогрев день 14 (мин. зрелость).",
    `Deliverability: ${dnsSummary}`,
    "Чек-лист до SENDING_ENABLED=true: EMAIL_VERIFY=true · починить ZeroBounce-ключ · warmup день≥14 + спам≈0 · inbox-placement тест · просмотреть «Рассылку».",
    "НЕ флипать без явного «да» владельца. Рамп ~6–9 июля: 5/ящик/день +2, кап 25, 9 ящиков.",
  ].join("\n");

  console.log(perDomain.join("\n"));
  console.log(title, "\n(len:", title.length, ")");
  if (!base || !token) {
    console.log("[flip-reminder] OPERO_OPS_URL/INGEST_BEARER_TOKEN not set — printed only.");
    return;
  }
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/ingest/error`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        source: "leadflow",
        title,
        level: "error",
        fingerprint: "leadflow:flip-reminder:2026-07-05",
      }),
      signal: AbortSignal.timeout(8000),
    });
    console.log("[flip-reminder] posted →", res.status);
  } catch (e) {
    console.log("[flip-reminder] post failed:", e.message);
  }
}
main();
