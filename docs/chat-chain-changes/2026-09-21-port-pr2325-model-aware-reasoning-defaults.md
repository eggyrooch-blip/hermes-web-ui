---
date: 2026-09-21
pr: pending
feature: Model-aware Agent Bridge reasoning defaults
impact: Fresh and successfully model-switched Studio agents now inherit Hermes per-model reasoning overrides before the global reasoning effort.
---

Ported from upstream `99c741e14` (hermes-studio #2325). Explicit per-run reasoning effort remains the
highest-priority override and is restored to the current model-aware default after the run.
`bridge_runtime._load_reasoning_config` prefers `hermes_constants.resolve_reasoning_config` and keeps the
legacy `parse_reasoning_effort` path for runtimes that do not ship the shared resolver.
