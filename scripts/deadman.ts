// Dead-man switch → Telegram (via the opero-ops hub).
// Runs on a weekday afternoon timer (after the 10/12/14 send windows). If ZERO
// mail went out today on a send-day, the pipeline died silently (a stuck cron, a
// lock never released, a bad deploy — exactly the timer-collision that quietly
// ate 2/4 send slots on 2026-07-14). Shout so it's caught THAT day, not a week
// later. Read-only: never sends mail, never mutates state. Reuses the hub's
// existing Telegram bot (OPERO_OPS_URL + INGEST_BEARER_TOKEN) via a passthrough.
import { loadConfig } from "../src/config.js";
import { loadState } from "../src/campaign/store.js";

function isToday(at?: string): boolean {
  return !!at && at.startsWith(new Date().toISOString().slice(0, 10));
}

async function main(): Promise<void> {
  const cfg = loadConfig();

  // Only cry wolf on a real send-day. SEND_DAYS uses JS getDay() (0=Sun..6=Sat);
  // default Mon–Fri. Weekend / non-send-day with 0 sends is EXPECTED, not a fault.
  const sendDays = (process.env.SEND_DAYS ?? "1,2,3,4,5")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  if (!sendDays.includes(new Date().getDay())) {
    console.log("[deadman] non-send-day — skipping check");
    return;
  }

  const state = await loadState(cfg.CAMPAIGN_STATE_PATH);
  let sentToday = 0;
  for (const l of Object.values(state.leads)) {
    for (const h of l.history) {
      if (isToday(h.at) && (h.event === "sent" || h.event === "followup_1" || h.event === "followup_2"))
        sentToday++;
    }
  }

  if (sentToday > 0) {
    console.log(`[deadman] OK — ${sentToday} mail sent today`);
    return;
  }

  const text =
    "🚨 DEAD-MAN: 0 писем ушло сегодня к этому часу (будний день).\n" +
    "Пайплайн, похоже, встал — проверь VPS (send-таймеры/lock/квоты). " +
    "Это тот тип тихого сбоя, что раньше замечали только через дни.";
  console.warn("[deadman] ALERT — 0 sent today");

  const base = process.env.OPERO_OPS_URL;
  const token = process.env.INGEST_BEARER_TOKEN;
  if (!base || !token) {
    console.warn("[deadman] OPERO_OPS_URL/INGEST_BEARER_TOKEN unset — printed only, not sent");
    return;
  }
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/ingest/leadflow`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: "daily_report", text }),
    });
    console.log(`[deadman] alert sent → hub ${res.status}`);
  } catch (e) {
    console.warn(`[deadman] hub POST failed: ${(e as Error).message}`);
  }
}

main().catch((e) => {
  console.error("[deadman] error:", e);
  process.exit(1);
});
