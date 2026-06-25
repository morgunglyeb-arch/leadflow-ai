// Cheap liveness probe for the free Gemini (OpenAI-compatible) provider: one
// 1-token completion on the first key. Exit 0 = READY (quota available), 1 =
// EXHAUSTED/error (e.g. daily 429), 2 = no keys configured. Used to gate a batch
// run on quota reset without burning Maps/discovery quota. Prints NO secrets.
//   npx tsx scripts/llm-probe.ts
import OpenAI from "openai";
import { loadConfig } from "../src/config.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const raw = `${cfg.OPENAI_API_KEYS ?? ""} ${cfg.OPENAI_API_KEY ?? ""}`;
  const keys = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (keys.length === 0) {
    console.log("PROBE: NO_KEYS");
    process.exit(2);
  }
  const client = new OpenAI({ apiKey: keys[0], baseURL: cfg.OPENAI_BASE_URL });
  try {
    await client.chat.completions.create({
      model: cfg.OPENAI_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "ok" }],
    });
    console.log(`PROBE: READY model=${cfg.OPENAI_MODEL} keys=${keys.length}`);
    process.exit(0);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    const status = err.status ?? "?";
    const quota = /quota|rate|exhaust|exceed/i.test(err.message ?? "");
    console.log(`PROBE: EXHAUSTED status=${status}${quota ? " (quota)" : ""}`);
    process.exit(1);
  }
}

void main();
