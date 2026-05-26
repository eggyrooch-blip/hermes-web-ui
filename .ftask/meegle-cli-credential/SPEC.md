# SPEC — meegle-cli-credential

> The agent fills this BY INTERVIEWING sunke in plain language, reads it back,
> and only runs `ftask spec meegle-cli-credential --approve` once he says OK. No code
> until status is approved. This is the non-coder's real review gate.
>
> The 'How will I know it works' section is the Karpathy gate — `--approve`
> parses it and refuses to flip status if Surface / Acceptance scenarios /
> Regression guards are empty or placeholder. Filling this section honestly
> is what lets the LLM LOOP toward done instead of guessing.

## What sunke wants (plain language)
- 飞书项目面向普通用户不要暴露 MCP 这条路线；用户不知道 MCP 是什么，也不知道怎么触发，产品上应该只有一个“飞书项目”能力入口。
- GitHub `main` 已经包含 Feishu Project MCP 的两个提交，需要在 feature 分支里用 revert 清掉这条产品面，而不是继续在 MCP 上叠加。
- 新路线改为 Meegle CLI（飞书项目 CLI）+ 官方 meegle skill：凭证页负责 profile-local 登录状态和授权入口，skill 负责让模型稳定命中“飞书项目/工作项/需求/排期/视图”等自然语言场景。
- 最终用户只看到“飞书项目”，不知道也不需要理解 MCP/CLI 的技术差异。

## Out of scope (what we will NOT do)
- 不重写 GitHub main 历史，不 force push；MCP 提交已在 origin/main 上，只能用 revert 提交清理。
- 不继续合入 `mcp-oauth-auto-close` 那条 hermes-agent 分支。
- 不把 MCP token 复用给 Meegle CLI；Meegle CLI 走自己的 device-code / auth store。
- 不在凭证状态 GET 请求里静默删除用户磁盘上的旧 MCP token/config。旧 MCP 本地材料会被新代码忽略；如需清理本机旧 profile，可单独执行一次明确的清理动作。
- 不做生产发布；本任务先完成 main 代码层替换和本机验证。

## How will I know it works (Karpathy gate — required to approve)

### Surface (which user-facing surface — pick one or more)
- [x] web — Interceptor / agent-browser harness
- [ ] cli — fresh shell + actual command
- [ ] api — curl against real endpoint
- [x] lib — 5-line consumer script
- [ ] none — pure doc/config change (no simulate step)

### Acceptance scenarios (each = observable user action + observable outcome)
Format: 'user does X → observe Y' (use → to separate action from outcome)
- 用户打开 WebUI「凭证」页 → 看到“飞书项目”凭证卡，不再看到“飞书项目 MCP”或任何 MCP 文案。
- 用户点击“飞书项目”授权 → WebUI 启动 Meegle CLI device-code 登录流程，返回可打开的授权 URL；不会写入 `mcp_servers.FeishuProjectMcp`。
- profile 已完成 Meegle CLI 登录 → 凭证页显示飞书项目已认证，但响应不包含 access token / refresh token / keychain 内容。
- 用户自然语言提到飞书项目、工作项、需求、任务、缺陷、排期、视图或 project.feishu.cn URL → profile 中有 bundled `meegle` skill guidance，模型能按官方 SOP 优先使用 `meegle` CLI。

### Regression guards (what must NOT break — list things to recheck)
- Lark-cli、kep-cli、Keep-record、GitLab 凭证卡仍正常显示和分组。
- 凭证页长 required skill 列表仍不会撑高同排卡片。
- skill credential API 仍受 WebUI auth/request profile 保护，不能暴露 raw secret。
- WebUI build 和相关 server/client credential tests 通过。
