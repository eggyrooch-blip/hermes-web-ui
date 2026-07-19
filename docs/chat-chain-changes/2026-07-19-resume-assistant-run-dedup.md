---
date: 2026-07-19
pr: pending
commit: pending
feature: Resume assistant run deduplication
impact: Hydration and reconnect reconcile a live temporary assistant row with its persisted row instead of displaying the same run twice.
---

Assistant rows that do not match by message ID are paired one-to-one by stable
`run_id`, from the end of the run. This replaces the final live answer with the
canonical persisted row while preserving earlier reasoning/tool-boundary
assistant fragments from the same run.
