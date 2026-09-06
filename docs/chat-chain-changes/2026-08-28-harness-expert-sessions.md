---
date: 2026-08-28
pr: pending
feature: Expert Harness sessions
impact: Expert details can create a session permanently bound to the local Harness runtime; chat restores its workflow and approval state while ordinary Hermes sessions keep the existing path.
---

The production pilot additionally gates both catalog visibility and session binding by the same finite,
server-side profile allowlist. A globally enabled flag without an allowlisted trusted profile remains unavailable.

The server, not the browser, derives the Harness broker header from the persisted
session. Harness runs use the multitenancy-owned isolated workflow clone, so the
WebUI workspace diff scanner is deliberately skipped for those sessions.

Native Harness heartbeat, workflow evidence, Gate checklist/decision comments, and credential WAITING/
resume events use the existing chat status, approval, and re-auth seams. The browser acceptance maps raw
MT frames and verifies that all four states survive the same session lifecycle.

Post-merge review hardening makes the server capability flag authoritative for every entry path, restores
pending workflow state from MT after a BFF restart, keeps Gate cards until server acknowledgement, and
requires an explicit live-authenticated connector before credential resume. Ordinary terminal approvals
in the same session are not replaced by the Harness snapshot.

The follow-up review removes WebUI's duplicate workflow hash: snapshot restore asks MT to resolve the
trusted session. A successful Harness credential resume acknowledges the durable workflow and settles the
temporary client attachment; ordinary connector auth continues to replay its parked request. The BFF selects
that Harness path only from the persisted session engine, never from a client workflow ID. Profile-local Lark
authorization status requires the exact trusted actor and never scans another actor's UAT files. Approval
failure fallback text is rendered through the existing localized common error key.
If Harness credential resume fails, the repeated `auth.required` settles only the temporary client attachment
and restores the same card as retryable, so the session cannot remain falsely live or require a reload.
The repeated card includes a fixed server-safe failure reason. The same settlement boundary marks the old
attachment closed before unregistering it, so a late completion callback cannot clear an immediate retry.
