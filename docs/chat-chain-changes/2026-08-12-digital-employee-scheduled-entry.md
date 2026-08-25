---
date: 2026-08-12
feature: Digital employee scheduled entry and lookup-error admission
impact: Adds a trusted scheduled-job entry and fails closed on session lookup errors before chat writes.
commit: f9bd47fd
---

# Digital employee scheduled entry — local candidate

- Task/checkpoint: `digital-employee-scheduled-entry@f9bd47fd`
- User behavior: a persisted, current-catalog digital employee session exposes `Schedule`; it opens the existing automation form with session title, current prompt, expert skills and Feishu delivery prefilled. Plain, coding, global and stale-catalog sessions expose no entry.
- Trust boundary: the browser supplies only a source session, expected expert and opaque idempotency key. The BFF re-reads the session and trusted request principal/profile before calling the configured Jobs broker, strips forged identity/source/delivery fields, and fails closed before write or dispatch.
- Inherited guard fixed: a session DB lookup error at the shared chat admission fence now emits requester-scoped `run.rejected` without creating working state, transcript data or a broker request.
- Evidence: focused Vitest 20/20; broker lifecycle 53/53; full Vitest 333 files / 2826 passed / 2 skipped; Playwright 2/2; typecheck, harness and production build passed; SIM 8/8 and check passed. Screenshots live under `.ftask/digital-employee-scheduled-entry/sim_artifacts/`.
- Production: unchanged. No ship, push, merge, deploy, production probe, employee message, Feishu write or model call was performed.
