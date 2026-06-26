# Record of Processing Activities (ROPA) — Opero

_Drafted 2026-06-25. UK GDPR Art. 30 record. Engineering draft; DPA/solicitor to confirm. Keep current as processors/flows change._

**Controller:** Opero (sole operator). Contact: via opero-studio.com request form.

## Processing activities

### A. Outbound B2B prospecting (LeadFlow cold-email + manual kit)
- **Data subjects:** decision-makers / business contacts at UK clinics & allied-health practices.
- **Categories:** business name, business email (role or derived owner), domain, industry, town; public director name (Companies House); outreach history (drafts/replies). No special-category data.
- **Source:** public web (Maps/site), Companies House register, the business's own site.
- **Lawful basis:** legitimate interest (B2B) — see [LIA](legitimate-interest-assessment.md); PECR corporate-only gate enforced in code.
- **Recipients/processors:** Google Workspace (Gmail sending); Supabase (hub storage); Companies House (lookup); LLM providers for copy generation (Gemini / OpenRouter — **may process outside the UK/EU**); email-verification providers (MyEmailVerifier, etc.).
- **Retention:** see [retention-policy](retention-policy.md) (non-responders: opt-out or 6 months; engaged: 12 months).
- **Safeguards:** sender identification + working opt-out in every message; cross-channel suppression (D1); minimal data.

### B. Inbound site enquiries (glyeb-site)
- **Data subjects:** website visitors who submit the form or chat with the assistant.
- **Categories:** name, email, business, message/enquiry; chat transcript.
- **Lawful basis:** consent (explicit form submission) / legitimate interest to respond.
- **Recipients/processors:** Google (Gemini) — on-site assistant generates replies (**may process outside UK/EU**); Resend (email delivery); Supabase (lead storage); Vercel (hosting); Cloudflare Turnstile (bot protection).
- **Retention:** see [retention-policy](retention-policy.md) (12 months after last contact).
- **Safeguards:** consent notice on form; Turnstile; no trackers/profiling; privacy policy at /privacy.

## International transfers
LLM providers (Google Gemini, OpenRouter) and some tools may process data outside the UK/EU. **Action:** confirm adequacy / Standard Contractual Clauses for these transfers, and disclose them plainly in the site privacy policy (do not claim EU-only processing where it isn't true). Flagged for DPA review.

## Data subject rights
Access / erasure / objection actioned via the site request form or reply, using the erase procedure (opero-ops `scripts/erase-contact`).
