---
date: 2026-08-18
pr: local-awaiting-verify
feature: Digital-employee answer feedback (thumbs up/down with reasons)
impact: A user can rate the final answer of each run; ratings are keyed on the trusted principal + session + authoritative run id and stored in a schema-decoupled `message_feedback` table, so message rewrites/compaction never orphan or mis-attribute a rating. Trusted session-creation paths now stamp `user_id` so the owner is always known at write time.
---

# Answer feedback on the chat chain

## Storage

New `message_feedback` table (`packages/server/src/db/hermes/feedback-store.ts`),
deliberately decoupled from the message schema. Primary key = trusted principal
+ session + authoritative run id. Missing, ambiguous, cross-principal,
non-final-answer, or tool/error/draft rows fail closed before any write.

## Run chain

Every trusted session-creation path (WebUI/API/Bridge/broker) now writes the
session `user_id`, which the feedback API relies on to resolve ownership. The
run handlers persist the authoritative broker run id on the final answer so a
rating can bind to the exact run rather than to a message row.

`canAccessSessionAsync` is exported for the feedback controller; its chat-plane
owner rule (from `digital-employee-session-entry`) applies unchanged — an
owner-stamped row stays private to its owner, an ownerless *expert* row is
dirty state and readable by nobody, and shared-agent policy remains the only
secondary grant path.

## Client

`FeedbackControl.vue` renders native thumbs up/down with five fixed reasons,
re-selection, undo, retry-on-failure, keyboard focus, and a 390px layout. Each
session loads its feedback exactly once; controls appear only on the last
completed non-empty answer of a run.

## Plane classification

Four new chat-plane endpoints are allowed (checked into the plane snapshot):
`GET|HEAD /api/hermes/sessions/:sessionId/feedback` and
`PUT|DELETE /api/hermes/sessions/:sessionId/runs/:runId/feedback`.
