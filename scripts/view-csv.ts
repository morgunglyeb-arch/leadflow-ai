import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const inputPath = process.argv[2] ?? "data/out/leads_enriched.csv";
const outputPath = process.argv[3] ?? "data/out/leads_enriched.html";

function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (c === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const FIT_COLOR: Record<number, string> = {
  1: "#7f1d1d",
  2: "#9a3412",
  3: "#854d0e",
  4: "#166534",
  5: "#15803d",
};

async function main(): Promise<void> {
  let text = await readFile(inputPath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) {
    console.error("Empty CSV");
    process.exit(1);
  }
  const header = splitLine(lines[0]!);
  const rows = lines.slice(1).map(splitLine);
  const idx = (k: string): number => header.indexOf(k);

  const cardHtml = rows
    .map((r) => {
      const get = (k: string): string => r[idx(k)] ?? "";
      const company = get("company");
      const domain = get("domain");
      const name = get("name");
      const role = get("role");
      const email = get("email");
      const enriched = get("enriched") === "true";
      const enrichmentSource = get("enrichment_source");
      const aiProvider = get("ai_provider");
      const subject = get("subject");
      const opener = get("opener");
      const icebreaker = get("icebreaker");
      const reason = get("reason");
      const process = get("process");
      const automation = get("automation");
      const estBenefit = get("est_benefit");
      const discoverySource = get("discovery_source");
      const discoveryQuery = get("discovery_query");
      const status = get("status") || "draft";
      const phone = get("phone");
      const location = get("location");
      const fit = Number.parseInt(get("fit_score"), 10) || 0;
      const signals = get("signals").split("|").filter(Boolean);

      const fitColor = FIT_COLOR[fit] ?? "#374151";
      const providerBadge = (() => {
        const map: Record<string, [string, string]> = {
          groq: ["#7c3aed", "GROQ"],
          anthropic: ["#d97706", "CLAUDE"],
          fallback: ["#475569", "FALLBACK"],
        };
        const [bg, label] = map[aiProvider] ?? ["#475569", aiProvider.toUpperCase()];
        return `<span class="badge" style="background:${bg}">${esc(label)}</span>`;
      })();
      const srcBadge = `<span class="badge" style="background:#334155">${esc(enrichmentSource)}</span>`;
      const discoveryBadge = discoverySource
        ? `<span class="badge" style="background:#1d4ed8">via ${esc(discoverySource)}</span>`
        : "";
      const statusBadge = (() => {
        const map: Record<string, string> = {
          draft: "#854d0e",
          approved: "#166534",
          sent: "#15803d",
          skipped: "#7f1d1d",
        };
        return `<span class="badge" style="background:${map[status] ?? "#475569"}">${esc(status)}</span>`;
      })();
      const enrichedBadge = enriched
        ? `<span class="badge" style="background:#166534">enriched ✓</span>`
        : `<span class="badge" style="background:#7f1d1d">not enriched ✗</span>`;

      const signalsHtml = signals
        .map((s) => `<span class="sig">${esc(s)}</span>`)
        .join("");

      const hasPitch = process && process.toLowerCase() !== "unclear from site" && automation;
      const pitchHtml = hasPitch
        ? `<div class="pitch">
    <div class="pitch-label">automation pitch</div>
    <div class="pitch-row"><span class="k">manual process</span><span class="v">${esc(process)}</span></div>
    <div class="pitch-row"><span class="k">we'd automate</span><span class="v">${esc(automation)}</span></div>
    ${estBenefit ? `<div class="pitch-row"><span class="k">benefit</span><span class="v">${esc(estBenefit)}</span></div>` : ""}
  </div>`
        : "";

      return `
<article class="card">
  <header class="card-head">
    <div class="who">
      <h2>${esc(company)}</h2>
      <div class="meta">
        <span class="domain">${esc(domain)}</span>
        ${name ? `· <span>${esc(name)}</span>` : ""}
        ${role ? `· <span class="role">${esc(role)}</span>` : ""}
      </div>
      ${email ? `<div class="email">${esc(email)}${phone ? ` · ${esc(phone)}` : ""}</div>` : ""}
      ${location ? `<div class="email">${esc(location)}</div>` : ""}
      ${discoveryQuery ? `<div class="email">found via: "${esc(discoveryQuery)}"</div>` : ""}
    </div>
    <div class="fit" style="background:${fitColor}">
      <div class="fit-n">${fit || "?"}</div>
      <div class="fit-l">fit / 5</div>
    </div>
  </header>

  <div class="badges">
    ${statusBadge}
    ${providerBadge}
    ${srcBadge}
    ${discoveryBadge}
    ${enrichedBadge}
  </div>

  ${pitchHtml}

  <div class="email-preview">
    <div class="row"><label>subject</label><div class="subject">${esc(subject)}</div></div>
    <div class="row"><label>opener</label><div class="opener">${esc(opener)}</div></div>
    <div class="row"><label>icebreaker</label><div class="icebreaker">${esc(icebreaker)}</div></div>
    <div class="row"><label>why fit ${fit}</label><div class="reason">${esc(reason)}</div></div>
  </div>

  ${signals.length > 0 ? `<div class="sigs">${signalsHtml}</div>` : ""}
</article>`;
    })
    .join("\n");

  const stats = (() => {
    const total = rows.length;
    const enrichedCount = rows.filter((r) => r[idx("enriched")] === "true").length;
    const byProvider: Record<string, number> = {};
    const fitDist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of rows) {
      const p = r[idx("ai_provider")] ?? "?";
      byProvider[p] = (byProvider[p] ?? 0) + 1;
      const f = Number.parseInt(r[idx("fit_score")] ?? "0", 10);
      if (f >= 1 && f <= 5) fitDist[f] = (fitDist[f] ?? 0) + 1;
    }
    const provLine = Object.entries(byProvider)
      .map(([k, v]) => `${k}: ${v}`)
      .join(" · ");
    const fitLine = [1, 2, 3, 4, 5]
      .map((n) => `<span style="color:${FIT_COLOR[n]};font-weight:600">${n}</span>:${fitDist[n] ?? 0}`)
      .join("  ");
    return { total, enrichedCount, provLine, fitLine };
  })();

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>LeadFlow AI — enriched leads</title>
<style>
  :root {
    --bg:#0b0f17; --panel:#111827; --panel-2:#1a2235;
    --border:#1f2937; --muted:#94a3b8; --text:#e5e7eb; --accent:#60a5fa;
  }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", Roboto, sans-serif;
         background: var(--bg); color: var(--text); margin:0; padding:32px 40px;
         line-height:1.55; }
  .page-head { max-width: 1100px; margin: 0 auto 28px; }
  .page-head h1 { font-size: 22px; font-weight: 700; margin:0 0 6px; }
  .page-head .sub { color: var(--muted); font-size: 13px; }
  .page-head code { background:#1e293b; padding:2px 6px; border-radius:4px; color:#cbd5e1; }
  .stats { display:flex; gap:28px; margin-top:14px; font-size:13px; color:var(--muted); }
  .stats b { color: var(--text); }

  .grid { display:grid; grid-template-columns: 1fr; gap:18px;
          max-width: 1100px; margin: 0 auto; }

  .card { background: var(--panel); border: 1px solid var(--border);
          border-radius: 14px; padding: 22px 24px; }

  .card-head { display:flex; justify-content:space-between; align-items:flex-start; gap:18px; }
  .who h2 { margin:0 0 4px; font-size:18px; font-weight:600; color:#fff; }
  .who .meta { color: var(--muted); font-size:13px; }
  .who .meta .domain { color:#cbd5e1; }
  .who .meta .role { color:#cbd5e1; }
  .who .email { color: var(--muted); font-size:12px; margin-top:4px; font-family: "SF Mono", Menlo, monospace; }

  .fit { width:64px; min-height:64px; border-radius:12px; color:#fff;
         display:flex; flex-direction:column; align-items:center; justify-content:center;
         flex-shrink:0; }
  .fit .fit-n { font-size:26px; font-weight:700; line-height:1; }
  .fit .fit-l { font-size:10px; text-transform:uppercase; letter-spacing:0.08em; opacity:0.85; margin-top:2px; }

  .badges { display:flex; gap:6px; margin:14px 0 0; flex-wrap:wrap; }
  .badge { font-size:10px; font-weight:600; padding:3px 8px; border-radius:10px;
           color:#fff; text-transform:uppercase; letter-spacing:0.05em; }

  .pitch { margin-top:16px; background:#0c1626; border:1px solid #1d3a5f; border-radius:10px; padding:14px 16px; }
  .pitch-label { font-size:10px; text-transform:uppercase; letter-spacing:0.1em; color:#60a5fa; font-weight:700; margin-bottom:8px; }
  .pitch-row { display:grid; grid-template-columns:120px 1fr; gap:12px; padding:4px 0; font-size:13px; }
  .pitch-row .k { color:var(--muted); font-size:10px; text-transform:uppercase; letter-spacing:0.06em; font-weight:600; padding-top:2px; }
  .pitch-row .v { color:#e5e7eb; }

  .email-preview { margin-top:18px; border-top:1px dashed var(--border); padding-top:16px; }
  .row { display:grid; grid-template-columns: 110px 1fr; gap:14px; padding:8px 0;
         border-bottom: 1px dashed #182235; }
  .row:last-child { border-bottom: none; }
  .row label { color: var(--muted); font-size:10px; text-transform: uppercase;
               letter-spacing:0.08em; font-weight:600; padding-top:2px; }
  .row .subject { font-weight:600; color:#fff; }
  .row .opener, .row .icebreaker { color: var(--text); }
  .row .reason { color: var(--muted); font-style: italic; font-size:13px; }

  .sigs { margin-top:14px; display:flex; flex-wrap:wrap; gap:4px; }
  .sig { background:#1e293b; color:#94a3b8; font-size:10px; padding:2px 8px;
         border-radius:8px; font-family:"SF Mono", Menlo, monospace; }
</style>
</head>
<body>
  <div class="page-head">
    <h1>LeadFlow AI — enriched leads</h1>
    <div class="sub">
      <b style="color:#e5e7eb">${stats.total} leads</b> ·
      source <code>${esc(inputPath)}</code> ·
      generated ${new Date().toISOString()}
    </div>
    <div class="stats">
      <div><b>${stats.enrichedCount}/${stats.total}</b> enriched</div>
      <div>providers: <b>${esc(stats.provLine)}</b></div>
      <div>fit&nbsp;dist: ${stats.fitLine}</div>
    </div>
  </div>
  <main class="grid">
    ${cardHtml}
  </main>
</body>
</html>`;

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf8");
  console.log(`Wrote ${rows.length} cards → ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
