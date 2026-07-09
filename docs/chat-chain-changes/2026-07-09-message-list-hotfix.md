# 2026-07-09 — message list hydration hotfix

## Summary

Local main could render an empty chat transcript after switching sessions even when the HTTP session detail endpoint returned messages. The client chat store relied on Socket.IO resume as the only initial hydration path; if the resume payload had no messages for a non-empty session, the UI stayed blank.

## Change

- Added a focused regression in `tests/client/chat-store-user-mode.test.ts`.
- Added a fallback in `useChatStore.switchSession()`: when resume returns no messages but the session metadata says messages exist, fetch the existing paginated messages endpoint and hydrate the transcript.
- Kept inline workspace path chip and workspace diff rendering unchanged.

## Verification

- Focused chat store tests passed.
- Inline workspace file-card and diff-badge tests passed.
- Typecheck and production build passed.
