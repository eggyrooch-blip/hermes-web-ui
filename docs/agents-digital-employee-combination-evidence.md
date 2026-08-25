# Agents × digital employee combination evidence

Reproducible local candidate only; production is untouched.

- Combination tree: `/tmp/hermes-agent-final.7Nv8wc` (generated read-only composite; not a Git worktree)
- Rebuild inputs: `agents-digital-employee-conflicts@0504ed43282f`, `digital-employee-session-entry@ca835830ae9a`, `digital-employee-scheduled-entry@262fc202ec011`, `digital-employee-human-handoff@c9b641e83b06`.
- Exact focused command:
  `npm test -- --run tests/client/agents-hub-new-task-binds-profile.test.ts tests/client/agent-detail-new-task.test.ts tests/client/chat-panel-user-mode.test.ts tests/client/chat-input-agent-selector.test.ts tests/client/chat-store-expert-profile-switch.test.ts tests/client/page-sidebar-nav-enterprise.test.ts tests/client/chat-scheduled-entry.test.ts tests/client/handoff-ui.test.ts tests/client/chat-view-startup.test.ts tests/client/profiles-store.test.ts tests/server/broker-controller-expert-persistence.test.ts`
- Observed after the final authorized-deep-link retry fix: exit 0, 11 files, 84/84 tests.
- Gates: `npm run typecheck` and `npm run build`, exit 0 on both the task tree and combination tree.
- Audited captures: `.ftask/agents-digital-employee-conflicts/SIM_TRACE.md` scenarios 1–4; screenshots in `.ftask/agents-digital-employee-conflicts/sim_artifacts/`.
