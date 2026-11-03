---
date: 2026-08-28
pr: 43
feature: 全租户飞书链接预览
impact: 输入框和已发送消息为合法飞书或 Lark 链接展示可信预览，同时保留原始消息 URL 数据。
---

# 全租户飞书链接预览（本地候选）

- ChatInput 从粘贴文本中识别合法 `feishu.cn` / `larksuite.com` 根域和子域，伪造后缀不触发。
- 预览同时出现在输入框与已发送用户消息中；解析失败降级为通用飞书 chip，不展示原始 `fetch failed`；消息正文仍保留原 URL，但界面不重复展示裸链接。
- `/api/hermes/link-previews` 只使用可信 WebUI user 的 openid/profile，并向 Run Broker 转发；跨 profile 在外呼前 403。
- Run Broker 对开放平台公开 `/document/...` 页面返回匿名提取的网页标题与“开放平台文档”；精确 host/path 白名单、2 秒、1 MB、不跟随重定向，其他租户 HTML 仍不抓取。
- 本机聚焦 40/40、client typecheck 与 production build 通过；新增用例确认开放平台公开文档标题进入输入 chip；同 profile/URL 成功结果会复用，瞬时只读失败短重试一次。隔离候选 `8748/8877` 已真实显示 Base 消息资源卡与输入框紧凑标题条；没有发布或员工可见变化。
- 候选 8877 必须与 8748 使用同一 master key，并保留 `HERMES_HOME=/Users/dev/.hermes`、`HERMES_USE_SANDBOX=1`；恢复这三个启动约束后，actor-bound Base preview 为 HTTP 200/resolved、标题“你的月度数据大屏 Copy”，对话为 HTTP 200/done/0 error/OK。
