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
- (root causes from 排障 sessions accrue here so the same bug is never debugged twice)
- 2026-06-23：WebUI chat-plane 上传图片会落在 routed profile 的 `workspace/uploads`；Run Broker `content` 不能把 ContentBlock 直接 JSON.stringify，否则 multitenancy AIAgent 只会看到普通 JSON 文本并让工具去错误目录按 basename 搜图。broker 当前用户消息必须提供 `/workspace/uploads/...` 语义的工具路径。
- 2026-07-17：异步 workspace checkpoint 可能跨过会话删除边界；只查 id 或 rowid 不够（SQLite 可复用末尾 rowid），patch 写入和 await 后启动检查必须同时匹配 rowid + 进程内 incarnation token。workspace 根目录 Git 探测/`realpath`/`stat`、`opendir/read`、snapshot、Git HEAD 与 no-index patch 都必须受绝对 deadline 保护；迟到工作在真实 I/O settlement/FD 或临时目录清理前保留并发 lease。不要用目录项数量硬截断替代时间 deadline；patch 也不能按 UTF-16 下标冒充 UTF-8 字节上限。broker terminal 必须先完成旧 run 的 workspace diff 再调用 `markCompleted`，否则 goal continuation 会抢先修改 workspace 并污染旧 diff。
<!-- /ftask:managed -->

## Release lifecycle gotcha

- 2026-07-18：broker run 跨 checkpoint/diff await 收尾不能只按 session id 或提前缓存 queue length；必须绑定 exact `SessionState` + run marker + DB rowid/incarnation，由 stream 在 diff 后执行唯一 finalizer，再按最新 queue 单次 dequeue。HTTP delete/recreate不会自动清 controller map，enqueue/start/resume/replay 必须 generation-fence；发现 stale live state 要立即 signal/release 旧上游，所有 createSession 分支必须立即 create+bind。abort handler 只发 signal，goal evaluate 用独立且与 run 联动的 controller，用户入队即可只取消 evaluation；干净 abort 只发 `abort.completed`，收尾异常另发具体失败。generation mismatch 走不写 DB 的 abandon callback，取消旧 queue，且只有 map 仍指向旧 object 才删除。每个 SSE frame/usage emit 前都要重验 generation，避免旧 stream 泄漏到同 ID replacement room；goal continuation、`/plan`、`/goal` 与用户请求进入同一 FIFO，命令 lookup 持有 exact reservation 到 hidden run 原子接管。pre-admission 失败必须用带 `queue_id` 的 requester-scoped `run.rejected`，不能用 room terminal 误伤 sibling；identity/setup/finalization 抛错时可见失败、释放 exact run 并继续最新 queue。Git 根解析的 deadline 不能降级成普通“非 Git”结果，否则最后一个 timer tick 会再启动 filesystem fallback 并突破预期 root-I/O 次数；必须显式传播 deadline sentinel。
