---
name: icp-expander
description: Use to expand an ICP description into verticals, synonyms, and geo search queries for discovery — and to keep the vertical library in sync between repos. Trigger on "new vertical", "expand ICP", "more discovery queries", "add an industry", or editing config/icp.json / config/verticals.json.
---

# ICP expander

## Workflow
1. From a plain ICP description, generate: candidate verticals, match-synonyms (how owners describe themselves), and geo-scoped search queries for the active `DISCOVERY_SOURCE` (maps/search).
2. Write into `config/icp.json` (niches/segments) and, for any new vertical, add a full entry to `config/verticals.json` (money_channel, booking_culture, automations[], avg_ticket, service_price — match the existing shape; numbers conservative).
3. **MANDATORY sync (CLAUDE.md):** any change to `config/verticals.json` must mirror into the site `glyeb-site/config/industries.ts`. The site test `__tests__/vertical-sync.test.ts` asserts equal counts (18↔18) — keep it green.
4. Keep channel realism: not every vertical books via social DM (only aesthetics-type do); phone/web for clinics, etc.

## Constraints
- LeadFlow discovery is London-scoped; the SITE is worldwide — don't narrow site industries to London.
- Don't invent prices — ground in avg_ticket.

Key files: `config/icp.json`, `config/verticals.json`, `glyeb-site/config/industries.ts`, `src/vertical.ts`.
