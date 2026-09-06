---
date: 2026-09-03
pr: "!72"
release: release-20260903-04
feature: Expert selection stability
impact: A pre-run expert selection is persisted before refresh, model changes, or dispatch and remains owner/profile bound.
---

The session expert endpoint validates the routed actor against that profile's live catalog and fails closed on
catalog or persistence errors. Explicit None remains available before the first message; expert and execution engine
remain immutable after messages.

The change shipped in MR !72 at merge commit `d5da180ba6dd7337aab6dd73c61b7bfe9ae21a0c` and is live in
`release-20260903-04`. The release and independent probes passed 12/12. A production logged-in session retained
the same expert through a 61-second wait, reload, GPT-5.4 model switch, and a real run. Explicit None, New Chat,
and profile switching retained their existing clearing boundaries. The read-only two-identity canary reported
self=2, cross=0, ambiguity=0; session-mirror malformed identity rows and post-release related errors were zero.
