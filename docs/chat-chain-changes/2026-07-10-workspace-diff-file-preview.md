---
date: 2026-07-10
pr: pending
commit: pending
feature: Workspace diff file preview
impact: Workspace diff events no longer add synthetic chat rows; run-matched file chips open the existing right-side preview panel in diff mode while the persisted diff API remains unchanged.
---

The client keeps workspace run-change summaries outside the message list, restores them by session, and uses each assistant message's `run_id` to attach changed-file chips. Legacy persisted `workspace.diff` command rows are hidden, and per-file patches are fetched only when their FilePreview diff pane opens.
