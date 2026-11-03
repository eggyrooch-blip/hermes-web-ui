---
date: 2026-09-21
pr: pending
feature: Agent Bridge fallback providers
impact: New Agent Bridge sessions pass the configured fallback provider chain to Hermes agents so model requests can use the configured provider and model fallbacks.
---

Ported from upstream `e5343d570` (hermes-studio #2599). `bridge_runtime._load_fallback_model` reads the
canonical chain through `hermes_cli.fallback_config.get_fallback_chain` and fails open to `None` when the
agent runtime does not expose it; `bridge_pool` passes the result to every newly created `AIAgent`.
