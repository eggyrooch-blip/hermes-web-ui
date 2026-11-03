---
date: 2026-08-18
pr: local-awaiting-verify
feature: Scheduled expert entry coexisting with the M-0 executor picker
impact: A chat session can open the existing job form prefilled ("定时执行"), and that scheduled-from-chat create is now told apart from an ordinary M-0 executor create by its source session — previously an executor create carrying only `expert_id` was misrouted into the scheduled-session admission and rejected with 403.
---

# Scheduled expert entry alongside the M-0 executor picker

`ChatInput.vue` gains the scheduled-entry control next to the existing agent
picker; both are rendered from the same composer.

## Scheduled-vs-executor discriminator

`packages/server/src/controllers/hermes/jobs.ts` used to treat any create body
containing `source_session_id`, `expert_id`, or `idempotency_key` as a
scheduled-from-chat create, then require a matching owned source session.

M-0's executor picker also sends `expert_id` (the executor agent's expert) with
no source session, so every executor create fell into that branch and was
rejected 403. The discriminator now keys on `source_session_id` /
`idempotency_key` only — the fields that exist solely for the chat-originated
flow. Scheduled creates keep their full fail-closed admission (owner match,
profile match, non-coding/global-agent source, bound expert, idempotency key
format); executor creates keep the plain M-0 path.

Test coverage: `tests/server/jobs-controller.test.ts` keeps both suites' cases
(M-0 executor forwarding + scheduled session binding with forged-field
stripping); `tests/client/job-form-modal.test.ts` covers the prefilled modal,
cancel-with-zero-writes, and the single bound create under the M-0 form.
