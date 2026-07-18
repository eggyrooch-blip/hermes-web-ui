---
date: 2026-07-18
pr: pending
commit: pending
feature: Final release review concurrency fences
impact: Diff overload is explicit and bounded, resume listeners and acknowledgements are reclaimed, and connector replay cleanup preserves exact ownership.
---

# Final release review concurrency fences

- PR/commit: `webui-release-blockers` candidate (final commit pending)
- Touched feature: workspace diff checkpoints, resume-event acknowledgement, connector replay recovery, and Socket.IO session resume.
- Behavior impact:
  - Workspace diff lease acquisition now has its own one-second budget; actual snapshot/diff work receives a fresh one-second deadline after acquisition. Late filesystem or Git work keeps its global lease until settlement, and test teardown waits for that settlement deterministically.
  - If both diff leases remain occupied past the acquisition budget, the live run emits an explicit `unavailable`/`truncated` workspace-diff result with `degraded_reason=lease_acquisition_timeout` and the server writes a structured warning. No synthetic workspace change is persisted to SQLite.
  - Resume listeners self-remove after 15 seconds when the server does not answer. Legacy connector cards that predate generation metadata can be cleared only by the same run ID, while present generation fields remain exact fences. A replay setup that cannot obtain the current socket rolls back its temporary handler and working state so the card remains retryable.
  - Pending terminal and credential-resume acknowledgements no longer forget an earlier live socket after 100 later acknowledgements; acknowledgements are removed when that socket disconnects. Same-content events with different stable IDs remain distinct.
  - Existing `/plan` and `/goal` stream ownership was verified with a regression: a delayed authoritative-idle resume cannot retire the newer command owner.

Production is unchanged by this fragment. Deployment still requires the release backup, local-main verification, and production canary described in the release runbook.
