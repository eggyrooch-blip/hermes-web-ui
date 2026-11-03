---
date: 2026-09-21
pr: pending
feature: Agent session lifecycle
impact: Agent runs now persist session end markers on terminal completion or abort and reopen ended sessions when a new run starts.
---

Ported from upstream `bde8f2b0e` (hermes-studio #2004). Hermes bridge and coding-agent runs write `ended_at`
and `end_reason` when the run terminates without another queued run. Explicit aborts write
`end_reason: abort`. Starting a new run on an existing session clears those fields and refreshes
`last_active`, so database-backed session summaries can distinguish a completed or aborted run from a session
that is actively running again. The existing `sessions` columns are reused; no schema change.
