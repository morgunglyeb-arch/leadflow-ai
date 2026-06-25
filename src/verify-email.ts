import { resolveMx } from "node:dns/promises";
import type { AppConfig } from "./config.js";

export interface VerifyResult {
  ok: boolean;
  reason: string;
}

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const mxCache = new Map<string, boolean>();

/** Free check: does the email's domain have a mail server (MX record)? */
export async function domainHasMx(domain: string): Promise<boolean> {
  const d = domain.toLowerCase();
  if (mxCache.has(d)) return mxCache.get(d)!;
  let ok = false;
  try {
    const mx = await resolveMx(d);
    ok = Array.isArray(mx) && mx.length > 0;
  } catch {
    ok = false;
  }
  mxCache.set(d, ok);
  return ok;
}

interface ZeroBounceResponse {
  status?: string; // "valid" | "invalid" | "catch-all" | "unknown" | ...
  error?: string; // present (HTTP 200) when the key is invalid / out of credits
}

/** All ZeroBounce keys (ZEROBOUNCE_API_KEYS + legacy ZEROBOUNCE_API_KEY), tolerantly
 * parsed: ZeroBounce keys are 32-hex, so we regex-extract them regardless of
 * separator (commas/spaces/newlines) and dedupe — this also recovers two keys the
 * owner pasted with no separator between them (a 64-hex run → two 32-hex keys). */
export function zeroBounceKeys(cfg: AppConfig): string[] {
  const raw = `${cfg.ZEROBOUNCE_API_KEYS ?? ""} ${cfg.ZEROBOUNCE_API_KEY ?? ""}`;
  const found = raw.match(/[a-f0-9]{32}/gi) ?? [];
  return [...new Set(found.map((k) => k.toLowerCase()))];
}

