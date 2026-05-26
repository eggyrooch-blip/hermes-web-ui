# SPEC — meegle-credential-card-fix

> The agent fills this BY INTERVIEWING sunke in plain language, reads it back,
> and only runs `ftask spec meegle-credential-card-fix --approve` once he says OK. No code
> until status is approved. This is the non-coder's real review gate.
>
> The 'How will I know it works' section is the Karpathy gate — `--approve`
> parses it and refuses to flip status if Surface / Acceptance scenarios /
> Regression guards are empty or placeholder. Filling this section honestly
> is what lets the LLM LOOP toward done instead of guessing.

## What sunke wants (plain language)
- WebUI 凭证页的“飞书项目”卡片不能显示成“未安装”，本机没有全局 `meegle` 时也应能通过官方 npm 包路径授权/检查。
- “飞书项目”卡片的关联技能只能是官方 `meegle`/飞书项目相关 skill，不能把 `kep-prd-analysis`、`lark-base`、`lark-contact` 等 Keep/Lark 通用技能误挂上去。
- 普通用户仍只看到“飞书项目”，不要重新暴露 MCP 或 CLI 细节。

## Out of scope (what we will NOT do)
- 不把旧 MCP 路线恢复回来。
- 不自动删除用户磁盘上已有的旧 MCP config/token。
- 不做生产发布；本轮只修 main/本机 WebUI。
- 不把所有 Lark/Keep 技能的 credential 分类重写，只收紧飞书项目识别和 Meegle 可用性判断。

## How will I know it works (Karpathy gate — required to approve)

### Surface (which user-facing surface — pick one or more)
- [x] web — Interceptor / agent-browser harness
- [x] api — curl against real endpoint
- [x] lib — 5-line consumer script
- [ ] none — pure doc/config change (no simulate step)

### Acceptance scenarios (each = observable user action + observable outcome)
Format: 'user does X → observe Y' (use → to separate action from outcome)
- user opens WebUI `/hermes/credentials` with no global `meegle` binary but `npx` available → “飞书项目” card is not “未安装”; action button can start the official Meegle device-code flow through the npm package path.
- user opens WebUI `/hermes/credentials` with mixed Keep/Lark skills installed → “飞书项目” card required_by only includes the bundled `meegle` skill or true Meegle/Feishu Project skills, not `kep-*` or `lark-*` skills.
- user checks credentials API response → no `MCP` user-facing title/detail and no access/refresh token material.

### Regression guards (what must NOT break — list things to recheck)
- Lark-cli / kep-cli / Keep-record / GitLab credential cards still classify their own skills.
- `meegle auth status --format json` with a configured binary still reports authenticated without leaking token material.
- Missing both global `meegle` and `npx` still returns a clear unavailable state instead of throwing.
- Credentials page layout scroll fix still prevents long required_by lists from stretching the row.
