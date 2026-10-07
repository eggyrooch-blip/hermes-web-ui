---
date: 2026-09-21
pr: pending
feature: Bridge pre-persisted user-message deduplication
impact: After a bridge user-message write succeeds, native persistence skips exactly the matching user entry once, falls back to native persistence when the pre-persist write fails, and clears stale pending state after the run.
---

Ported from upstream `973e1a5c8` (hermes-studio #2601). `AgentPool._install_prepersist_dedup_hook` wraps the
agent's `_persist_session` once per agent and consumes a single one-shot marker set only after the durable
bridge write succeeds; the run's `finally` clears the marker so an interrupted run cannot suppress a later turn.
