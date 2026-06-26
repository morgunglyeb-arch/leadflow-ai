# Legitimate Interest Assessment (LIA) — B2B cold outreach

_Drafted 2026-06-25. Required to rely on **legitimate interest** (UK GDPR Art. 6(1)(f)) for B2B prospecting. Engineering draft — a solicitor/DPA should review before scaling. The three-part test: Purpose · Necessity · Balancing._

## 1. Purpose test — is there a legitimate interest?
**Yes.** Opero offers booking/recall automation to small UK clinics. We contact decision-makers at relevant businesses to introduce a service that addresses a real operational cost (missed calls, lapsed patients, unbooked treatment plans). Promoting a B2B service to businesses likely to benefit is a recognised legitimate interest. Recital 47 UK GDPR notes direct marketing *may* be a legitimate interest.

## 2. Necessity test — is processing necessary?
**Yes, and minimised.** To introduce the service we need a business contact point. We:
- Target by **business type + locality** (clinics in chosen UK towns), not by individuals' personal characteristics.
- Prefer the **business/role inbox**; where we derive a named owner it's via the **public Companies House register** (active director) solely to reach the right person, not to build a profile.
- Apply a **PECR corporate-only gate** (`src/compliance.ts`) — we email only clearly-incorporated entities (Ltd/LLP, Companies House-confirmed); sole traders/individuals are held for consent.
- There is no less-intrusive way to introduce a B2B service to a business that doesn't yet know us; we don't buy lists or scrape personal social profiles.

## 3. Balancing test — do our interests override the individual's rights?
On balance, **yes, with safeguards** — the impact on the individual is low:
- Recipients are **business contacts in a professional capacity**, contacted about their business.
- Every message **identifies the sender** (Opero + site) and offers a **one-click/one-line opt-out** (`OPT_OUT_TEXT` + `List-Unsubscribe`); honoured automatically and cross-channel (D1 suppression bridge).
- **Low volume, well-targeted**, relevant to the recipient's work — not bulk spam.
- We hold **minimal data**, retain it briefly ([retention-policy](retention-policy.md)), and action erasure on request.
- A business contact would **reasonably expect** occasional relevant B2B approaches and can stop them in one step.

**Residual risk:** a clinic that is legally a sole trader / "individual subscriber" despite a corporate-looking name. Mitigation: conservative corporate-only gate; when unsure, use LinkedIn/IG (not PECR electronic mail) or seek consent. A solicitor should confirm the corporate-subscriber boundary for clinics.

## Conclusion
Legitimate interest is an appropriate lawful basis for the cold-email channel, **provided** the corporate-only gate, sender identification, working opt-out, minimal retention, and erasure path remain in force. Review before scaling volume.
