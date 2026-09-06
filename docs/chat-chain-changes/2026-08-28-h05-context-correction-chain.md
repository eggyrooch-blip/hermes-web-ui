---
date: 2026-08-28
pr: pending
feature: H-05 correction continuity
impact: Full and incremental context summaries preserve field-level corrections, backing values, and unchanged fields across compaction.
---

# H-05 correction continuity

Task: `h05-context-correction-chain`
Status: local candidate, not shipped

## Touched feature

The shared correction-rule section used by full and incremental prompts in both
`ChatContextCompressor` and the session-export `ExportCompressor`.

## Behavior impact

- A later explicit correction overrides earlier values field by field.
- A formatting-only correction changes presentation without changing backing values.
- Fields not named by a correction retain their current values.
- Superseded contradictory values are historical context, not current state.

The deterministic regression verifies that both full and incremental prompt builders include
the shared correction contract; it is a prompt/seam guard, not a semantic-model assertion.
The real local-model runner follows `8/10 → accepted=6 → total=9 (6/9) → integer 67%`
for two A/B-interleaved profile/session chains and binds the approved semantic assertions to
the ftask-captured process exit code.

## Verification

- Deterministic capture: 41/41 passed across the two compressor prompt seams, run-chat
  compression plumbing, and broker cross-profile fence tests.
- Real local-model capture: 8 calls through
  `ChatContextCompressor.compress → AgentBridgeClient`; `6/9 → 67%`, undeclared
  `title/owner` unchanged, own canary retained, and opposite-canary cross-match `0`.
- Earlier hand-authored/diagnostic artifacts are superseded and are not evidence for this result.

No production model, production service, Feishu delivery, credential, or employee data
was used. This is local-model UAT plus deterministic prompt-contract coverage, not production acceptance.
