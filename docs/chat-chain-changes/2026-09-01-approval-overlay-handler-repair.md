---
date: 2026-09-01
pr: pending
feature: Chat approval overlay event handlers
impact: Tool-approval prompts, approval resolutions, workflow stages and server-generated session titles now reach the chat UI for every session; previously they were silently dropped for any session opened through switchSession.
---

`resumeServerWorkingRun` registers the session's event handler set, and
`startRunViaSocket` reuses whatever set is already registered for that session
(`api/hermes/chat.ts`). Because `switchSession` registers first, its handler set
is the one that survives — and it was missing `onApprovalRequested`,
`onApprovalResolved`, `onWorkflowStage` and `onSessionTitleUpdated`, so those
four socket events never reached `handleEvent`, which already implements them.
The "Review command before running" overlay therefore never appeared and
approvals could not be answered from the UI.

Fix: register those four callbacks alongside the existing ones. No behavior
change for events that already worked. Covered by
`tests/e2e/chat-streaming.spec.ts` "renders tool trace and sends explicit
approval decisions over the chat-run socket", which failed on main before this
change.
