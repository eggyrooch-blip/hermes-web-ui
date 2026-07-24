---
date: 2026-07-24
pr: pending
feature: Hermes v0.19 profile config compatibility
impact: Keeps shared Agent Bridge settings intact when a profile supplies only explicit overrides.
---

# Hermes v0.19 profile config compatibility

Status: local ftask candidate only; not merged or deployed.

The Agent Bridge now reads the profile's raw `config.yaml` layer before merging
it over shared configuration. Hermes v0.19's default-filled `load_config()`
result is intentionally not used as an override layer, so defaults cannot erase
shared custom providers, model settings, or agent settings.

Hermes Agent, multitenancy, authentication, routing, and page behavior are
unchanged.

## Verification

- `packages/server/src/services/hermes/agent-bridge/python/test_bridge_custom_providers.py`
- focused Agent Bridge Vitest contracts
- `npm run harness:check`
- `npm run typecheck`
- `npm run build`
