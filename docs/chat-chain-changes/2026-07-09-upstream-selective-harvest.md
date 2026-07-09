---
date: 2026-07-09
feature: Selective upstream harvest
impact: Ports the upstream fixes that fit the Hermes WebUI boundary without importing plugin/runtime maintenance surfaces.
---

This change ports five bounded upstream areas into the fork: bridge terminal-error false-positive guarding, session archive/local-only History support, workspace symlink containment, read-only workspace diff cards, and configurable chat input height.

Workspace diff is deliberately read-only. Producers record a summary and truncated patch metadata for explicit-workspace runs; the chat card stores only summary fields and fetches a file patch only after the user clicks a file. The card does not expose edit/write actions.

Chat input height is a display setting used by desktop ChatInput and GroupChatInput. Mobile input remains auto-height so narrow screens are not pinned to the desktop setting.

Areas 7/8 were left as go/no-go notes: upstream plugin management and skills usage would expand maintenance/editing surface beyond the approved scope.

Validation: focused Vitest, client/server TypeScript checks, `git diff --check`, full `bun run test`, `npm run build`, and Playwright screenshots passed locally. This change is not production-released by itself.
