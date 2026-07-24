---
date: 2026-07-24
pr: pending
feature: Cloud Agent session stability
impact: Keeps abort, loading, resume, and bottom-follow state attached to the cloud chat session and request that owns it.
---

# Cloud Agent session stability

Status: local ftask candidate only; not merged or deployed.

## Scope

This change keeps cloud WebUI session state attached to the session and request
that owns it. It does not add Desktop Browser behavior, change the Run Broker
transport, or alter Feishu/profile authorization.

## Changes

- Abort lifecycle state is keyed by runtime, profile, and session. Background
  or late old-profile socket events no longer change the active conversation's
  Stop indicator, and starting a run only clears its exact owner's state.
- Full session-list loads and metadata refreshes share one request epoch, so an
  older profile/route response cannot overwrite a newer route load.
- Session resume requests retain the existing global loading epoch and add a
  per-session latest-request fence. This rejects A1 after A→B→A while preserving
  the existing exact stream-owner cleanup for a response that has not been
  superseded by another request for A.
- Paginated hydration and workspace-diff restoration verify both the captured
  session epoch and the exact `Session` object before writing after an await.
  Workspace-diff refreshes also keep the latest successful same-session result,
  so an older request cannot finish last and overwrite it.
- The message list observes rendered content height as well as its viewport.
  Delayed content growth keeps a bottom-following user pinned, while a user who
  scrolled upward remains detached.

## Verification

- `tests/client/chat-store-compression-state.test.ts`
- `tests/client/chat-store-user-mode.test.ts`
- `tests/client/virtual-message-list-scroll.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run harness:check`
- `tests/e2e/chat-session-multitab.spec.ts` (isolated mocked browser)

The focused run passed 96 tests. The full run passed 322 files / 2676 tests
with 2 skipped; Chromium browser QA passed 3/3. Production was not contacted
or changed.
