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
}

/**
 * A prospect replied. Push the message + a human draft to the owner's phone
 * (Telegram, via the hub). The hub never auto-sends — the operator decides.
 */
export async function emitReply(fields: ReplyFields): Promise<void> {
  await post({ type: "reply", ...fields });
}
