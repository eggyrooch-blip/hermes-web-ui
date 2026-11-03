---
date: 2026-08-18
pr: local-awaiting-verify
feature: Digital-employee work progress line on the chat turn
impact: Each turn shows one deterministic work-progress line derived from facts the turn already carries (tool calls, terminal state, abort/timeout), so a user can see what the employee is doing without opening the technical panel. No new events, storage, or model calls.
---


> [!danger] 已撤回（2026-08-18 当天）
> 这条链路在 `webui-d67f1215` 上生产后被 sunke 判定不满意（终态卡片跑完不消失、零工具调用时是空壳），
> 由 `webui-revert-work-record` 整条反向应用撤回。聊天区指示器已回到 `4078418b^` 的 `Thinking` 形态。
> 本文件保留作为决策留痕，**描述的行为已不在代码中**。

# Work progress on the chat turn

`MessageList.vue` derives a single progress line per turn in a fixed priority
order from existing turn facts only — running tool calls, terminal status,
abort/timeout — and renders it next to the streaming indicator. Prior-turn tool
traces stay visible; only the current turn's transient reasoning-only bubble is
hidden while it streams.

Nothing is persisted and no summary is generated: the line is a pure function of
what the turn already contains, so a reload reproduces it exactly.

Test coverage: `tests/client/message-list-streaming.test.ts` (deterministic
derivation order, terminal-only records, abort-timeout visibility, repeated
broker tool ids rendered once, prior-turn traces preserved).
