---
date: 2026-07-09
pr: pending
feature: Message list hydration hotfix
impact: Restores authoritative paginated history after empty socket resume without erasing newer local or reconnect messages.
---

# 2026-07-09 — message list hydration hotfix

## Summary

Local main could render an empty chat transcript after switching sessions even when the paginated HTTP endpoint returned messages. The upstream chat store treated Socket.IO resume as the authoritative initial load, so empty, stale-zero, or timed-out resume paths could leave the active session blank.

## Change

- Empty and timed-out resume paths now probe the bounded paginated endpoint without trusting stale message totals.
- Hydration uses per-session request epochs and preserves messages created or replaced after the request began, so a delayed page cannot erase a prompt or streaming assistant state.
- Empty reconnect payloads no longer clear an already rendered transcript; foreground refresh follows the same fallback policy.
- Store-owned visibility listeners and refresh intervals are removed when Pinia disposes the store, and paginated requests have a 15-second abort bound with observable failure logging.
- Persisted messages now carry `run_id` through the local schema, bridge flush paths, resume mapping, and paginated API so inline workspace diff badges can match server-backed history.

## Verification

- Failing-first client regressions cover stale/zero totals, resume timeout, delayed hydration, reconnect-empty preservation, and store disposal.
- Focused client verification: 6 files / 81 passed.
- Focused server verification: 6 files / 90 passed.
- Full suite: 313 files / 2372 passed / 2 skipped / 0 failed.
- `npm run harness:check` and `npm run build` passed.
- A fresh Playwright browser against the worktree production build and a real local DB snapshot observed a paginated `200`, 7 rendered message nodes, and 0 empty-state nodes after Socket.IO resume timeout.

## Release Status

The hotfix is not merged into local main, not running on `:8648`, and not published to production. Browser evidence is from the isolated worktree server on `127.0.0.1:8750`.
