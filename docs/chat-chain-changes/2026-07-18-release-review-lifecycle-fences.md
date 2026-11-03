---
date: 2026-07-18
pr: pending
commit: pending
feature: Release review lifecycle fences
impact: Request-scoped setup failures no longer terminate sibling runs, deletion closes its local generation before remote cleanup, and bridge failures retain ownership through workspace diff completion.
---

Regression coverage exercises an active broker sibling, real SQLite single and
batch deletion while remote cleanup is delayed, and queue admission during a
delayed bridge workspace diff.
