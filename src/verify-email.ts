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

/**
 * Verify an email before we trust it for sending. Syntax → ZeroBounce (if key)
 * → free MX-record fallback. Conservative: only fails on clear signals, so we
 * don't drop good leads.
 */
export async function verifyEmail(cfg: AppConfig, email: string): Promise<VerifyResult> {
  if (!EMAIL_RE.test(email)) return { ok: false, reason: "bad-syntax" };
  const zb = await zeroBounceCheck(cfg, email);
  if (zb) return zb;
  const domain = email.split("@")[1] ?? "";
  const mx = await domainHasMx(domain);
  return { ok: mx, reason: mx ? "mx-ok" : "no-mx" };
}
