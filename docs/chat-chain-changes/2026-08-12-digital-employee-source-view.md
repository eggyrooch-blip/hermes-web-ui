---
date: 2026-08-12
pr: pending
feature: Digital employee answer sources
impact: Final-answer source cards persist across refresh while private sources are reauthorized for the current principal on hydration and open.
---

# 2026-08-12 — digital employee answer sources

- F-task: `digital-employee-source-view` (local candidate; no PR/ship yet).
- Touched chain: broker final event → in-memory final assistant → SQLite → authorized hydration → `MessageItem`.
- Behavior: only normalized top-level `done.source_refs` attach to the final answer. Public HTTPS/workspace refs use existing safe boundaries; private Lark refs are omitted unless the current principal passes batch authorization and are reauthorized on every open.
- Compatibility: messages without sources, tool/intermediate rows, feedback, Markdown, pagination, and resume retain their existing behavior. An output-only final event creates a persisted final assistant only when it also has non-empty sources.
- Production impact: none; no ship, deployment, model call, employee message, or production probe.
