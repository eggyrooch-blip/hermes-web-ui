---
date: 2026-07-18
pr: pending
commit: pending
feature: Idempotent session command replay
impact: Reconnecting tabs retain command failures and render persisted terminal command results exactly once.
---

Broker `/plan` and `/goal` result messages now receive a stable database
`client_id`, and the matching `session.command` event carries that identity as
`command_message_id`. A browser that hydrates the message and then consumes the
pending terminal event enriches the existing row instead of appending a second
copy. The submitted slash-command row also reuses its optimistic `queue_id`, so
hydration cannot duplicate the user's original command.

If session-generation lookup fails before the result can be persisted, the
pending event's stable resume ID becomes the command message ID. The failure is
retained for replay even while a queued run makes it temporarily non-terminal,
and remains pending until each socket acknowledges it.

Regression coverage includes the real resume shape containing both hydrated
messages and pending events, plus a generation lookup failure followed by a
queued run and per-socket replay acknowledgement.
