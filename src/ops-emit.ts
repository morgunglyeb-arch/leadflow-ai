/**
 * Thin, best-effort emitter to the Opero Ops control plane. Every call is a
 * no-op unless OPERO_OPS_URL + INGEST_BEARER_TOKEN are set, has a short timeout,
 * and never throws — pipeline behaviour must be completely unaffected by it.
 */

import { appendFile, readFile, writeFile } from "node:fs/promises";

// Durable fallback for OUTCOME telemetry (replies, bounces, suppressions, drafts,
// health): if the hub is unreachable (Mac offline / deploy / 5xx) the payload is
// stashed here instead of being silently lost, then replayed by
// replayFailedTelemetry() at the start of the next run. Transient signals
// (run.start/end, state_backup) are NOT stashed — they'd duplicate or are
// latest-wins, and the hub-side watchdog already reaps zombie runs.
const FAILED_LOG = "data/telemetry-failed.jsonl";

async function stashFailed(path: string, body: Record<string, unknown>): Promise<void> {
  try {
    await appendFile(FAILED_LOG, `${JSON.stringify({ t: new Date().toISOString(), path, body })}\n`);
  } catch {
    /* the stash itself is best-effort — never throw from telemetry */
  }
}

async function postTo(
  path: string,
  body: Record<string, unknown>,
  opts: { durable?: boolean } = {},
): Promise<unknown> {
  const base = process.env.OPERO_OPS_URL;
  const token = process.env.INGEST_BEARER_TOKEN;
  if (!base || !token) return null;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      console.warn(`[ops-emit] ${path} → HTTP ${res.status}`);
      if (opts.durable) await stashFailed(path, body);
      return null;
    }
    return await res.json().catch(() => null);
  } catch (err) {
    console.warn(`[ops-emit] failed: ${(err as Error).message}`);
    if (opts.durable) await stashFailed(path, body);
    return null;
  }
}

async function post(
  body: Record<string, unknown>,
  opts: { durable?: boolean } = {},
): Promise<unknown> {
  return postTo("/api/ingest/leadflow", body, opts);
}

/**
 * Replay outcome telemetry that previously failed to reach the hub (stashed by
 * stashFailed). Called at the start of each run so a backlog drains once
 * connectivity returns — closes the "silent loss while offline" gap the brain audit
 * flagged. Idempotent on the hub (dedup_key); entries older than 7d are dropped to
 * bound the file. Best-effort; never throws.
 */
export async function replayFailedTelemetry(): Promise<number> {
  const base = process.env.OPERO_OPS_URL;
  const token = process.env.INGEST_BEARER_TOKEN;
  if (!base || !token) return 0;
  let lines: string[];
  try {
    lines = (await readFile(FAILED_LOG, "utf8")).split("\n").filter((l) => l.trim());
  } catch {
    return 0; // no backlog file
  }
  const weekAgo = Date.now() - 7 * 86_400_000;
  const stillFailing: string[] = [];
  let replayed = 0;
  for (const line of lines) {
    let rec: { t?: string; path?: string; body?: Record<string, unknown> };
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // drop unparseable
    }
    if (!rec.path || !rec.body) continue;
    if (rec.t && new Date(rec.t).getTime() < weekAgo) continue; // too old → drop
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}${rec.path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(rec.body),
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) replayed++;
      else stillFailing.push(line);
    } catch {
      stillFailing.push(line); // still unreachable — keep for next time
    }
  }
  try {
    await writeFile(FAILED_LOG, stillFailing.length ? `${stillFailing.join("\n")}\n` : "");
  } catch {
    /* best-effort */
  }
  if (replayed > 0) console.log(`[ops-emit] replayed ${replayed} stashed telemetry event(s)`);
  return replayed;
}

/**
 * RESTORE the off-Mac campaign-state backup from the hub (the read side of
 * emitStateBackup). Returns the raw state object, or null if the hub isn't
 * configured/reachable or has no backup yet. Used only when STATE_REMOTE is on and
 * there's no local state.json — so a fresh/replaced Mac or a cloud runner resumes
 * warmup/sequencing instead of resetting to day 1.
 */
