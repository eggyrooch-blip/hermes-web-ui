# 2026-08-31 Group-chat owner boundary

This candidate replaces profile-overlap room discovery with a trusted numeric WebUI owner/member boundary.
Room creation and cloning persist `ownerAuthUserId`; the owner is also the first member. Explicit POST invite joins add the
authenticated user atomically. Detail/list/socket join fail closed for outsiders before messages, agents, or
runtime state are exposed. Members may read and speak; only the owner (or a super admin for owned rooms) may
change invites, agents, context, compression, approvals, interrupts, or room lifecycle. Responses never expose
the room-owner field and expose invite codes only to managers.

Browser Socket.IO ignores client-supplied user ids, binds to the authenticated server principal, and keeps one
online member across multiple sockets until the last disconnect. Agent-only stream/context/approval events are
rejected from human sockets. Agent profiles are checked against the owner's current active account before
startup restore and immediately before mention dispatch; revoked profiles are disconnected instead of used.

Legacy rooms have no deterministic owner. They are not backfilled or guessed: normal users cannot read them,
agents are not restored, and super admins may inspect redacted detail but cannot mutate them.

Verification: the four focused group-chat files pass 36 tests, including the synthetic `self=2, cross=0,
ambiguous=0` canary, forged auth id, outsider socket, owner/member routes, profile revocation, and two-socket
disconnect behavior. Schema migration, API method, and chat-plane classification regressions also pass. Client
and server TypeScript checks pass.

Released in MR !53 / pipeline 542939 as WebUI
`d0d64957ea0f17b7784b75fde6d3bbc0e92482d1` under `release-20260831-03`; multitenancy remained pinned at
`1112767bcb7d41014f0bdc3cddf105d18473b267`. The executor passed 12/12 probes and the rollback package records
SUCCESS. The exact production release directory passed the same four files (36 tests). The nullable owner
column exists in production; all six legacy rooms remain ownerless and no room, member, message, or agent row
was reassigned. No production room or employee message was created for verification.
