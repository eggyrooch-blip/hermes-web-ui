---
date: 2026-07-30
pr: local-awaiting-verify
feature: Broker run session model stickiness + cross-profile session fence
impact: Later turns keep the model chosen in the chat header instead of silently reverting to the profile default; a socket can no longer drive a session row owned by another profile.
---

# Broker run session model stickiness + cross-profile session fence

Two changes in `packages/server/src/services/hermes/run-chat/handle-broker-run.ts`,
both at the single point where a Run Broker request is built.

## Session model stickiness

The chat header's model selection is persisted on the session row by
`POST /api/hermes/sessions/:id/model`, but the client only sends `model` /
`provider` on a session's first turn. Every later turn reached the broker with no
model in `metadata`, so the gateway fell back to the profile's `config.yaml`
`model.default` while the UI still displayed the chosen model.

The run path now reads back the session row it already fetched. Request values
still win; when the turn carries no model, the stored `model` + `provider` **pair**
is used (the request provider is never mixed with the stored model); a session that
never picked a model keeps the previous behavior and falls through to the profile
default.

No `model_groups` validation is performed on purpose. An invalid or delisted model
must fail loudly at the gateway rather than be silently swapped for another one.
The visible consequence: if a session's stored model is later delisted, that
session errors on every turn until the user picks a different model.

## Cross-profile session fence

`getSession(id)` resolves a session by id alone — the `sessions` table has a
`profile` column, but no query filters on it. A socket authenticated as profile B
could therefore submit profile A's `session_id` and write into A's transcript,
adopt A's persisted model/provider, and inherit A's stored workspace.

The run path now compares `sessionRow.profile` against the authenticated `profile`
immediately after the row is fetched, before any workspace resolution, message
write, or broker fetch. On mismatch the run is abandoned and the socket receives
`run.rejected`; nothing is persisted.

Strict equality is safe for shared agents: the socket middleware already resolves
`socket.data.profile` to the shared profile (`sharedAgentProfile` /
`ownerOwnsProfile` in `broker-controller.ts`), so legitimate shared access arrives
carrying the owner's profile. Legacy rows are unaffected — both the row mapper and
`createSession` default a blank profile to `default`.

## Verification

- `tests/server/run-chat-broker-session-model.test.ts` (7 cases: stickiness,
  pair integrity, no-model passthrough, cross-profile rejection, matching-profile
  and legacy-default passthrough)
- `tests/server/broker-run-replay.test.ts`, `run-chat-broker.test.ts`,
  `run-chat-broker-expert.test.ts`
- full Vitest suite
- `npm run harness:check`
- `npm run build`

No browser check, live model call, or production action was performed.
