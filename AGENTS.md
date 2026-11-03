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

- This repo is part of sunke's agent-OS. Agents NEVER run git directly here — use `bun ~/.claude/LIFEOS/TOOLS/.ftask-runtime/current/ftask.ts`.
- Base branch: `main`. WORKTREE MODE: the main checkout stays PERMANENTLY on `main` as the stable main workspace; NEVER switch its branch or write to it. `ftask new <slug>` gives each task its own worktree at `hermes-web-ui.tasks/<slug>`; do ALL work there. Parallel agents = parallel worktrees, zero contention.
- Ship semantics: sunke's explicit `ftask ship` authorization is the production decision; green gates complete merge, push, cleanup, and finalization in that command. `postship` is optional health monitoring or legacy recovery, not another approval.
- Test gate: `ftask ship` runs valid SPEC-targeted paths locally with `bun run test` (auto-detected); required CI owns every full suite. Missing/stale/drifted CI or invalid targets BLOCK merge — never fall back to a local full suite.
- Code questions (where is X / who calls X / what breaks if I change X): this repo has a `.codegraph/` index — use the `codegraph_*` MCP tools (explore/callers/callees/impact) FIRST instead of grep/Read sweeps; cross-repo queries take a `projectPath` arg. Human-readable architecture map: vault `AgentOS/<repo>/GRAPH.md`.
- When you fix a bug found while troubleshooting (a 排障), add a regression test that FAILS without the fix BEFORE `ftask ship`, and record the root cause as one line under "Known gotchas" below.
- Global protocol: `~/.claude/CLAUDE.md` (Claude), `~/.codex/AGENTS.md` (Codex), and `~/.grok/AGENTS.md` (Grok) — "AGENT-OS" section. User cheatsheet: `~/code/AGENT-OS.md`.

## Known gotchas
- 2026-06-23：WebUI chat-plane 上传图片会落在 routed profile 的 `workspace/uploads`；Run Broker `content` 不能把 ContentBlock 直接 JSON.stringify，否则 multitenancy AIAgent 只会看到普通 JSON 文本并让工具去错误目录按 basename 搜图。broker 当前用户消息必须提供 `/workspace/uploads/...` 语义的工具路径。
- 2026-08-02：Skills 页的 profile-local 导入不能复用“宿主级操作仅 super-admin”显示条件；飞书 server-session 没有本地 JWT，导入按钮需对已认证页面可见，并由 chat-plane 请求白名单与 `requestProfileDir()` 在服务端约束到当前 profile。外部目录管理仍只给 super-admin。
<!-- /ftask:managed -->

## Local known gotchas

- 2026-09-21: 初始滚动恢复不能用 8 秒定时器清 pending；resume 的 15 秒超时之后仍可能成功 HTTP hydration，应依据恢复成功或加载结束清理。
- 2026-09-21: i18n 的空 English 降级字典也会出现在 availableLocales；仅成功请求的 locale 才能记入 loaded 缓存，否则网络恢复后无法重试。

- 2026-09-01: `scripts/run-tests.mjs` 里，**带 filter 的 CI 调用同样要走 cap + 隔离**，别再让 filter 直接 `return null` 走原参数直通 —— tiered pipeline 之后 `.gitlab-ci.yml` 的 lane 自己就是定向调用（`npm test -- tests/client|server|desktop`），直通等于整套 CI 裸并发跑，把 vitest 的 worker RPC 压到 `Timeout calling "onTaskUpdate"`：用例全过却 exit 1（pipeline 543253，1931 passed / exit 1）。两条配套约束：①cap 前要清掉 caller 的**所有**并发写法（`--min/maxWorkers` 两种拼写 + `--poolOptions.<pool>.max*/min*`，`--poolOptions` 与 `--pool-options` 两种前缀都收），pool 那组优先级高于 `--maxWorkers`，漏剥会**静默**盖掉 cap；②filter 只命中被隔离的 `workspace-diff-tracker.test.ts` 时，common 阶段排掉它就一个文件不剩，vitest 会以 `No test files found` 退 1，所以有 filter 时 common 带 `--passWithNoTests`（isolated 阶段一定跑到那个文件，不会整轮空过）。本地（无 CI）定向调用仍然直通，不要改。
- 2026-08-30: CI test wrappers must use Vitest's own CLI parser to distinguish positional filters from option values. Hand-rolled “first non-dash token” checks misclassify both substring filters and values such as `--exclude workspace-diff`; split phases must also give coverage/reporter output separate artifact paths instead of silently dropping or overwriting them.
- 2026-08-14: 技能相关写操作的软链守卫 `refuseSymlinkedSkillsPath()` 只 lstat 目录是不够的 —— node 的 `writeFile`/`copyFile` 跟随软链，叶子文件（`.usage.json`、`config.yaml`、以及 SafeFileStore 的 `*.bak` 备份目的地）都会被穿过去改写（已实测复现）。且 lstat 与写入之间存在时间差，租户 agent 可并发改自己的 profile，不是纯理论风险。根治方向是在 SafeFileStore 层集中做「临时文件 + 原子 rename」并对读取用 O_NOFOLLOW，**不要靠继续往静态数组里加路径**。另：ZIP 导入种不下软链（解包只 writeFile，从不调 symlink）——别沿用这个错误前提。
- 2026-08-14: chat plane 权限闸 `forbiddenInChatPlane()` 必须对路径**小写归一后**再比较。`@koa/router` 的 `sensitive` 默认 false（路由匹配不区分大小写），本仓 `new Router()` 都没传 options；闸若逐字比较，`/API/HERMES/LOGS` 就绕过整张黑名单（logs/config/gateways/profiles/coding-agents/auth/*）而路由照样命中。铁律：**这道闸至少要和 router 一样宽**。别反过来给 router 开 `sensitive: true` —— 那会改路由匹配行为、可能打断既有客户端。
- 2026-07-19: Live assistant rows use temporary client IDs while hydrated rows use persisted IDs; merge the last unmatched assistant occurrence by stable `run_id` across the complete current transcript, including rows added while a refresh request is in flight, or refresh/reconnect can append the same answer twice.
- 2026-07-17: Workspace diff checkpointing runs on the shared Node server; synchronous Git/filesystem work blocks every tenant, so Git, scanning, and file reads must remain asynchronous and bounded.
- 2026-07-17: Session deletion owns messages and both workspace-change tables as one SQLite unit; independent cleanup can leave permanent patches or partial deletion after a later statement fails.
- 2026-07-18: A Socket.IO `connect_error` is retryable only while `socket.active`; replayed terminal events must not override newer authoritative resume state.
- 2026-07-18: HTTP session deletion must abandon the exact in-memory session generation before deleting its row; a follow-up browser socket abort is not a server lifecycle guarantee.
- 2026-07-18: Resolve the effective active profile before the Socket.IO reuse guard; an omitted profile argument must not reuse a socket owned by the previously selected profile.
- 2026-07-18: Every terminal `session.command`, including successful `/plan` and `/goal` results, needs one generation-bound pending ID before live emit so reconnect and per-socket ACK cannot lose it.
- 2026-08-31: A truncated workspace snapshot must not treat unknown baseline as absent. Capture path metadata before content, enumerate Git untracked files individually, and fail closed for paths beyond a truncated start scan.
