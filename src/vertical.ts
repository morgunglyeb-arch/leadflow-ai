import { readFile } from "node:fs/promises";
import { z } from "zod";

const VerticalSchema = z.object({
  match: z.array(z.string()).optional(),
  name: z.string(),
  money_channel: z.string(),
  booking_culture: z.string(),
  automations: z.array(z.string()),
  avg_ticket: z.string(),
});
export type Vertical = z.infer<typeof VerticalSchema>;

const ConfigSchema = z.object({
  verticals: z.array(VerticalSchema),
  default: VerticalSchema,
});

let cache: z.infer<typeof ConfigSchema> | null = null;

async function load(path = "config/verticals.json"): Promise<z.infer<typeof ConfigSchema>> {
  if (cache) return cache;
  try {
    const raw = await readFile(path, "utf8");
    cache = ConfigSchema.parse(JSON.parse(raw));
  } catch {
    // Minimal built-in default if the file is missing/invalid.
    cache = {
      verticals: [],
      default: {
        name: "local service business",
        money_channel: "phone calls and the website (contact form / online booking)",
        booking_culture:
          "customers mostly call or use the website — a social link in the footer is usually marketing, not a booking channel",
        automations: ["missed-call text-back", "instant reply to web enquiries", "booking reminders"],
        avg_ticket: "varies — frame the cost of a lost customer qualitatively",
      },
    };
  }
  return cache;
}

/** Pick the best-matching vertical from the niche query + company + site text. */
export async function matchVertical(haystack: string): Promise<Vertical> {
  const cfg = await load();
  const hay = haystack.toLowerCase();
  for (const v of cfg.verticals) {
    if ((v.match ?? []).some((m) => hay.includes(m.toLowerCase()))) return v;
  }
  return cfg.default;
}

export function verticalFacts(v: Vertical): string {
  return [
    `INDUSTRY FACTS — this is a ${v.name}; ground the diagnosis in how this type of business REALLY works:`,
    `- How customers actually contact/book: ${v.money_channel}`,
    `- Booking culture: ${v.booking_culture}`,
    `- Automations that genuinely sell here: ${v.automations.join("; ")}`,
    `- Typical ticket size (for framing the money at stake — do NOT state fake precise numbers): ${v.avg_ticket}`,
  ].join("\n");
}
