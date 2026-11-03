---
date: 2026-09-21
pr: pending
feature: Broker subagent terminal state and replay
impact: Subagent cards retain results, order and timestamps across runs and reconnects; unfinished cards become interrupted when the parent terminates.
---

The broker mapper forwards truncation metadata. The client protects terminal cards from late progress/tool frames and labels truncated results using existing translations.

Broker controller initialization and finalization preserve per-card snapshots. Both resume handlers sort snapshots by their original creation time and emit them to registered subagent listeners. Snapshots remain in memory; this does not add persistence across server restarts.

Regression coverage includes a real two-run broker/controller lifecycle with message loading, parent completion/failure/abort, stable replay order, late live tool frames, and result truncation.