async function zeroBounceCheck(cfg: AppConfig, email: string): Promise<VerifyResult | null> {
  const keys = zeroBounceKeys(cfg);
  if (keys.length === 0) return null;
  const bad = ["invalid", "spamtrap", "abuse", "do_not_mail"];
  for (let i = 0; i < keys.length; i++) {
    try {
      const url = `https://api.zerobounce.net/v2/validate?api_key=${keys[i]}&email=${encodeURIComponent(email)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        const rotatable = [429, 402, 401, 403].includes(res.status);
        if (rotatable && i < keys.length - 1) continue;
        return null;
      }
      const json = (await res.json()) as ZeroBounceResponse;
      // Out-of-credits / invalid key comes back HTTP 200 with `error` and no status
      // → rotate to the next key instead of treating it as a pass.
      if (json.error || !json.status) {
        if (i < keys.length - 1) {
          console.warn(`[zerobounce] key ${i + 1}/${keys.length} unusable (${json.error ?? "no status"}) — rotating`);
          continue;
        }
        return null;
      }
      return { ok: !bad.includes(json.status), reason: `zerobounce:${json.status}` };
    } catch {
      if (i < keys.length - 1) continue;
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hunter.io — email verification (SMTP-level, much better than MX-only)
// https://hunter.io/api-documentation#email-verifier
// ---------------------------------------------------------------------------

interface HunterVerifyData {
  result?: string; // "deliverable" | "undeliverable" | "risky" | "unknown"
  score?: number;  // 0–100
}
interface HunterVerifyResponse {
  data?: HunterVerifyData;
  errors?: Array<{ details?: string }>;
}

/**
 * All Hunter keys (HUNTER_API_KEYS + legacy HUNTER_API_KEY), tolerantly parsed:
 * Hunter keys are 40-hex, so we regex-extract them regardless of separator
 * (commas/spaces/newlines) and dedupe. Lets the owner paste several keys.
 */
export function hunterKeys(cfg: AppConfig): string[] {
  const raw = `${cfg.HUNTER_API_KEYS ?? ""} ${cfg.HUNTER_API_KEY ?? ""}`;
  const found = raw.match(/[a-f0-9]{40}/gi) ?? [];
  return [...new Set(found.map((k) => k.toLowerCase()))];
}

/**
 * Fetch a Hunter endpoint, rotating to the NEXT key on a rate-limit/quota/auth
 * error (429/402/401/403) so one key's free 25/mo cap never dead-ends the lookup
 * — the same "never stop on a limit" resilience as the LLM key pool.
 */
async function hunterFetch(
  cfg: AppConfig,
  buildUrl: (key: string) => string,
  label: string,
): Promise<Response | null> {
  const keys = hunterKeys(cfg);
  if (keys.length === 0) return null;
  for (let i = 0; i < keys.length; i++) {
    try {
      const res = await fetch(buildUrl(keys[i] as string));
      if (res.ok) return res;
      const rotatable = res.status === 429 || res.status === 402 || res.status === 401 || res.status === 403;
      if (rotatable && i < keys.length - 1) {
        console.warn(`[hunter] HTTP ${res.status} on ${label} (key ${i + 1}/${keys.length}) — rotating`);
        continue;
      }
      console.warn(`[hunter] HTTP ${res.status} on ${label}`);
      return null;
    } catch (err) {
      console.warn(`[hunter] error on ${label} (key ${i + 1}/${keys.length}): ${(err as Error).message}`);
      if (i === keys.length - 1) return null;
    }
  }
  return null;
}

async function hunterVerify(cfg: AppConfig, email: string): Promise<VerifyResult | null> {
  const res = await hunterFetch(
    cfg,
    (key) =>
      `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${key}`,
    `verify ${email}`,
  );
  if (!res) return null;
  try {
    const json = (await res.json()) as HunterVerifyResponse;
    const result = json.data?.result ?? "unknown";
    const score = json.data?.score ?? 0;
    if (result === "undeliverable") return { ok: false, reason: `hunter:${result}(${score})` };
    // "deliverable" / "risky" / "unknown" — pass (conservative: don't drop risky)
    return { ok: true, reason: `hunter:${result}(${score})` };
  } catch (err) {
    console.warn(`[hunter-verify] error for ${email}: ${(err as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hunter.io — domain search (find emails we missed by scraping)
// https://hunter.io/api-documentation#domain-search
// ---------------------------------------------------------------------------

interface HunterDomainEmail {
  value: string;
  type?: string;       // "personal" | "generic"
  confidence?: number; // 0–100
}
interface HunterDomainData {
  emails?: HunterDomainEmail[];
  pattern?: string;
}
interface HunterDomainResponse {
  data?: HunterDomainData;
  errors?: Array<{ details?: string }>;
}

/**
 * Ask Hunter.io for known email addresses on a domain. Returns up to 5 emails,
 * PERSONAL (named people) first then by confidence — we want the decision-maker,
 * not a desk inbox.
 */
export async function hunterDomainSearch(
  cfg: AppConfig,
  domain: string,
): Promise<string[]> {
  const res = await hunterFetch(
    cfg,
    (key) =>
      `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=5&api_key=${key}`,
    `domain ${domain}`,
  );
  if (!res) return [];
  try {
    const json = (await res.json()) as HunterDomainResponse;
    const emails = json.data?.emails ?? [];
    // Sort: PERSONAL first (named people = the decision-maker), then by confidence.
    // Reversed from the old "generic-first for SMB" rule: role/desk inboxes (info@)
    // are read by staff as ads → ignored / report-spam → wreck sender reputation.
    return emails
      .sort((a, b) => {
        const aPersonal = a.type === "personal";
        const bPersonal = b.type === "personal";
        if (aPersonal && !bPersonal) return -1;
        if (!aPersonal && bPersonal) return 1;
        return (b.confidence ?? 0) - (a.confidence ?? 0);
      })
      .map((e) => e.value.toLowerCase())
      .slice(0, 5);
  } catch (err) {
    console.warn(`[hunter-domain] error for ${domain}: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Verify an email before we trust it for sending.
 * Chain: syntax → Hunter.io verify (SMTP-level) → ZeroBounce → MX fallback.
 * Conservative: only fails on clear signals, so we don't drop good leads.
 */
export async function verifyEmail(cfg: AppConfig, email: string): Promise<VerifyResult> {
  if (!EMAIL_RE.test(email)) return { ok: false, reason: "bad-syntax" };

  // Hunter.io verify — SMTP-level check, much better than MX-only
  const hunter = await hunterVerify(cfg, email);
  if (hunter) return hunter;

  // ZeroBounce — paid fallback
  const zb = await zeroBounceCheck(cfg, email);
  if (zb) return zb;

  // Free MX-record fallback (only confirms domain exists, not the mailbox)
  const domain = email.split("@")[1] ?? "";
  const mx = await domainHasMx(domain);
  return { ok: mx, reason: mx ? "mx-ok" : "no-mx" };
}
