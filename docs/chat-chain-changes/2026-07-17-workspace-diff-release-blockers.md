---
date: 2026-07-17
pr: pending
feature: Workspace diff release blockers
impact: Prevents workspace checkpoint work from blocking other WebUI users and removes stored patches atomically with their session.
---

# 2026-07-17 — workspace diff release blockers

## Change

- Workspace checkpoint Git commands, directory traversal, file reads, and
  no-index patch generation now use asynchronous child-process/filesystem APIs.
- Broker, bridge, and coding-agent runs await the initial baseline before the
  real run starts, then await diff completion before their terminal chat event.
  Diff failures remain non-fatal to the chat run.
- Git commands have a 5-second timeout; non-Git workspace traversal keeps a
  1-second deadline plus the existing directory, depth, file, byte, patch, and
  secret-path limits.
- Session deletion now removes messages, workspace change files, workspace
  change summaries, and the session row in one SQLite transaction. Older
  databases without the optional workspace tables remain deletable.

## Regression coverage

- A delayed fake Git executable proves a timer can run while the checkpoint is
  pending, and the post-baseline edit is still recorded.
- A forced SQLite message-delete failure proves all session and patch rows roll
  back; the subsequent successful delete proves all four record sets are empty.
- Focused workspace, bridge, broker, coding-agent, and Windows process suites:
  5 files / 87 passed.
- Full Vitest suite: 318 files / 2481 passed / 2 skipped.
- `npm run build`, `npm run harness:check`, server TypeScript, and
  `git diff --check` passed.

## Release status

This is an ftask worktree candidate only. It has not been merged, pushed, or
published to production. Production backup, pull/build/restart, health/log
verification, and user canary remain mandatory after an explicit ship request.
