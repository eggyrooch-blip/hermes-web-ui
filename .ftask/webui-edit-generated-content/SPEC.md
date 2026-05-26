# SPEC — webui-edit-generated-content

> The agent fills this BY INTERVIEWING sunke in plain language, reads it back,
> and only runs `ftask spec webui-edit-generated-content --approve` once he says OK. No code
> until status is approved. This is the non-coder's real review gate.
>
> The 'How will I know it works' section is the Karpathy gate — `--approve`
> parses it and refuses to flip status if Surface / Acceptance scenarios /
> Regression guards are empty or placeholder. Filling this section honestly
> is what lets the LLM LOOP toward done instead of guessing.

## What sunke wants (plain language)
- songtingting 原话：“CoCo，我在爱马仕生成的技能怎么不能编辑啊”。
- 用户反馈对象是 WebUI 的“技能（skill）”详情页：agent/SkillHub/本地生成到当前 profile 的 skill 现在只能 Markdown 渲染查看，不能在页面里改 `SKILL.md` 或 skill 附件文本。
- 已检索 upstream `EKKOLearnAI/hermes-web-ui`：upstream Skills 详情页只有 `fetchSkillContent` + `MarkdownRenderer` 只读展示；server routes 只有 list/read/toggle/pin/install，没有 WebUI 写 skill 文件 API。`total_skill_edits` 只是统计 agent 的 `skill_manage` 工具动作，不是可编辑 UI。
- 本任务在我们的 WebUI 中补一个安全的 skill 编辑薄片：当前 profile 下可写的本地/Hub skill，允许在 Skills 详情页切换到编辑模式，编辑 `SKILL.md` 或非敏感文本附件并保存。

## Out of scope (what we will NOT do)
- 不修改历史聊天消息正文，不做“把 assistant 气泡内容直接变成可编辑富文本”的功能。
- 不做 skill 创建、删除、重命名、目录管理或 SkillHub 上游回写；只编辑已安装到当前 profile 的文本文件。
- 不允许编辑 builtin bundled skill、external skill、archive skill、图片/二进制/大文件、敏感文件名、外部 URL、绝对路径或不在当前 profile `skills/` 安全边界内的文件。
- 不绕过现有 chat-plane、profile ownership、request profile 解析和路径校验；不新增跨 profile skill 访问能力。
- 不发布生产；本任务只完成本地代码、测试、review/ship 前准备。

## How will I know it works (Karpathy gate — required to approve)

### Surface (which user-facing surface — pick one or more)
- [x] web — Interceptor / agent-browser harness
- [ ] cli — fresh shell + actual command
- [ ] api — curl against real endpoint
- [ ] lib — 5-line consumer script
- [ ] none — pure doc/config change (no simulate step)

### Acceptance scenarios (each = observable user action + observable outcome)
Format: 'user does X → observe Y' (use → to separate action from outcome)
- 用户打开 Skills 页并选中当前 profile 下 `source=local` 或 `source=hub` 的 skill → 详情页显示 `SKILL.md` 内容，并有编辑入口。
- 用户点击编辑、修改 `SKILL.md`、点击保存 → WebUI 调用新的安全保存 API；保存成功后退出编辑态，重新渲染的 Markdown 显示修改后的内容。
- 用户打开该 skill 的非敏感文本附件并点击编辑保存 → 只写回当前 skill 目录内对应附件；返回后预览显示新内容。
- 用户选中 builtin、external、archive skill，或试图编辑敏感/越界/不存在/二进制路径 → 页面不显示可用编辑入口，后端即使被直接调用也返回拒绝或错误，不写文件。

### Regression guards (what must NOT break — list things to recheck)
- Skills 列表、source 标记、enable/disable、pin、SkillHub install、credential requirement 展示不退化。
- MarkdownRenderer 仍只负责安全渲染；编辑模式不能引入 XSS 或原始 HTML 注入。
- chat-plane skill 读写都只落到当前 request profile；root Hermes skills、其他用户 profile、external_dirs 不可被写。
- route 顺序不能破坏 `/api/hermes/skills/skillhub/install`、toggle/pin、files、catch-all read。
- 移动端/窄屏下 Skills 详情页编辑按钮、编辑框、保存/取消不遮挡主要内容。
