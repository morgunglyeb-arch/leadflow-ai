import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppConfig } from "../config.js";
import { verticalFromQuery } from "../vertical.js";
import type { CampaignLead, CampaignState } from "./store.js";

// Sample-size gates from the experiment ledger: <200 = directional only (noise),
// 200–999 = early signal, ≥1000 = sphere decision-ready, ≥3000 = format significance.
function gateLabel(n: number): string {
  if (n >= 3000) return "✅ N≥3000 (format-sig)";
  if (n >= 1000) return "✅ N≥1000 (decision)";
  if (n >= 200) return "📊 N≥200 (early)";
  return `🔬 N=${n} (<200 directional)`;
}

const LEARNINGS_PATH = "data/campaign/learnings.md";
const WINNERS_PATH = "data/campaign/winners.json";

interface Winner {
  vertical: string;
  subject: string;
  opener: string;
  process: string;
}

function sent(l: CampaignLead): boolean {
  return l.step >= 1;
}
function positive(l: CampaignLead): boolean {
  return l.status === "replied" && l.reply?.sentiment === "interested";
}

/**
 * Analyze outcomes so the agent improves over time: compute reply rates by
 * vertical and by angle, and save the openers/subjects that earned positive
 * replies as few-shot "winners" the prompt can learn from.
 */
export async function summarizeAndLearn(
  state: CampaignState,
  cfg?: AppConfig,
): Promise<string> {
  const leads = Object.values(state.leads);
  const sentLeads = leads.filter(sent);
  const replied = leads.filter((l) => l.status === "replied");
  const interested = leads.filter(positive);

  // E1 experiment cohort — when EXPERIMENT_VERTICALS is set, the sphere signal is
  // buried in a mostly pre-test bank. Isolate the leads whose discovery_query
  // matches a target vertical so the ledger reads the cohort, not the noise pool.
  const exp = cfg?.EXPERIMENT_VERTICALS ?? [];
  const inCohort = (l: CampaignLead): boolean => {
    if (exp.length === 0) return false;
    const q = (l.snapshot.discovery_query ?? "").toLowerCase();
    return exp.some((v) => q.includes(v));
  };
  const cohortSent = sentLeads.filter(inCohort);
  const cohortReplied = cohortSent.filter((l) => l.status === "replied");
  const cohortInterested = cohortSent.filter(positive);

  const byVertical = new Map<string, { sent: number; replied: number; interested: number }>();
  for (const l of sentLeads) {
    const v = verticalFromQuery(l.snapshot.discovery_query) ?? "unknown";
    const e = byVertical.get(v) ?? { sent: 0, replied: 0, interested: 0 };
    e.sent++;
    if (l.status === "replied") e.replied++;
    if (positive(l)) e.interested++;
    byVertical.set(v, e);
  }

  const winners: Winner[] = interested
    .map((l) => ({
      vertical: verticalFromQuery(l.snapshot.discovery_query) ?? "",
      subject: l.snapshot.subject ?? l.subject ?? "",
      opener: l.snapshot.opener ?? "",
      process: l.snapshot.process ?? "",
    }))
    .filter((w) => w.opener)
    .slice(0, 20);

  await mkdir(dirname(WINNERS_PATH), { recursive: true });
  await writeFile(WINNERS_PATH, JSON.stringify(winners, null, 2), "utf8");

  const pct = (a: number, b: number): string => (b === 0 ? "—" : `${Math.round((a / b) * 100)}%`);

  // A/B variant performance. lead.variant now carries the FORMAT variant when
  // EMAIL_FORMAT_AB is on (A = owner-locked menu, B = open/conversion), else the
  // subject A/B — so this section measures whichever A/B is active.
  const ab: Record<string, { sent: number; replied: number }> = {
    A: { sent: 0, replied: 0 },
    B: { sent: 0, replied: 0 },
  };
  for (const l of sentLeads) {
    const v = l.variant ?? "A";
    const e = ab[v] ?? { sent: 0, replied: 0 };
    e.sent++;
    if (l.status === "replied") e.replied++;
  }

  const lines: string[] = [
    `# LeadFlow campaign learnings`,
    ``,
    `Updated ${new Date().toISOString()}`,
    ``,
    `- Sent: **${sentLeads.length}** · Replied: **${replied.length}** (${pct(replied.length, sentLeads.length)}) · Interested: **${interested.length}** (${pct(interested.length, sentLeads.length)})`,
    ``,
    `## A/B variant (format: A=locked menu · B=open; or subject if format-AB off)`,
    `- Variant A: sent ${ab.A!.sent}, replied ${pct(ab.A!.replied, ab.A!.sent)}`,
    `- Variant B: sent ${ab.B!.sent}, replied ${pct(ab.B!.replied, ab.B!.sent)}`,
    ``,
    ...(exp.length > 0
      ? [
          `## 🎯 E1 experiment cohort [${exp.join(", ")}]`,
          `- Cohort sent: **${cohortSent.length}** ${gateLabel(cohortSent.length)} · replied ${pct(cohortReplied.length, cohortSent.length)} · interested ${pct(cohortInterested.length, cohortSent.length)}`,
          ...(cohortSent.length < 200
            ? ["- ⏳ Below the 200/segment directional floor — do NOT call a sphere winner yet."]
            : cohortSent.length < 1000
              ? ["- 📊 Past directional; sphere DECISION needs ~1000/segment. Keep going."]
              : ["- ✅ Decision-ready: scale ≥3% positive-reply, kill <1%."]),
          `- Per target vertical:`,
          ...[...byVertical.entries()]
            .filter(([v]) => exp.some((x) => v.toLowerCase().includes(x)))
            .sort((a, b) => b[1].interested - a[1].interested)
            .map(
              ([v, e]) =>
                `  - ${v}: sent ${e.sent} ${gateLabel(e.sent)}, replied ${pct(e.replied, e.sent)}, interested ${pct(e.interested, e.sent)}`,
            ),
          ``,
        ]
      : []),
    `## Reply rate by niche (all)`,
    ...[...byVertical.entries()]
      .sort((a, b) => b[1].interested - a[1].interested)
      .map(
        ([v, e]) =>
          `- ${v}: sent ${e.sent} ${gateLabel(e.sent)}, replied ${pct(e.replied, e.sent)}, interested ${pct(e.interested, e.sent)}`,
      ),
    ``,
    `## Winning angles (got an interested reply)`,
    ...(winners.length === 0
      ? ["- (none yet — needs more sent volume + replies)"]
      : winners.map((w) => `- [${w.vertical}] "${w.subject}" — ${w.opener.slice(0, 120)}`)),
  ];
  const report = lines.join("\n");
  await writeFile(LEARNINGS_PATH, report + "\n", "utf8");
  return report;
}
