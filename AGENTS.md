# Agent Map

This file is a short map for coding agents. Keep detailed guidance in `docs/`
and keep this file small enough to fit into every task context.

## First Reads

- `DEVELOPMENT.md` - project commands, coding rules, test rules, and PR shape.
- `ARCHITECTURE.md` - package boundaries, data ownership, and runtime flow.
- `docs/harness/README.md` - how this repository is prepared for agent work.
- `docs/harness/validation.md` - which checks to run for each change type.
- `docs/harness/worktree-runbook.md` - isolated local dev and test setup.
- `docs/harness/pr-review.md` - self-review checklist before pushing.

## Common Commands

```bash
npm ci --ignore-scripts
npm run harness:check
npm run test
npm run test:e2e
npm run build
```

Use the smallest relevant check while iterating. Before a broad PR, run
`npm run harness:check`, `npm run test:coverage`, `npm run test:e2e`, and
`npm run build`.

## Code Ownership Map

- `packages/client/src` - Vue 3 client, stores, routes, i18n, API helpers.
- `packages/server/src` - Koa API, Socket.IO, persistence, Hermes integration.
- `packages/desktop` - Electron wrapper, bundled Python/Hermes runtime, release artifacts.
- `tests/client`, `tests/server`, `tests/shared` - Vitest coverage.
- `tests/e2e` - Playwright browser coverage with mocked backend services.
- `.github/workflows` - CI, release, Docker, and desktop packaging automation.

## Hard Rules

- Keep routes thin: put request handling in controllers and reusable behavior in services.
- Keep Web UI state under `HERMES_WEB_UI_HOME` or `HERMES_WEBUI_STATE_DIR`.
- Keep Hermes Agent state separate from Web UI state.
- Register local API routes before proxy catch-all routes.
- Use structured APIs and argument arrays instead of shell string construction.
- Add user-facing strings to every locale file.
- Do not mix unrelated refactors into a bug fix.

## When The Agent Gets Stuck

Improve the harness instead of repeating the same prompt. Add missing docs,
tests, logs, scripts, or CI checks so the next agent can see and verify the
constraint directly.

<!-- ftask:managed v1 — auto-generated; edit OUTSIDE this block -->
# Agent rules — hermes-web-ui (managed by ftask)

- This repo is part of sunke's agent-OS. Agents NEVER run git directly here — use `bun ~/.claude/PAI/TOOLS/ftask.ts`.
- Base branch: `main`. WORKTREE MODE: the main checkout stays PERMANENTLY on `main` — it is sunke's verification environment, NEVER switch its branch or write to it. `ftask new <slug>` gives each task its own worktree at `hermes-web-ui.tasks/<slug>`; do ALL work there. Parallel agents = parallel worktrees, zero contention.
- Test gate: `ftask ship` runs `bun run test` (auto-detected) in the rebased tree and BLOCKS the merge if it fails.
- Ship semantics: `ftask ship` merges into `main` then STOPS — sunke verifies in his local environment on `main` (worktree mode: the main checkout already shows the merge, zero switching); only after his OK run `ftask postship <slug> --finalize` (push + remove worktree + delete branch). NOT OK → `ftask revert <slug>`.
- Code questions (where is X / who calls X / what breaks if I change X): this repo has a `.codegraph/` index — use the `codegraph_*` MCP tools (explore/callers/callees/impact) FIRST instead of grep/Read sweeps; cross-repo queries take a `projectPath` arg. Human-readable architecture map: vault `AgentOS/<repo>/GRAPH.md`.
- When you fix a bug found while troubleshooting (a 排障), add a regression test that FAILS without the fix BEFORE `ftask ship`, and record the root cause as one line under "Known gotchas" below.
- Global protocol: `~/.claude/CLAUDE.md` (Claude) and `~/.codex/AGENTS.md` (Codex) — "AGENT-OS" section. User cheatsheet: `~/code/AGENT-OS.md`.

## Known gotchas
- 2026-06-23：WebUI chat-plane 上传图片会落在 routed profile 的 `workspace/uploads`；Run Broker `content` 不能把 ContentBlock 直接 JSON.stringify，否则 multitenancy AIAgent 只会看到普通 JSON 文本并让工具去错误目录按 basename 搜图。broker 当前用户消息必须提供 `/workspace/uploads/...` 语义的工具路径。
<!-- /ftask:managed -->

## Local known gotchas

- 2026-07-17: Workspace diff checkpointing runs on the shared Node server; synchronous Git/filesystem work blocks every tenant, so Git, scanning, and file reads must remain asynchronous and bounded.
- 2026-07-17: Session deletion owns messages and both workspace-change tables as one SQLite unit; independent cleanup can leave permanent patches or partial deletion after a later statement fails.
- 2026-07-18: A Socket.IO `connect_error` is retryable only while `socket.active`; replayed terminal events must not override newer authoritative resume state.
- 2026-07-18: HTTP session deletion must abandon the exact in-memory session generation before deleting its row; a follow-up browser socket abort is not a server lifecycle guarantee.
- 2026-07-18: Resolve the effective active profile before the Socket.IO reuse guard; an omitted profile argument must not reuse a socket owned by the previously selected profile.
- 2026-07-18: Every terminal `session.command`, including successful `/plan` and `/goal` results, needs one generation-bound pending ID before live emit so reconnect and per-socket ACK cannot lose it.
