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

## Review hardening

- Non-empty initial resume and reconnect snapshots are merged with local state instead of replacing it wholesale; same-ID local streaming content wins while server run/finish metadata is retained.
- Hydration ordering advances only when a request returns usable messages, so a newer failed request cannot invalidate an older successful page for the same session.
- Hydration snapshots compare serialized values rather than object identity, so in-place streaming deltas survive; a raw page that maps to no visible rows is not allowed to blank the transcript or advance the success epoch.
- A completed reconnect treats server rows as authoritative and does not preserve stale local streaming flags; an active reconnect only selects an unfinished assistant from the resume payload's current tail, not an older legacy `finish_reason=null` row.
- Resume candidates use the current persisted client message identity plus server order or an explicit run marker, so stale/future timestamps cannot make an unfinished assistant absorb the next run. User/command `queue_id` is persisted as `messages.client_id` and returned by paginated/resume paths, letting optimistic rows reconcile by stable ID without content/time guesses, duplicate prompts, or collapsed repeated prompts.
- DB-to-socket hydration and broker `syncFromHermes` preserve both `client_id` and `run_id`; coding-agent turns forward the same `queue_id` into in-memory and SQLite user rows. The merge keeps current and server relative order by stable neighboring IDs, preserves partial-page omissions, and never sorts by untrusted message timestamps.
- The Responses stream uses `state.runId` as the canonical message/diff identity (falling back to `response.id`), so coding-agent workspace diffs match both live and persisted assistant rows.
- The production Run Broker SSE path now sets `state.runId`, tags assistant/tool rows, and persists that id before controller completion clears transient run state.

## Verification

- Failing-first client regressions cover stale/zero totals, resume timeout, delayed hydration, reconnect-empty preservation, and store disposal.
- Focused client verification: 6 files / 93 passed.
- Focused server verification: 14 files / 184 passed.
- Full suite: 313 files / 2391 passed / 2 skipped / 0 failed.
- `npm run harness:check` and `npm run build` passed.
- A fresh Playwright browser against the worktree production build and a real local DB snapshot observed a paginated `200`, 7 rendered message nodes, and 0 empty-state nodes after Socket.IO resume timeout.

## Release Status

The initial hydration fallback is merged into local main as `acda7568`, but the review hardening above remains in the task worktree and is not running on `:8648`. Nothing from this task has been published to production. Current browser evidence is from the isolated hardened build on `127.0.0.1:8750`.
