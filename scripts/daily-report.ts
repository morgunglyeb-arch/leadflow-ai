// Nightly readiness report → Telegram (via the opero-ops hub).
// Runs on a systemd timer each evening AFTER the prospect run, so it can truthfully
// say "today done, tomorrow ready". Computes everything from state.json (the source
// of truth for what tomorrow's 10:00 send will actually pick up) — NOT from Supabase,
// which lags and can't see per-lead follow-up due dates.
//
// It NEVER sends mail and NEVER mutates state — read-only. Delivery reuses the hub's
// existing Telegram bot (OPERO_OPS_URL + INGEST_BEARER_TOKEN) via a `daily_report`
// passthrough event, so no new secret lives on the VPS.
import { existsSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { gmailInboxes } from "../src/campaign/gmail.js";
import { loadState } from "../src/campaign/store.js";
import { followupGaps } from "../src/campaign/policy.js";
import type { CampaignLead } from "../src/campaign/store.js";

const DAY_MS = 86_400_000;

function isToday(at?: string): boolean {
  if (!at) return false;
  return at.startsWith(new Date().toISOString().slice(0, 10));
}

function daysSinceEvent(lead: CampaignLead, event: string): number {
  const hit = lead.history.find((h) => h.event === event);
  if (!hit) return Number.POSITIVE_INFINITY;
  return (Date.now() - new Date(hit.at).getTime()) / DAY_MS;
}

function countHistoryToday(lead: CampaignLead, event: string): number {
  return lead.history.filter((h) => h.event === event && isToday(h.at)).length;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const state = await loadState(cfg.CAMPAIGN_STATE_PATH);
  const leads = Object.values(state.leads);
  const gaps = followupGaps(cfg); // e.g. [3, 10] from initial-send

  // ── TODAY (what actually happened) ────────────────────────────────────────
  let coldSentToday = 0;
  let fuSentToday = 0;
  let bankedToday = 0;
  let repliesToday = 0;
  for (const l of leads) {
    coldSentToday += countHistoryToday(l, "sent");
    fuSentToday += countHistoryToday(l, "followup_1") + countHistoryToday(l, "followup_2");
    if (l.history.some((h) => h.event === "queued" && isToday(h.at))) bankedToday++;
    if (isToday(l.reply?.at)) repliesToday++;
  }

  // ── TOMORROW-READY (what the next send will be able to pick up) ────────────
  // Follow-ups: a lead becomes due when days-since-initial ≥ its gap. "Ready for
  // tomorrow" = will have crossed the gap by tomorrow's send (elapsed + 1 ≥ gap),
  // not yet terminal, and its current step's follow-up not yet sent.
  const terminal = new Set(["replied", "soft_decline", "opted_out", "bounced"]);
  let followupsReady = 0;
  for (const l of leads) {
    if (terminal.has(l.status)) continue;
    const elapsed = daysSinceEvent(l, "sent");
    if (!Number.isFinite(elapsed)) continue; // never sent → no follow-up yet
    if (l.step === 1 && gaps[0] !== undefined && elapsed + 1 >= gaps[0]) followupsReady++;
    else if (l.step === 2 && gaps[1] !== undefined && elapsed + 1 >= gaps[1]) followupsReady++;
  }

  // Cold: queued, not spam-flagged, above the score bar, PECR-eligible (is_ltd not
  // explicitly false), and matching an active experiment vertical — the same gates the
  // real cold selector applies in run.ts.
  const exp = (cfg.EXPERIMENT_VERTICALS ?? []).map((v) => v.toLowerCase());
  const matchesWave = (q?: string): boolean => {
    if (!exp.length) return true;
    const s = (q ?? "").toLowerCase();
    return exp.some((v) => s.includes(v));
  };
  const coldReady = leads.filter(
    (l) =>
      l.status === "queued" &&
      !l.flagged &&
      l.score >= cfg.SEND_MIN_SCORE &&
      l.is_ltd !== false &&
      matchesWave(l.snapshot?.discovery_query),
  ).length;

  // ── INBOX HEALTH ──────────────────────────────────────────────────────────
  const inboxes = gmailInboxes(cfg);
  const now = Date.now();
  const paused: string[] = [];
  let tokenMissing = 0;
  for (const b of inboxes) {
    if (!existsSync(b.tokenPath)) tokenMissing++;
    const p = state.inbox_pauses?.[b.email.toLowerCase()];
    if (p && new Date(p.until).getTime() > now) paused.push(`${b.email} (${p.reason})`);
  }
  const inboxesOk = inboxes.length - paused.length - tokenMissing;

  // ── ACTION NEEDED ─────────────────────────────────────────────────────────
  const dailyColdTarget = cfg.SEND_DOMAIN_DAILY_CAP * 3; // 3 domains → daily ceiling
  const actions: string[] = [];
  if (tokenMissing > 0) actions.push(`🔑 ${tokenMissing} ящик(ов) без токена — нужен re-auth`);
  if (paused.length) actions.push(`⏸️ на паузе: ${paused.join("; ")}`);
  if (coldReady < 120)
    actions.push(`❄️ мало холодных на завтра (${coldReady}) — prospect добрал недостаточно`);
  const interestedWaiting = leads.filter(
    (l) => l.status === "replied" && l.reply?.sentiment === "interested",
  ).length;
  if (interestedWaiting > 0) actions.push(`💬 ${interestedWaiting} «интересно» ждут твоего ответа`);

  // ── FORMAT (Russian) ──────────────────────────────────────────────────────
  const d = new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  const lines = [
    `🌙 <b>Вечерний отчёт LeadFlow</b> — ${d}`,
    ``,
    `📦 <b>Сегодня сделано:</b>`,
    `• 🆕 забанковано новых: ${bankedToday}`,
    `• 📤 отправлено: ${coldSentToday} холодных + ${fuSentToday} фоллоуапов`,
    `• 💬 ответов: ${repliesToday}`,
    ``,
    `✅ <b>На завтра готово:</b>`,
    `• 📮 фоллоуапы: ${followupsReady}`,
    `• ❄️ холодные в очереди: ${coldReady} (потолок ${dailyColdTarget}/день)`,
    `• 📬 почты: ${inboxesOk}/${inboxes.length} в порядке`,
    ``,
    actions.length
      ? `⚠️ <b>Требует внимания:</b>\n${actions.map((a) => `• ${a}`).join("\n")}`
      : `👍 Всё перепроверено — вмешательства не требуется.`,
  ];
  const text = lines.join("\n");
  console.log(text.replace(/<\/?b>/g, "")); // plain copy into the log for debugging

  // ── DELIVER (hub passthrough → Telegram) ─────────────────────────────────
  const base = process.env.OPERO_OPS_URL;
  const token = process.env.INGEST_BEARER_TOKEN;
  if (!base || !token) {
    console.log(text);
    console.warn("[daily-report] OPERO_OPS_URL/INGEST_BEARER_TOKEN unset — printed only, not sent");
    return;
  }
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/ingest/leadflow`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: "daily_report", text }),
      signal: AbortSignal.timeout(10_000),
    });
    console.log(`[daily-report] sent → hub ${res.status}`);
  } catch (err) {
    console.error(`[daily-report] delivery failed: ${(err as Error).message}`);
    console.log(text);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[daily-report] fatal:", err);
  process.exit(1);
});
