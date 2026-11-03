---
date: 2026-07-24
commit: pending
feature: Expert release badges and broker run identity
impact: Expert cards expose the installed SkillHub release, while one broker run reconciles to one assistant message after resume or refresh.
---

# Expert version badge and broker run identity

Status: local candidate; production unchanged.

- Expert cards and details render the optional upstream SkillHub release as
  `vX.Y.Z`. A successful install from the last seven days also renders `New`;
  legacy experts render neither value.
- Run Broker frames that omit `run_id` are stamped with the existing trusted
  WebUI run marker before they are emitted. The live assistant bubble and its
  persisted resume/refresh row therefore share one run identity and reconcile
  to one message.
- No content-based deduplication was added: identical text from distinct runs
  remains distinct.

Production evidence for the reported session showed one assistant row in
SQLite but two browser nodes (`message-2` and `message-mryvauzet8frqs`), proving
the symptom was client reconciliation rather than a second model execution.
