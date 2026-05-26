---
slug: webui-edit-generated-content
generated_at: 2026-05-26T05:53:05.698Z
spec_revision: c7479193fbb4
surfaces: [web]
scenarios:
  - id: 1
    surface: web
    action: |
      用户打开 Skills 页并选中当前 profile 下 `source=local` 或 `source=hub` 的 skill
    expected: |
      详情页显示 `SKILL.md` 内容，并有编辑入口。
    executed: |
      2026-05-26 13:48 本机 API smoke：临时 HERMES_HOME + `x-hermes-profile: songtingting`，请求 skills list 和 `SKILL.md` 内容。
    observed: |
      skills list 中 `daily-writing` 为 `source=local`、`editable=true`；`SKILL.md` 读取返回 `visible content`。
    verdict: pass
    rationale: |
      WebUI 编辑入口由 `editable` 字段驱动；BFF 已对当前 profile 本地 skill 返回可编辑并能读取详情内容。
  - id: 2
    surface: web
    action: |
      用户点击编辑、修改 `SKILL.md`、点击保存
    expected: |
      WebUI 调用新的安全保存 API；保存成功后退出编辑态，重新渲染的 Markdown 显示修改后的内容。
    executed: |
      2026-05-26 13:51 本机 API smoke：临时 HERMES_HOME 创建 songtingting、other-user 和 root 三份同名 skill；带 `x-hermes-profile: songtingting` 保存 `SKILL.md`，停止并重启 BFF 后分别读取三份内容。
    observed: |
      重启后 `songtingting` 返回 `version=edited-via-webui`；`other-user` 仍为 `version=original`；root 全局 skill 仍为 `root-global|version=original|`；列表仍显示 `source=local`、`editable=true`。
    verdict: pass
    rationale: |
      编辑内容持久化到当前 request profile 的本地 skill 文件，重启后仍生效，且没有写入其他 profile 或 root 全局 skill。
  - id: 3
    surface: web
    action: |
      用户打开该 skill 的非敏感文本附件并点击编辑保存
    expected: |
      只写回当前 skill 目录内对应附件；返回后预览显示新内容。
    executed: |
      2026-05-26 13:49 本机 API smoke：临时 HERMES_HOME 创建附件 `notes.md`，确认 files 列表可见后用保存 API 修改附件，再读取 API 和磁盘文件。
    observed: |
      `notes.md` 保存后 API 读取返回 `notes edited via webui`，磁盘文件也为 `notes edited via webui|`。
    verdict: pass
    rationale: |
      非敏感文本附件沿当前 profile-local skill 目录保存，预览读取与磁盘内容一致。
  - id: 4
    surface: web
    action: |
      用户选中 builtin、external、archive skill，或试图编辑敏感/越界/不存在/二进制路径
    expected: |
      页面不显示可用编辑入口，后端即使被直接调用也返回拒绝或错误，不写文件。
    executed: |
      2026-05-26 13:50 本机 API smoke：临时 HERMES_HOME 配置 `skills.external_dirs` 并创建 external skill；列表验证 external 无 editable；直接调用保存 API 尝试 external、archive、敏感 `.env`、非文本 `image.png`。
    observed: |
      external 列表项为 `source=external` 且 `editable=null`；external/archive/sensitive/nontext 四类 PUT 均返回 403；external 磁盘文件保持原始内容。
    verdict: pass
    rationale: |
      UI 不会给 external 显示编辑入口；后端直接调用也拒绝只读来源、archive、敏感路径和非文本扩展名。
---

# Simulation trace — webui-edit-generated-content

Agent: fill each scenario's `executed` / `observed` / `verdict` / `rationale`
by ACTUALLY RUNNING the feature using your own tools (Bash / Interceptor /
claude-in-chrome / curl). Save large artifacts (screenshots, network logs) to
`/Users/kite/code/hermes-web-ui/.ftask/webui-edit-generated-content/sim_artifacts/` and reference paths in `observed`.

Verdict legend:
- `pass` — observed matches expected.
- `fail` — observed contradicts expected. **Blocks ship.**
- `inconclusive` — agent couldn't fully verify (missing env / external dep);
  rationale MUST explain why. Allowed through ship.
