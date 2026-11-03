---
date: 2026-09-01
commit: pending-local
feature: Harness general workspace engine
impact: Authorized expert sessions keep the current Hermes workspace and show its real label while Harness availability no longer depends on a profile allowlist.
---

# Harness general workspace engine

- Task: `harness-workspace-general-engine` (local candidate; no PR/commit or production deployment yet).
- Touched: expert Harness availability, expert-session creation, session engine/workspace admission, and chat header badge.
- Impact: every authenticated profile may select Harness on an authorized expert when runtime readiness is healthy; the new expert session carries the current Hermes workspace, rejects later workspace changes through both the sessions API and run dispatch, fails closed when a named folder disappears, and shows the selected folder or localized default workspace instead of `hermes-web-ui`.
- Unchanged: expert audience authorization, profile ownership, Hermes per-run workspace behavior, and browser exposure of host paths or credentials.
