---
date: 2026-09-21
pr: pending
feature: Session viewport restoration during delayed hydration
impact: Returning to a profile preserves its saved viewport while resume and HTTP fallback are still loading, including waits longer than eight seconds.
---

MessageList releases pending restoration after restoration succeeds, loading settles,
the user scrolls away or jumps to the bottom, or the active session is left.
Regression coverage mounts MessageList and VirtualMessageList with a 16-second
hydration delay and verifies the saved scrollTop of 500.
