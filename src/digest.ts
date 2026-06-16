import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppConfig } from "./config.js";
import type { OutputRow } from "./types.js";

export interface DigestResult {
  ok: boolean;
  id?: string;
  error?: string;
  recipients?: number;
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fitColor(n: number): string {
  return (
    ({ 1: "#7f1d1d", 2: "#9a3412", 3: "#854d0e", 4: "#166534", 5: "#15803d" } as Record<
      number,
      string
    >)[n] ?? "#374151"
  );
}

function leadCard(row: OutputRow, i: number, intro?: string): string {
  const fit = row.fit_score ?? 0;
  const email = row.email
    ? `<a href="mailto:${esc(row.email)}">${esc(row.email)}</a>${row.email_source === "site" ? " <span style=\"color:#94a3b8\">(с сайта)</span>" : ""}`
    : '<span style="color:#b91c1c">email не найден — найди вручную</span>';
  const draftBody = esc(row.opener ?? "")
    ? buildDraftPreview(row, intro)
    : "(черновик не сгенерирован)";

  return `
<tr><td style="padding:16px 0;border-top:1px solid #e5e7eb;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td>
      <div style="font-size:16px;font-weight:700;color:#111;">${i}. ${esc(row.company)}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:2px;">
        ${esc(row.domain)}${row.location ? " · " + esc(row.location) : ""}${row.phone ? " · " + esc(row.phone) : ""}
      </div>
    </td>
    <td align="right" valign="top" style="width:64px;">
      <span style="display:inline-block;background:${fitColor(fit)};color:#fff;font-weight:700;
        border-radius:8px;padding:4px 10px;font-size:14px;">fit ${fit || "?"}</span>
    </td>
  </tr></table>

  <div style="background:#f1f5f9;border-radius:8px;padding:10px 12px;margin:10px 0;font-size:14px;color:#1f2937;">
    <b>Разбор:</b> ${esc(row.brief)}
  </div>

  <div style="font-size:13px;color:#374151;margin-bottom:6px;">
    📧 <b>Кому:</b> ${email}
  </div>

  <div style="background:#0b0f17;color:#e5e7eb;border-radius:8px;padding:12px 14px;font-size:13px;
    font-family:ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;line-height:1.5;">
<b style="color:#93c5fd;">Subject:</b> ${esc(row.subject)}

${draftBody}</div>
  ${followupBlock(row)}
</td></tr>`;
}

function followupBlock(row: OutputRow): string {
  const items = [
    { f: row.followup_1, d: 3 },
    { f: row.followup_2, d: 7 },
  ].filter((x) => x.f);
  if (items.length === 0) return "";
  const rows = items
    .map(
      (x, i) =>
        `<div style="margin-top:6px;"><b style="color:#64748b;">Follow-up ${i + 1}</b> <span style="color:#94a3b8;">(через ~${x.d} дн., если нет ответа)</span><br>${esc(x.f)}</div>`,
    )
    .join("");
  return `<details style="margin-top:8px;"><summary style="cursor:pointer;color:#2563eb;font-size:12px;">+ серия follow-up (2 письма)</summary>
  <div style="font-size:12px;color:#334155;padding:8px 10px;background:#f8fafc;border-radius:8px;margin-top:6px;">${rows}</div></details>`;
}

function buildDraftPreview(row: OutputRow, intro?: string): string {
  // Mirror the assembled draft body (greeting addresses the business, not a person).
  const short = (row.company.split(/[-–—|,:]/)[0] ?? "").trim();
  const greet = short.length >= 2 ? `Hi ${esc(short)} team,` : "Hello,";
  const parts: string[] = [greet, ""];
  if (intro) parts.push(esc(intro), "");
  parts.push(esc(row.opener ?? ""));
  const services = row.services ?? [];
  if (services.length > 0) {
    parts.push("", "A few things we could set up for you:");
    for (const s of services) parts.push(esc(`• ${s.replace(/[.!;,\s]+$/, "")}`));
  } else if (row.automation) {
    const a = row.automation.trim().replace(/[.!;,\s]+$/, "");
    parts.push("", esc(a.charAt(0).toUpperCase() + a.slice(1) + "."));
  }
  if (row.demo) {
    const d = row.demo.trim().replace(/^["'“”]+|["'“”]+$/g, "");
    parts.push("", "For example, here's what your customers would get:", esc(`"${d}"`));
  }
  return parts.join("\n");
}

export function renderDigestHtml(rows: OutputRow[], cfg: AppConfig): string {
  const today = new Date().toISOString().slice(0, 10);
  const withEmail = rows.filter((r) => r.email).length;
  const strong = rows.filter((r) => (r.fit_score ?? 0) >= 4).length;
  const sorted = rows; // already ROI-ranked by the orchestrator

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LeadFlow — лиды на ${today}</title></head>
<body style="margin:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:24px 0;"><tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:14px;padding:28px 32px;max-width:640px;">
  <tr><td>
    <div style="font-size:20px;font-weight:800;color:#111;">LeadFlow — лиды на ${today}</div>
    <div style="font-size:13px;color:#6b7280;margin-top:6px;">
      Всего <b>${rows.length}</b> · с email <b>${withEmail}</b> · сильный фит (4–5) <b>${strong}</b> ·
      провайдер ${esc(cfg.LLM_PROVIDER)}
    </div>
    <div style="font-size:13px;color:#374151;margin-top:12px;background:#fef9c3;border-radius:8px;padding:10px 12px;">
      Прочитай «Разбор» по каждому, выбери кого писать — и отправь готовый английский текст вручную с своей почты.
    </div>
  </td></tr>
  ${sorted.map((r, i) => leadCard(r, i + 1, cfg.SENDER_INTRO)).join("")}
  <tr><td style="padding-top:18px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">
    Сгенерировано LeadFlow AI · фильтр fit, анализ и тексты — автоматически, факты только из сайтов компаний.
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

export function renderDigestText(rows: OutputRow[]): string {
  const sorted = rows; // already ROI-ranked
  return sorted
    .map((r, i) => {
      const lines = [
        `${i + 1}. ${r.company} (${r.domain}) — fit ${r.fit_score ?? "?"}`,
        `Кому: ${r.email ?? "email не найден"}${r.phone ? " · " + r.phone : ""}`,
        `Разбор: ${r.brief ?? ""}`,
        `Subject: ${r.subject ?? ""}`,
        `${r.opener ?? ""}`,
      ];
      return lines.join("\n");
    })
    .join("\n\n———\n\n");
}

/** Always-on local preview of the digest, so you can read it without email set up. */
export async function writeDigestFile(cfg: AppConfig, rows: OutputRow[]): Promise<string> {
  await mkdir(dirname(cfg.DIGEST_HTML_PATH), { recursive: true });
  await writeFile(cfg.DIGEST_HTML_PATH, renderDigestHtml(rows, cfg), "utf8");
  return cfg.DIGEST_HTML_PATH;
}

export async function sendDigest(cfg: AppConfig, rows: OutputRow[]): Promise<DigestResult> {
  if (!cfg.RESEND_API_KEY || !cfg.EMAIL_FROM || !cfg.EMAIL_DIGEST_TO) {
    return { ok: false, error: "RESEND_API_KEY / EMAIL_FROM / EMAIL_DIGEST_TO not all set" };
  }
  if (rows.length === 0) return { ok: false, error: "no leads to send" };

  const to = cfg.EMAIL_DIGEST_TO.split(",").map((s) => s.trim()).filter(Boolean);
  const today = new Date().toISOString().slice(0, 10);
  const strong = rows.filter((r) => (r.fit_score ?? 0) >= 4).length;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: cfg.EMAIL_FROM,
        to,
        subject: `LeadFlow: ${rows.length} лидов на ${today} (сильных ${strong})`,
        html: renderDigestHtml(rows, cfg),
        text: renderDigestText(rows),
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) return { ok: false, error: `resend ${res.status}: ${json.message ?? "unknown"}` };
    return { ok: true, id: json.id, recipients: to.length };
  } catch (err) {
    return { ok: false, error: `network: ${(err as Error).message}` };
  }
}
