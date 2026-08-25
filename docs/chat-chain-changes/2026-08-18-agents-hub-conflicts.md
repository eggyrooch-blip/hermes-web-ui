---
date: 2026-08-18
pr: local-awaiting-verify
feature: Agents hub / digital-employee surface conflict reconciliation
impact: The chat composer and panel keep one agent selector and one new-chat profile list across the agents hub, expert catalog and scheduled-entry surfaces; the sidebar's single-conversation tab is driven by one predicate instead of per-surface tab lists, so adding a surface can no longer leave the tab unhighlighted.
---

# Agents hub conflict reconciliation

Several digital-employee surfaces landed in parallel and each extended the same
composer/sidebar seams. This task reconciles them:

- `ChatPanel.vue` keeps ONE `newChatProfileOptions` builder — the agent-aware
  one (`agentDisplayName` with the unnamed-group fallback and a `default`
  placeholder when the roster is empty) — and one `createDefaultUserChat`
  profile resolution that still honours an active workspace filter.
- `PageSidebarNav.vue` drives the single-conversation tab from
  `isSingleConversationActive` (`active !== 'group'`) rather than an explicit
  tab list, so a newly added surface cannot silently fall outside it.
- `ChatInput.vue` hosts the agent picker and the scheduled-entry control side
  by side, each importing its own component once.

Test coverage: `tests/client/chat-panel-user-mode.test.ts`,
`tests/client/page-sidebar-nav-enterprise.test.ts`,
`tests/client/history-view-user-mode.test.ts`.
