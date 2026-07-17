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
  Broker terminal handling also completes the old run's diff before
  `markCompleted`, so a goal continuation cannot mutate the workspace before
  that diff is captured. Diff failures remain non-fatal to the chat run.
- Git commands have a 5-second timeout; non-Git workspace traversal keeps a
  1-second deadline, streams directory entries with `opendir`, and limits
  expensive checkpoint/diff work to two concurrent operations. The deadline
  also covers workspace root Git probing/`realpath`/`stat`, snapshot
  `lstat`/`realpath`/`stat`/`readFile`, Git HEAD snapshots, and no-index patch
  generation across the whole changed-path loop; there is no new
  directory-entry cap. Existing depth, file, byte, patch, and secret-path limits
  remain.
- If a timed-out `opendir`/`read` finishes late, its directory handle is closed
  and its limiter lease stays occupied until cleanup, so hidden filesystem I/O
  cannot accumulate beyond the same process-wide concurrency bound.
- Timed-out snapshot filesystem promises likewise retain their limiter lease
  until settlement, while the visible checkpoint returns promptly as truncated.
- Timed-out Git HEAD and patch promises retain the same lease until the child
  settles and any temporary patch directory is removed, but do not start more
  Git work after the absolute deadline. Stored patches are truncated to a valid
  UTF-8 byte prefix, so CJK and emoji cannot exceed the byte budget or leave a
  broken code point.
- Session deletion now removes messages, workspace change files, workspace
  change summaries, and the session row in one SQLite transaction. Older
  databases without the optional workspace tables remain deletable.
- A completed diff can only insert rows while its session still exists in the
  same SQLite transaction and still matches both the original rowid and a
  process-lifetime incarnation token. Broker, bridge, and coding-agent paths
  also discard a delayed checkpoint instead of launching work after that session
  id was deleted and recreated.

## Regression coverage

- A delayed fake Git executable proves a timer can run while the checkpoint is
  pending, and the post-baseline edit is still recorded.
- A forced SQLite message-delete failure proves all session and patch rows roll
  back; the subsequent successful delete proves all four record sets are empty.
- Delayed-delete regressions cover broker, bridge, coding-agent, and final patch
  persistence; a valid file created after 5,200 skipped directory entries is
  still tracked while the deadline has time, and six parallel checkpoints prove
  the process-wide maximum stays at two.
- A delayed-opendir regression proves eventual close and that a third scan does
  not start while two timed-out real opens remain unresolved; a delayed-lstat
  regression proves the same bound for snapshot I/O. Delete/recreate regressions
  prove old runs cannot bind to a replacement session with the same id.
- Delayed workspace root `realpath` and `stat` regressions return within the
  deadline while keeping both concurrency leases occupied until settlement; a
  third checkpoint starts only after one delayed root operation settles.
- Seven changed Git paths with four-second delayed HEAD and patch subprocesses prove terminal
  checkpoint completion returns on the single deadline, preserves the six
  completed paths, marks the result truncated, and waits for late cleanup. An
  oversized CJK/emoji patch proves the stored UTF-8 round trip is exact and its
  byte length remains at or below 256 KiB.
- A delayed broker diff plus a `markCompleted` callback that schedules a goal
  continuation proves the order is diff completion/emission, session completion,
  terminal emission, then continuation.
- Focused workspace, bridge, broker, and coding-agent suites: 4 files / 76 passed.
- Full Vitest suite: 318 files / 2493 passed / 2 skipped.
- Client/server TypeScript, production build, and `harness:check` passed.

## Release status

This is an ftask worktree candidate only. It has not been merged, pushed, or
published to production. Production backup, pull/build/restart, health/log
verification, and user canary remain mandatory after an explicit ship request.
