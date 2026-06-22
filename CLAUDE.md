# LeadFlow AI — Claude Code bootstrap

This file is loaded automatically by Claude Code sessions opened inside
`/Users/a1/LeadFlow-AI/`. It connects this project to the shared memory
that's also seen by the Glyeb sales-site session.

## At session start — read these (in order)

1. `~/.claude/memory/profile.md` — who the user is, hard product rules.
2. `~/.claude/memory/shared-state.md` — cross-project journal (LeadFlow ↔
   sales site). Both projects' sessions read AND write this file.
3. `~/.claude/memory/leadflow.md` — short LeadFlow summary.
4. `./SESSION_STATE.md` — the full LeadFlow project state.

Don't narrate that you've read them — just have the context available.

## When you finish meaningful work — write back

Append one line to the Timeline section of
`~/.claude/memory/shared-state.md`:

    ### YYYY-MM-DD — [leadflow] one-line summary
    Optional second line with the concrete artifact (commit hash, file, decision).

Don't rewrite past entries. If a fact is superseded, add a new entry
prefixed `[update]`.

## Skills — ALWAYS auto-apply by zone, never ask permission (owner standing order, 2026-06-21)

When working on LeadFlow, automatically apply these `.claude/skills/` playbooks in
their zone WITHOUT asking — they are the house rules, not optional:

- **deliverability-audit** — run FIRST as a GATE before ANY volume increase
  (SPF/DKIM/DMARC/MX/DNSBL/Postmaster, bounce+spam thresholds). Don't raise warmup
  until every active sending domain PASSes.
- **warmup-planner** — recompute per-inbox ramp for the real 9 inboxes / 3 domains,
  +2/day, 3–4 wks, keyed to each inbox's stage.
- **spam-doctor** (+ run `src/spamlint.ts`) — lint every draft for spam patterns.
- **subject-lab** — generate + rank A/B subjects (specific-hook style, not clichéd).
- **outreach-personalizer** (+ **humanizer**) — first line = a real icebreaker from
  the clinic's site/IG, not a bare `{Clinic}` merge-tag; strip AI-tells.
- **outreach-localizer** — verify UK English (formality, local realities).
- **objection-handler** + **reply-responder** — strengthen `suggestReply`: human,
  no-call answers to common objections; ALWAYS draft-only, never auto-send.
- **compliance-guard** — PECR/GDPR: Ltd clinics legal (identify + opt-out), sole
  traders need consent; filter the list by entity type.
- **inbox-rotation** — even rotation across the 9 inboxes + text variation between
  them (no identical pattern across inboxes).
- **icp-expander** — only verify `config/icp.json` matches the niche (clinics+
  aesthetics, UK); do NOT widen the funnel (expansion FROZEN).
- **experiment-runner** — frame changes as measurable A/B, not one-off edits.
- **campaign-analyst** + **cost-tracker** — funnel metrics vs benchmarks + unit econ.
- **content-recycler** / **crm-sync** — as needed (loop into contacts/inbox_health).

⚠️ These guide a CLAUDE SESSION — the autonomous TS pipeline can't invoke skills at
runtime, so the must-run-unattended rules live in CODE. Already enforced in the
pipeline: warmup cap (`warmupCap`), suppression (bounce→suppress), inbox rotation,
`EMAIL_VERIFY`, A/B subjects (`subjectB`), spamlint. Still to wire into code:
a deliverability PRE-SEND gate + a compliance entity-type filter.

## Don't touch from this session

- The sales-site project (separate folder, separate Claude Code session
  works on it). If you find yourself needing to change it, write the
  request into `shared-state.md`'s "Open coordination tasks" instead.
- `.env`, `secrets/`, `config/icp.json` — gitignored, never commit.
- `SENDING_ENABLED=true` — never flip without explicit user approval in
  the same conversation.
