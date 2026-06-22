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
}

async function zeroBounceCheck(cfg: AppConfig, email: string): Promise<VerifyResult | null> {
  if (!cfg.ZEROBOUNCE_API_KEY) return null;
  try {
    const url = `https://api.zerobounce.net/v2/validate?api_key=${cfg.ZEROBOUNCE_API_KEY}&email=${encodeURIComponent(email)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as ZeroBounceResponse;
    const status = json.status ?? "unknown";
    // treat invalid/spamtrap/abuse as fail; valid/catch-all/unknown as pass
    const bad = ["invalid", "spamtrap", "abuse", "do_not_mail"];
    return { ok: !bad.includes(status), reason: `zerobounce:${status}` };
  } catch {
    return null;
  }
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

async function hunterVerify(cfg: AppConfig, email: string): Promise<VerifyResult | null> {
  if (!cfg.HUNTER_API_KEY) return null;
  try {
    const url =
      `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}` +
      `&api_key=${cfg.HUNTER_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) {
      // 429 = rate limit, 402 = quota exhausted — fall through to MX
      console.warn(`[hunter-verify] HTTP ${res.status} for ${email} — falling back`);
      return null;
    }
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
 * Ask Hunter.io for known email addresses on a domain. Returns up to 5
 * emails sorted by confidence, with generic (info@, contact@) first since
 * those are the most useful for cold outreach to SMBs.
 */
export async function hunterDomainSearch(
  cfg: AppConfig,
  domain: string,
): Promise<string[]> {
  if (!cfg.HUNTER_API_KEY) return [];
  try {
    const url =
      `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}` +
      `&limit=5&api_key=${cfg.HUNTER_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[hunter-domain] HTTP ${res.status} for ${domain}`);
      return [];
    }
    const json = (await res.json()) as HunterDomainResponse;
    const emails = json.data?.emails ?? [];
    // Sort: generic first (info@, contact@ — best for SMB cold email), then by
    // confidence descending.
    return emails
      .sort((a, b) => {
        if (a.type === "generic" && b.type !== "generic") return -1;
        if (a.type !== "generic" && b.type === "generic") return 1;
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
