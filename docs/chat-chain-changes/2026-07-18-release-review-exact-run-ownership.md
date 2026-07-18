---
date: 2026-07-18
pr: pending
commit: 98eaa876
feature: Exact chat run ownership
impact: Late API, bridge, command, abort, and resume work can no longer mutate a replaced session run.
---

Chat runs now retain the exact in-memory state, SQLite generation, and run
marker across asynchronous work. Late stream frames, completion work, command
lookups, abort cleanup, and bridge reattach results are discarded when that
ownership changes. Queued `/plan` and `/goal` failures release their reservation
and continue the same FIFO instead of leaving the session stuck.

Regression coverage includes same-ID session recreation, a newer run reusing
the same state object, route changes during bridge status lookup, persistence
failures, and queued command exceptions.

Local verification passed 322 test files / 2646 tests with 2 skipped, client
and server build, `harness:check`, and `git diff --check`. Final-hash SIM and a
fresh independent review remain pending. This candidate has not been merged,
pushed, or deployed to production.
