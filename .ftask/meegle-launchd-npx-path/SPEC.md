# SPEC — meegle-launchd-npx-path

> The agent fills this BY INTERVIEWING sunke in plain language, reads it back,
> and only runs `ftask spec meegle-launchd-npx-path --approve` once he says OK. No code
> until status is approved. This is the non-coder's real review gate.
>
> The 'How will I know it works' section is the Karpathy gate — `--approve`
> parses it and refuses to flip status if Surface / Acceptance scenarios /
> Regression guards are empty or placeholder. Filling this section honestly
> is what lets the LLM LOOP toward done instead of guessing.

## What sunke wants (plain language)
- 本机 WebUI 由 launchd 启动时 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，看不到终端里的 `/opt/homebrew/bin/npx`，导致飞书项目卡片仍显示“未安装”。
- 修复后，即使 launchd PATH 很窄，只要机器上常见位置存在 `npx` 或 `meegle`，飞书项目卡片也应显示可授权，而不是未安装。
- 点击授权时仍走官方 `@lark-project/meegle` device-code 流程；状态页不能主动执行 npx 触发 npm 下载。

## Out of scope (what we will NOT do)
- 不恢复 MCP 路线。
- 不要求用户手工修改 launchd plist 或 shell PATH。
- 不在状态刷新时下载 npm 包。
- 不做生产发布；只修 main 与本机 8648。

## How will I know it works (Karpathy gate — required to approve)

### Surface (which user-facing surface — pick one or more)
- [ ] web — Interceptor / agent-browser harness
- [x] cli — fresh shell + actual command
- [ ] api — curl against real endpoint
- [x] lib — 5-line consumer script
- [ ] none — pure doc/config change (no simulate step)

### Acceptance scenarios (each = observable user action + observable outcome)
Format: 'user does X → observe Y' (use → to separate action from outcome)
- WebUI server runs with PATH `/usr/bin:/bin:/usr/sbin:/sbin`, while `npx` exists at `/opt/homebrew/bin/npx` → 飞书项目 credential status reports installed/needs_auth, not missing.
- User clicks Feishu Project authorization under narrow PATH → start flow resolves `/opt/homebrew/bin/npx -y @lark-project/meegle ...` and returns the device-code URL.
- Machine has neither PATH nor common-bin `meegle/npx` → card still reports missing with readable error on start.

### Regression guards (what must NOT break — list things to recheck)
- Explicit `HERMES_MEEGLE_BIN` remains highest priority.
- PATH `meegle` remains preferred over npx fallback.
- Status check still does not execute npx.
- `kep/lark` skills still do not appear under Feishu Project `required_by`.
- No access/refresh token material appears in credential responses.
