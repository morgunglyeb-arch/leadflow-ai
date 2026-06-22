import { resolveTxt } from "node:dns/promises";

/**
 * Pre-send deliverability gate (the `deliverability-audit` skill, enforced in
 * code so it runs unattended). Verifies each sending domain has valid
 * SPF + DKIM (Google selector) + DMARC before any mail goes out — warmup is
 * pointless if auth is broken, and sending from an unauthenticated domain burns
 * reputation fast. Inboxes on a FAILing domain are skipped by the campaign.
 */

export interface DomainAuth {
  domain: string;
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  pass: boolean;
}

async function txt(name: string): Promise<string[]> {
  try {
    const recs = await resolveTxt(name);
    return recs.map((chunks) => chunks.join(""));
  } catch {
    return [];
  }
}

/** SPF + DKIM (Google Workspace `google` selector) + DMARC presence for one domain. */
export async function auditDomain(domain: string): Promise<DomainAuth> {
  const [root, dkim, dmarc] = await Promise.all([
    txt(domain),
    txt(`google._domainkey.${domain}`),
    txt(`_dmarc.${domain}`),
  ]);
  const hasSpf = root.some((r) => /v=spf1/i.test(r));
  const hasDkim = dkim.some((r) => /v=DKIM1|(^|;)\s*p=/i.test(r));
  const hasDmarc = dmarc.some((r) => /v=DMARC1/i.test(r));
  return { domain, spf: hasSpf, dkim: hasDkim, dmarc: hasDmarc, pass: hasSpf && hasDkim && hasDmarc };
}

const domainOf = (email: string): string => email.split("@")[1]?.toLowerCase() ?? "";

/** Audit every distinct sending domain; return the set that PASSes + the report. */
export async function passingSendingDomains(
  emails: string[],
): Promise<{ passing: Set<string>; report: DomainAuth[] }> {
  const domains = [...new Set(emails.map(domainOf).filter(Boolean))];
  const report = await Promise.all(domains.map(auditDomain));
  const passing = new Set(report.filter((r) => r.pass).map((r) => r.domain));
  return { passing, report };
}

export { domainOf };
