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
- A workspace-root Git deadline is propagated explicitly instead of being
  treated as an ordinary "not a Git repository" result. This prevents a
  filesystem fallback from starting fresh root I/O in the final timer tick
  after the shared deadline has already won the Git probe race.
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
- Broker run cleanup now matches the exact in-memory session state and run marker.
  A generation mismatch cancels the old queue through a controller callback that
  performs no DB writes and deletes the map entry only when it still points to the
  old object. Setup rejection uses the same scoped finalizer. Abort only signals
  the stream; after diff completion that stream performs the sole finalizer and
  dequeues once from the latest queue, so an old completion cannot clear a new run.
- The relay rechecks the exact state/generation before every SSE frame emit, so an
  old stream cannot leak content, tools, terminal events, or workspace diff into a
  same-id replacement room. Goal continuations enter the normal session FIFO and
  yield to queued user work or abort. Identity/finalization persistence errors now
  emit a visible failure, clear the exact run, and release the latest queue.
- Controller state now binds SQLite rowid plus process incarnation. The public
  socket replaces stale state after a real HTTP delete/recreate, while a shared
  create-and-bind helper covers user, command, and completion-created sessions.
  Resume/replay DB hydration uses a generation CAS, and finding a stale live state
  immediately aborts/releases its old upstream rather than waiting for another frame.
  Clean aborts emit only `abort.completed`; hanging goal evaluation uses a dedicated
  controller linked to the run signal, so user queue admission can cancel only the
  evaluation. Abort cleanup errors mark completion as failure-pending so the WebUI
  keeps its handler for the following concrete failure, and usage emits recheck exact ownership.
  The never-populated `hermesSessionIds` late-sync path was removed rather than
  adding another completion epoch.
- `/plan` and `/goal` use the same FIFO as user runs. Their command HTTP lookup owns
  an exact state/marker/generation reservation until it atomically hands off to the
  hidden run; command failure, abort, or same-id recreation releases that reservation
  without letting stale results persist or emit. An exact mapped stale command state
  is abandoned even for an immediate nonserialized control, while a post-create
  one-time generation read failure rebinds before surfacing the setup error so its
  queued runs remain on the new row. A pre-admission identity failure is
  requester-scoped as `run.rejected` with `queue_id`; the client settles only the
  rejected owner (or removes only that follow-up), without closing a live sibling.
- Socket reconnect now keeps one Socket.IO object for the same profile, transport,
  and active agent while its manager is still reconnecting. The implicit-profile
  path resolves the current Pinia profile before the reuse guard, so changing the
  active profile retires the old socket and its exact owner even when the caller
  omits the optional profile argument. An attached owner added
  after the disconnect observes the next connect and resumes its exact session;
  an actual profile/transport/agent replacement retires the old owner and its store
  runtime instead of leaving a permanently live spinner. Reconnect callbacks recheck
  their exact owner after asynchronous replay handling, and an authoritative idle
  switch response retires the matching old stream owner without touching a newer one.
  A `connect_error` remains retryable only while Socket.IO reports `socket.active`;
  an inactive initial connection or exhausted reconnect now fails the exact owner and
  removes its listeners instead of leaving an orphaned live state.
- Durable terminal events carry one stable `resume_event_id` in both the live payload
  and pending replay. The browser reserves an ID while applying it, acknowledges only
  after the owning store handler succeeds, and acknowledges only the exact IDs that
  handler returned. This covers `run.failed`, `abort.completed`, `session.command`,
  terminal `run.reattach_failed`, and `auth.resolved`; identical error text from
  distinct event IDs is intentionally preserved. If current resume state says an
  abort is still in progress, an older replayed `abort.completed` is acknowledged but
  cannot clear that authoritative abort state.
- Successful terminal `/plan` and `/goal` `session.command` results now enter the
  same generation-bound pending terminal store as failures. Live delivery and
  reconnect replay share one ID; acknowledgement removes the event only for the
  acknowledging socket, while other session tabs can still replay it.
- Credential replay is tied to the session generation that emitted `auth.required`
  and is consumed only by a valid one-shot replay. A stale card cannot inject an old
  parked request after the same session ID is deleted and recreated. Replay uses the
  server's parked connector/provider metadata rather than client-supplied values. If a
  sibling run is busy, the server rotates and re-surfaces the card; if identity/session
  loading fails before dispatch, it restores a fresh card before emitting the terminal
  replay failure, so the user can retry without reloading. Accepted replay broadcasts
  a stable, row/incarnation/run-bound `auth.resolved` to every session tab and retains
  it until each socket acknowledges it. The Global Agent relay forwards both
  `auth.resolved` and `resume.events.ack`, preserving the same behavior on that
  transport. The client reattaches first and then emits through the resulting current
  socket; broker-down and other valid-generation reattach failures remain pending
  until the browser applies and acknowledges them.