export async function fetchRemoteState(): Promise<unknown | null> {
  const base = process.env.OPERO_OPS_URL;
  const token = process.env.INGEST_BEARER_TOKEN;
  if (!base || !token) return null;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/state/leadflow`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as { ok?: boolean; state?: unknown } | null;
    return json?.ok ? (json.state ?? null) : null;
  } catch (err) {
    console.warn(`[ops-emit] state restore failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Read the ACTIVE experiment send-filter terms from the hub. The hub's experiment
 * tracker advances the wave autonomously (by delivered-count); this lets the sender
 * re-aim cold first-touches at the current wave WITHOUT a manual .env edit. Returns
 * null (→ caller falls back to cfg.EXPERIMENT_VERTICALS) if unset/unreachable/empty.
 */
export async function fetchActiveVerticals(): Promise<string[] | null> {
  const base = process.env.OPERO_OPS_URL;
  const token = process.env.INGEST_BEARER_TOKEN;
  if (!base || !token) return null;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/experiment`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as { verticals?: unknown } | null;
    const v = json?.verticals;
    if (Array.isArray(v) && v.every((x) => typeof x === "string") && v.length > 0) {
      return v as string[];
    }
    return null;
  } catch (err) {
    console.warn(`[ops-emit] fetchActiveVerticals failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Read learned winners from the hub (F1) — per vertical × angle, learned on WON
 * across the persistent `contacts` funnel, min-N gated. The hub is the source of
 * truth (the local winners.json is recomputed from ephemeral state). Best-effort
 * GET; returns null if the hub isn't configured/reachable so callers fall back.
 */
export async function fetchWinners(): Promise<unknown[] | null> {
  const base = process.env.OPERO_OPS_URL;
  const token = process.env.INGEST_BEARER_TOKEN;
  if (!base || !token) return null;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/learn/winners`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    });
    const data = (await res.json().catch(() => null)) as { winners?: unknown[] } | unknown[] | null;
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.winners)) return data.winners;
    return null;
  } catch (err) {
    console.warn(`[ops-emit] fetchWinners failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * D1: read the hub's cross-channel suppression — emails/domains marked
 * `contacts.suppressed` in Supabase (opt-outs from the site, manual outreach, or
 * recorded replies). The hub is the single source of truth across channels; the
 * cold machine merges this into its local never-contact set so an opt-out on ANY
 * channel blocks it. Best-effort GET; null when the hub isn't configured/reachable.
 */
export async function fetchSuppression(): Promise<string[] | null> {
  const base = process.env.OPERO_OPS_URL;
  const token = process.env.INGEST_BEARER_TOKEN;
  if (!base || !token) return null;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/suppression`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    });
    const data = (await res.json().catch(() => null)) as
      | { entries?: string[] }
      | string[]
      | null;
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.entries)) return data.entries;
    return null;
  } catch (err) {
    console.warn(`[ops-emit] fetchSuppression failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Cross-run dedup set for a CLOUD finder. A GitHub-Actions / VPS prospect run has no
 * local `leads_enriched.csv`, so `loadExistingKeys` finds nothing and the run would
 * re-discover, re-enrich and re-bank domains we already have — burning LLM tokens.
 * The hub holds one `contacts` row per already-prospected lead (deduped by domain),
 * so we GET them and merge into the existing-keys set. Best-effort; null if the hub
 * isn't configured/reachable (then we just fall back to the local CSV, if any).
 */
export async function fetchKnownKeys(): Promise<{ emails: string[]; domains: string[] } | null> {
  const base = process.env.OPERO_OPS_URL;
  const token = process.env.INGEST_BEARER_TOKEN;
  if (!base || !token) return null;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/leadflow/known-domains`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as
      | { emails?: string[]; domains?: string[] }
      | null;
    if (!data) return null;
    return { emails: data.emails ?? [], domains: data.domains ?? [] };
  } catch (err) {
    console.warn(`[ops-emit] fetchKnownKeys failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * D1: write a cold-machine opt-out/bounce/unsubscribe THROUGH to the hub so
 * `contacts.suppressed` becomes the single cross-channel source of truth (the
 * site/manual channels read the same flag). Best-effort; never throws.
 */
export async function emitSuppress(email: string, reason: string): Promise<void> {
  await post({ type: "suppress", payload: { email: email.toLowerCase(), reason } }, { durable: true });
}

/**
 * R4: back up the campaign state (warmup_day, per-inbox counters, send history) to
 * the hub once per run, so the Mac dying doesn't reset warmup to day 1 (the local
 * file in data/campaign/ is the only copy otherwise). Best-effort; never throws.
 */
export async function emitStateBackup(state: unknown): Promise<void> {
  await post({ type: "state_backup", payload: { state } });
}

/** Report a fatal pipeline error to the hub (-> bug + push). */
export async function emitError(err: unknown): Promise<void> {
  const e = err as { name?: string; message?: string };
  const name = e?.name ?? "Error";
  const message = e?.message ?? String(err);
  await postTo("/api/ingest/error", {
    source: "leadflow",
    title: `${name}: ${message}`.slice(0, 300),
    level: "error",
    fingerprint: `leadflow:${name}:${message.slice(0, 80)}`,
  });
}

/** Mark a run as started; returns the hub's run id (or null when disabled). */
export async function emitRunStart(kind: "prospect" | "campaign"): Promise<string | null> {
  const r = (await post({ type: "run.start", kind })) as { id?: string } | null;
  return r?.id ?? null;
}

export interface RunEndFields {
  status: "done" | "failed";
  discovered?: number;
  qualified?: number;
  sent?: number;
  warmup_day?: number;
}

export async function emitRunEnd(runId: string | null, fields: RunEndFields): Promise<void> {
  await post({ type: "run.end", run_id: runId, ...fields });
}

/** Append an arbitrary pipeline stage event to the hub feed. */
export async function emitEvent(
  type: string,
  payload: Record<string, unknown> = {},
  dedupKey?: string,
): Promise<void> {
  await post({ type, payload, ...(dedupKey ? { dedup_key: dedupKey } : {}) }, { durable: true });
}

export interface InboxHealthRow {
  domain: string;
  inbox: string;
  warmup_day?: number;
  sent?: number; // lifetime sends from this inbox (rate denominator)
  bounces?: number;
  replies?: number;
  sent_today?: number; // TODAY's NEW first-touches from this inbox
  followups_today?: number; // TODAY's follow-ups from this inbox (share the same daily cap)
  // Warmup-window signal: of `received` peer mails, `rescued` were in spam. When
  // present the hub computes warmup reply_rate + spam_rate off `received` (the
  // cold-send `sent` denominator is 0 until real sending starts).
  received?: number;
  rescued?: number;
}

/**
 * Per-inbox deliverability stats for the Opero Ops `inbox_health` analytics.
 * Posts ONE row per inbox to the dedicated `/api/ingest/inbox-health` route
 * (which computes bounce/reply rates + status and alerts on critical). The
 * payload shape + `type:"inbox-health"` must match that route's contract.
 * Best-effort; a no-op unless the hub env vars are set.
 */
export async function emitInboxHealth(rows: InboxHealthRow[]): Promise<void> {
  for (const row of rows) {
    await postTo("/api/ingest/inbox-health", { type: "inbox-health", ...row }, { durable: true });
  }
}

export interface ReplyFields {
  company: string;
  sentiment: string;
  email?: string;
  snippet?: string;
  suggested?: string;
  replyId?: string; // Gmail message id → dedup key per DISTINCT inbound reply
  // (so a genuine 2nd reply in the same thread isn't swallowed as a duplicate)
  // F5 — angle attribution: which angle earned this outcome, so the hub can learn
  // per vertical × angle (and learn on WON, not just replied). vertical == the
  // funnel key (contacts.industry).
  vertical?: string;
  variant?: string; // A/B subject variant actually sent
  opener?: string; // the hook that was sent
  subject?: string; // the subject that was sent
  reason?: string; // #1 learn-from-no: bucketed rejection reason (already_have/price/timing/not_relevant/opt_out)
}

/**
 * A prospect replied. Push the message + a human draft to the owner's phone
 * (Telegram, via the hub). The hub never auto-sends — the operator decides.
 */
export async function emitReply(fields: ReplyFields): Promise<void> {
  await post({ type: "reply", ...fields }, { durable: true });
}

export interface DraftPayload {
  business?: string;
  website?: string;
  email?: string;
  industry?: string;
  reason?: string; // why this business was chosen (plain language)
  subject?: string;
  message: string;
  message_ru?: string; // faithful Russian translation, for the owner's review
  score?: number;
  dedup_key?: string;
}

/**
 * Push ONE pre-generated outreach message to the hub's "Рассылка" review tab
 * (`/api/ingest/draft`), so the owner can check it on the phone and send it by
 * hand. Idempotent by dedup_key on the hub. Best-effort; no-op without the env.
 */
export async function emitDraft(d: DraftPayload): Promise<void> {
  await postTo("/api/ingest/draft", { ...d }, { durable: true });
}

/**
 * Mark that a cold first-touch was actually SENT (machine send), so the hub can
 * show it in the "Контакты" tab — who we emailed, when, and the email itself.
 * Matches/updates the existing draft by email (or inserts one) + advances the
 * contact to "contacted". Best-effort; no-op without the env.
 */
export async function emitDraftSent(d: {
  email?: string;
  business?: string;
  domain?: string;
  subject?: string;
  message: string;
  sent_at: string;
  sent_via?: string;
}): Promise<void> {
  await postTo("/api/ingest/draft-sent", { ...d }, { durable: true });
}
