// Seed inbox-placement test: send ONE representative cold email from a warmed
// sending inbox to a personal gmail.com we hold a token for, then read where it
// landed (INBOX vs SPAM vs Promotions) via the Gmail API. A real placement
// signal for the Gmail provider. Does NOT touch SENDING_ENABLED or warmup state.
import { google } from "googleapis";
import { loadConfig } from "../src/config";
import { inboxByEmail, sendEmail, getGmailClient } from "../src/campaign/gmail";
import { assembleDraft } from "../src/outreach";
import type { OutputRow } from "../src/types";

const SENDER = process.env.SEED_FROM ?? "emma@opero-team.com";
const RECIP = process.env.SEED_TO ?? "glyeb.automations@gmail.com";
const RECIP_TOKEN = process.env.SEED_TO_TOKEN ?? "secrets/gmail_token_glyeb_automations_gmail_com.json";

const sample = {
  company: "Brighton City Electrical",
  domain: "brightoncityelectrical.co.uk",
  subject: "missed enquiries?",
  opener: "If new enquiries about your domestic and commercial work aren't answered instantly, they often call another electrician and you lose the job.",
  icebreaker: "Your site showcases a lot of impressive electrical projects across Sussex.",
  email: RECIP,
} as unknown as OutputRow;

(async () => {
  const cfg = loadConfig();
  const sender = inboxByEmail(cfg, SENDER);
  if (!sender) throw new Error(`sender ${SENDER} not in GMAIL_ACCOUNTS`);
  const recipInbox = { email: RECIP, tokenPath: RECIP_TOKEN };

  const draft = assembleDraft(sample, cfg);
  const marker = `seedtest-${process.pid}-${Math.floor(process.hrtime()[1] / 1000)}`;
  const subject = `${draft.subject} [${marker}]`;

  console.log(`sending ${SENDER} → ${RECIP} … marker=${marker}`);
  const res = await sendEmail(cfg, { to: RECIP, subject, body: draft.body }, sender);
  console.log("sent id:", res.id);

  // poll the recipient mailbox for the message and read its labels
  const auth = await getGmailClient(cfg, recipInbox);
  const gmail = google.gmail({ version: "v1", auth });
  let labels: string[] | undefined;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const list = await gmail.users.messages.list({ userId: "me", q: `subject:${marker} newer_than:1h`, includeSpamTrash: true });
    const msg = list.data.messages?.[0];
    if (msg?.id) {
      const full = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "metadata" });
      labels = full.data.labelIds ?? [];
      break;
    }
    console.log(`  …not delivered yet (${(i + 1) * 5}s)`);
  }

  if (!labels) { console.log("RESULT: NOT FOUND after 60s (delivery delay or blocked)"); return; }
  const has = (l: string) => labels!.includes(l);
  let verdict = "INBOX (primary)";
  if (has("SPAM")) verdict = "🔴 SPAM";
  else if (has("TRASH")) verdict = "🔴 TRASH";
  else if (has("CATEGORY_PROMOTIONS")) verdict = "🟡 Promotions tab";
  else if (has("CATEGORY_UPDATES")) verdict = "🟡 Updates tab";
  else if (has("CATEGORY_SOCIAL")) verdict = "🟡 Social tab";
  else if (has("INBOX")) verdict = "🟢 INBOX (Primary)";
  console.log("labels:", JSON.stringify(labels));
  console.log("VERDICT:", verdict);
})();
