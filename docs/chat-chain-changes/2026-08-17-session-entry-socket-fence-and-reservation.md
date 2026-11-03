---
date: 2026-08-17
pr: local-awaiting-verify
feature: Digital-employee session entry — full socket ownership fence + synchronous run reservation
impact: Every socket control event (resume, cancel_queued_run, resume.events.ack, abort, clarify.respond, credential.replay) now passes the same session-ownership fence as 'run', so a same-profile foreign principal can no longer replay a transcript or drive another user's session; concurrent submits can no longer double-dispatch during expert-catalog resolution.
---

# Session entry: socket ownership fence on all control events + synchronous run reservation

Two hardening changes in `packages/server/src/services/hermes/broker-controller.ts`,
both extending the expert session-entry ownership model (delta review findings).

## Ownership fence on every control event

`rejectsUnauthorizedSession` (profile + `row.user_id` vs socket principal,
expert sessions with no owner reject) previously guarded only `run`/`handleRun`.
It now runs first in `resume`, `cancel_queued_run`, `resume.events.ack`,
`abort`, `clarify.respond`, and `credential.replay` — before any room join,
state read/mutation, or broker call. Unknown session ids still pass (first
message legitimately precedes the row).

## Synchronous reservation before the catalog await

`handleRun` and `handleBrokerSessionCommand` used to await
`resolveRunExpert` (expert catalog fetch) BEFORE marking the session working.
Two concurrent submits both observed an idle session, overwrote
`activeRunMarker`, and could double-dispatch. Both paths now reserve the
session state synchronously (busy → queue, same payload shape as the socket
entry), then await the catalog, then re-run the ownership fence before any
write — covering rows deleted/recreated for another principal during the
await. Catalog failures release the reservation and keep the existing
`run.rejected` contract.

## Round-4 hardening (same review loop)

- Control events now require an EXISTING row (`requireExistingRow`): a foreign
  principal can no longer `resume` into a rowless in-memory session during the
  owner's first-turn window. Missing-row admission remains only for `run`.
- Queued runs record the enqueuer principal; the drain discards any item whose
  principal does not match both the row owner and the dispatch socket, so a
  raced foreign prompt can never execute under the owner's credentials.
- Both `handleRun` and `handleBrokerSessionCommand` capture the SQLite session
  generation at reservation and reject after the catalog await when the row was
  deleted/recreated — including by the same owner.
- `fetchExpertCatalog` no longer fabricates a missing broker `profile_name`;
  an absent binding now fails the catalog/profile mismatch check upstream.

## Round-1 (reopened loop) hardening

- `resolveRunExpert` rejects expert overlays for `global_agent` runs/sessions,
  same as `coding_agent`.
- REST history endpoints apply the same chat-plane owner rule as the socket
  fence: owner-stamped rows are listed/read only by their owner (admin-plane
  profile oversight and explicit shared-agent policy unchanged).
- The client skips the `resume` round-trip for brand-new locally-created
  sessions (`localCreated`): the rowless-control fence rejects it server-side
  and used to strand the UI in loading for 15s.
- Queue drain is iterative (flood-safe) and per-session queued admissions are
  capped at 20 with `run.rejected: Session queue is full`.
- Expert avatar `<img>` errors fall back to the initial glyph.

Regression coverage: `tests/server/broker-controller-expert-persistence.test.ts`
(control-event A/B rejection incl. rowless, concurrent-submit queueing,
foreign-principal dequeue discard + flood drain + admission cap, global-agent
expert rejection, cross-principal and same-owner recreated-row post-await
rejection); `tests/server/sessions-controller.test.ts` (chat-plane owner rule:
list hiding, read denial, admin oversight preserved);
`tests/client/chat-store-expert-profile-switch.test.ts` (rowless resume skip).

## CI-red follow-up (same task)

Three defects this task's own hardening introduced, found by CI and fixed here:

- **First-turn create was misread as a recreate.** The reservation captured the
  session generation before the row existed, so the post-await compare saw
  `{null,null} → {rowId,inc}` and rejected every brand-new session's first run.
  The compare now only applies when a row existed at reservation time.
- **The dequeue guard discarded internal re-entry.** Queued items with no
  recorded principal (goal continuation, command replay, pre-fence socket
  enqueues) were treated as foreign and dropped, stranding the owner's own
  queued work. Only a *recorded* mismatching principal is grounds for discard.
- **`releaseRunReservation` cleared fewer fields** than the pre-existing failure
  path, leaving a stale `abortController`/`runId` behind. It now clears the same
  set.

Also: the rowless-session resume now registers its channel and resolves
immediately instead of skipping registration (new sessions still need the
channel for their first run), and a `credential.replay` rejected by the
row-required fence keeps emitting the terminal `run.reattach_failed` signal so
the auth card stops retrying.
