import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { verticalFromQuery } from "../vertical.js";
import type { CampaignLead, CampaignState } from "./store.js";

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
export async function summarizeAndLearn(state: CampaignState): Promise<string> {
  const leads = Object.values(state.leads);
  const sentLeads = leads.filter(sent);
  const replied = leads.filter((l) => l.status === "replied");
  const interested = leads.filter(positive);

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

  // A/B subject performance
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
    `## A/B subject lines`,
    `- Variant A: sent ${ab.A!.sent}, replied ${pct(ab.A!.replied, ab.A!.sent)}`,
    `- Variant B: sent ${ab.B!.sent}, replied ${pct(ab.B!.replied, ab.B!.sent)}`,
    ``,
    `## Reply rate by niche`,
    ...[...byVertical.entries()]
      .sort((a, b) => b[1].interested - a[1].interested)
      .map(
        ([v, e]) =>
          `- ${v}: sent ${e.sent}, replied ${pct(e.replied, e.sent)}, interested ${pct(e.interested, e.sent)}`,
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