- HTTP session deletion reads the exact row/incarnation generation and abandons that
  in-memory run before either remote Hermes deletion or the local SQLite transaction.
  The broker matches row/incarnation before aborting, while the corresponding generic
  chat runtime is synchronously detached before deletion awaits; queues, parked
  credential cards, and runtime maps are cleared server-side, so correctness no longer
  depends on a follow-up browser socket abort. Client deletion still unregisters only
  after the server request returns, then clears queue, interaction, reauth, diff, and
  stream state before a same-ID client object can be created.

## Regression coverage

- A delayed fake Git executable is released by an already-pending event-loop
  callback; the callback runs while the checkpoint is unresolved. The test
  accepts the documented deadline fallback when a loaded runner delays the
  child long enough to return an empty checkpoint.
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
  third checkpoint starts only after one delayed root operation settles. The
  Git-root timeout regression also proves the near-deadline filesystem fallback
  cannot start an extra root operation.
- Seven changed Git paths with four-second delayed HEAD and patch subprocesses prove terminal
  checkpoint completion returns on the single deadline, preserves the six
  completed paths, marks the result truncated, and waits for late cleanup. An
  oversized CJK/emoji patch proves the stored UTF-8 round trip is exact and its
  byte length remains at or below 256 KiB.
- A delayed broker diff plus a `markCompleted` callback that schedules a goal
  continuation proves the order is diff completion/emission, session completion,
  terminal emission, then continuation.
- Controller-level delayed checkpoint delete/recreate, setup rejection,
  diff-await enqueue, and abort-with-queued-run regressions prove the old state is
  released, replacement state is untouched, and exactly one next run starts only
  after the old diff/finalizer completes. Per-frame replacement-room fencing,
  idle/user/abort goal FIFO, identity getter rejection, and persistence rejection
  cover the remaining finalizer exits. Public-socket + real-SQLite same-id reuse,
  new user/plan bootstrap, setup/handoff/addMessage rejection, clean/exception abort,
  hanging goal evaluation cancelled by queue admission alone, guarded usage,
  resume/replay load CAS, active command FIFO/reservation/recreate/abort, first/follow-up
  request rejection, and immediate cancellation of a hanging old generation cover
  production entry points. An explicit-abort regression also proves a hanging goal
  evaluation exits from its linked signal without any upstream response. The final
  lifecycle/auth/expert set additionally covers same-identity offline socket reuse,
  attached-owner registration during reconnect, actual socket replacement cleanup,
  inactive initial/exhausted reconnect failure cleanup, exact owner retirement after
  awaited callbacks, multiple idle terminal replay rows, authoritative in-progress
  abort state over an older completion, HTTP delete abandonment before remote/local
  deletion, post-attach credential replay socket selection, server-authoritative busy
  replay, pre-dispatch card restoration, handler-before-ACK failure retry, same-ID
  stale auth-card rejection, per-socket multi-tab `auth.resolved` replay/ACK, Global
  Agent forwarding, and stable reattach-failure replay. Server/client TypeScript and
  `git diff --check` pass. The delayed Git fixture uses a pending callback instead
  of a fixed timer delay, so full-suite load cannot expire the shared deadline before
  the test action starts.
- The reconnect suite changes the active profile while calling `connectChatRun()`
  without a profile and proves the old owner is retired and the new socket queries
  the selected profile. Client/server lifecycle tests also prove successful terminal
  commands ACK after live handling and replay with the same ID until each socket ACKs.
- Focused workspace, bridge, broker, and coding-agent suites: 4 files / 76 passed.
- Final reconnect/command lifecycle: 2 files / 80 passed.
- Final full Vitest: 320 files / 2594 passed / 2 skipped (2596 total).
- Client/server TypeScript, production build, `harness:check`, and
  `git diff --check` pass. Independent review of the new frozen hash remains
  required before release consideration.

## Release status

This is an ftask worktree candidate only. It has not been merged, pushed, or
published to production. Production backup, pull/build/restart, health/log
verification, and user canary remain mandatory after an explicit ship request.
