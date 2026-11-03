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
- files store 的 entries、preview、editor 请求使用 request epoch 丢弃 scope 切换后的过期响应；编辑缓冲按 scope 隔离，不同 session/profile 可独立保留未保存内容。删除或改名会跨 scope 失效所有受影响缓冲，防止旧编辑器稍后保存时复活文件。
- tab 使用 `tablist/tab/tabpanel` 语义、roving tabindex、方向键与 Home/End；关闭、浏览和新增入口均有 accessible label。
- 右栏 header 自身增加 `Collapse` 入口，普通用户即使没有 super-admin 的文件/终端开关也能关闭整个产物栏；关闭只隐藏已挂载实例，重新点产物卡会恢复原 tab。
- 聊天 workspace 文件卡的 preview 白名单补齐 PNG/JPG/JPEG/GIF/SVG/WebP/BMP/ICO，复用 files store 与 `FilePreview` 已有图片能力；ZIP 等不支持格式仍直接下载。
- 非 workspace 图片卡保持下载，不会作为文本预览读取二进制；独立文件页保留双击编辑，聊天 secondary browser 的双击只打开预览 tab。
- preview 请求开始时先清除旧内容并提升请求 epoch；每个 session/runtime/profile 的 workspace 记忆最多保留 24 个，避免长时间使用时无界增长。
- 安全边界保持不变：ArtifactBrowser 可见地址不展示 bearer，iframe sandbox 不放宽，浏览器文件访问继续经过既有 BFF、chat-plane access control 和 profile workspace containment。

## 测试状态

最终门禁：原始 focused owner/editor 回归 12 files / 91 tests 通过，跟进 close/workspace 39 passed、图片格式卡 8/8（相关 focused 51 passed）；异模型 review 修复后的 focused 71/71 通过，并新增断言覆盖跨 scope 删除/改名失效、独立编辑缓冲、非 workspace GIF、双击编辑/预览分流。全量 `bun run test`、`npm run typecheck`、i18n、`npm run harness:check`、`npm run build` 与 `git diff --check` 通过。Playwright `artifact-sidebar-workspace.spec.ts` 6/6 通过且 `unexpectedRequests=[]`，覆盖普通 admin 没有管理员开关时仍能关闭/重开产物栏。Claude Opus 4.8 高强度正式异模型复审逐项检查 7 个 finding，最终 `VERDICT: PASS`、`QA_VERDICT: PASS`。

真实 Chrome 通过 worktree Vite `localhost:47488` 代理本机既有 `:8648` 后端，在真实 `feishu_g41a5b5g` 会话点击 `a.txt` 卡片，确认右栏直接出现并选中 `a.txt` tab、diff/文件预览可见，文件夹与 `+` 均进入 secondary browser，720px 下 panel bounds 为 `0..720` 且页面横向 overflow 为 0。跟进验收由 Hermes 真实生成静态 HTML、Markdown 与三帧 GIF：HTML sandbox/无 token 地址、Markdown 标题/表格/引用/代码块、GIF 400×220 动画均在右栏显示；GIF 相隔 800ms 截图从蓝帧变为红帧，文件检查为 3 帧、loop=0、700ms/帧。普通用户真实点 `Collapse` 后 panel `1→0`，重点卡片后 `0→1` 并恢复 tab。截图落在 `.ftask/artifact-sidebar-workspace/screenshots/`。当前改动仍仅在 `artifact-sidebar-workspace` 本机 worktree，尚未合入 main、push 或发布生产。
