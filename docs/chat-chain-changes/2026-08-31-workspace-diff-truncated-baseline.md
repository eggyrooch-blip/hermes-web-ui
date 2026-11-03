---
date: 2026-08-31
pr: "!51"
commit: 07b51df93bb11fb55565fae59971cfd38a01be3b
feature: Workspace diff truncated baseline ownership
impact: Workspace checkpoints capture path metadata before bounded content reads, enumerate full Git untracked paths, and fail closed when the start scan itself truncates, so unchanged historical files cannot be relabeled as run-created while proven run changes remain visible.
---

Released in `release-20260831-02`. Pipeline 542885 and the release executor's 12/12 probes passed. In the trusted `sunke` Chrome session, a no-tool/no-file canary returned “收到”; its assistant message container had zero download items, and a read-only database check confirmed no new workspace change row. Historical chips on the old message were intentionally preserved.
