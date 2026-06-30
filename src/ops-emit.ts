/**
 * Thin, best-effort emitter to the Opero Ops control plane. Every call is a
 * no-op unless OPERO_OPS_URL + INGEST_BEARER_TOKEN are set, has a short timeout,
 * and never throws — pipeline behaviour must be completely unaffected by it.
 */

async function postTo(path: string, body: Record<string, unknown>): Promise<unknown> {
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
    return await res.json().catch(() => null);
  } catch (err) {
    console.warn(`[ops-emit] failed: ${(err as Error).message}`);
    return null;
  }
}

async function post(body: Record<string, unknown>): Promise<unknown> {
  return postTo("/api/ingest/leadflow", body);
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
 * D1: write a cold-machine opt-out/bounce/unsubscribe THROUGH to the hub so
 * `contacts.suppressed` becomes the single cross-channel source of truth (the
 * site/manual channels read the same flag). Best-effort; never throws.
 */
export async function emitSuppress(email: string, reason: string): Promise<void> {
  await post({ type: "suppress", payload: { email: email.toLowerCase(), reason } });
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
): Promise<void> {
  await post({ type, payload });
}

export interface InboxHealthRow {
  domain: string;
  inbox: string;
  warmup_day?: number;
  sent?: number; // lifetime sends from this inbox (rate denominator)
  bounces?: number;
  replies?: number;
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
    await postTo("/api/ingest/inbox-health", { type: "inbox-health", ...row });
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
}

/**
 * A prospect replied. Push the message + a human draft to the owner's phone
 * (Telegram, via the hub). The hub never auto-sends — the operator decides.
 */
export async function emitReply(fields: ReplyFields): Promise<void> {
  await post({ type: "reply", ...fields });
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
  await postTo("/api/ingest/draft", { ...d });
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
  await postTo("/api/ingest/draft-sent", { ...d });
}
