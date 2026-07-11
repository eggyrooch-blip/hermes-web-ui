---
date: 2026-07-11
pr: pending
commit: pending
feature: Session-aware artifact sidebar workspace
impact: Chat 右侧栏收起再展开会保留当前产物，并用 session/runtime/profile 隔离的文件 tab 与 secondary file browser 取代 file-manager-first 入口。
---

## 目标

把 chat 右侧栏改成 file-first 的产物 workspace：用户从消息或产物概览打开文件后，收起再展开仍回到同一文件；不同 session、runtime mode 与 profile 各自保留 tab，上下文不互相污染。完整方案分两阶段：先修复挂载与恢复连续性，再加入接近 ChatGPT Codex 的文件 tab，并把工作空间文件管理器降为二级入口。

## 根因

旧 `ChatPanel` 在侧栏关闭时卸载 `DetailPanel`，重新打开后 `DetailPanel` 又以 `files` 为默认模式，因此用户的当前文件、preview/browser 状态和浏览上下文全部丢失，直接落入根目录文件管理器。文件预览、编辑、HTML sandbox 和 diff 能力本身已经存在，不需要另造一套内容实现。

## 实现

- `ChatPanel` 只在第一次打开工具侧栏时 lazy mount，之后以 `v-show` 隐藏，保留 `DetailPanel` 生命周期内状态。
- `DetailPanel` 用内存 map 保存 workspace；key 包含 runtime mode、active profile metadata 与 session id。无记忆时显示产物概览，有 chat 文件请求时打开或选中对应 tab。
- 顶部用可关闭的文件 tab、文件夹按钮和 `+` 入口取代四模式下拉；`FilesPanel` 仅在 secondary browser surface 打开时挂载，并按 workspace key 重挂载，选择文件后回到文件 tab。
- 内容继续复用 `FilePreview`、`ArtifactBrowser` 与 `FilesPanel`：文本/Markdown/图片/diff 走既有 preview/editor，HTML 走既有 sandboxed browser，不新增后端 API 或第二套 editor state。
- files store 的 entries、preview、editor 请求使用 request epoch 丢弃 scope 切换后的过期响应；`DetailPanel` 记录 editor owner，防止另一个 session/profile 继承仍在进行的编辑器。
- tab 使用 `tablist/tab/tabpanel` 语义、roving tabindex、方向键与 Home/End；关闭、浏览和新增入口均有 accessible label。
- 安全边界保持不变：ArtifactBrowser 可见地址不展示 bearer，iframe sandbox 不放宽，浏览器文件访问继续经过既有 BFF、chat-plane access control 和 profile workspace containment。

## 测试状态

最终门禁：focused 回归 11 files / 86 tests 通过，`npm run typecheck` 与 i18n 检查通过；全量 `bun run test` 为 316 files / 2448 passed / 2 skipped；`npm run harness:check` 与 `npm run build` 通过。Playwright `artifact-sidebar-workspace.spec.ts` 3/3 通过且 `unexpectedRequests=[]`，覆盖 A/B 会话恢复、收起/展开、文件夹/`+` 二级入口和 720px 窄屏。

真实 Chrome 通过 worktree Vite `localhost:47488` 代理本机既有 `:8648` 后端，在真实 `feishu_g41a5b5g` 会话点击 `a.txt` 卡片，确认右栏直接出现并选中 `a.txt` tab、diff/文件预览可见，文件夹与 `+` 均进入 secondary browser，720px 下 panel bounds 为 `0..720` 且页面横向 overflow 为 0；桌面和窄屏截图落在 `.ftask/artifact-sidebar-workspace/screenshots/`。当前改动仍仅在 `artifact-sidebar-workspace` 本机 worktree，尚未合入 main、push 或发布生产。
