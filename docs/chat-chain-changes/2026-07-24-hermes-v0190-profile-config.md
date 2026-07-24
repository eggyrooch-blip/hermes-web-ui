---
date: 2026-07-24
pr: local-awaiting-verify
feature: Hermes v0.19 profile config compatibility
impact: Keeps shared Agent Bridge settings intact when a profile supplies only explicit overrides.
---

# Hermes v0.19 profile config compatibility

Status: the compatibility source change is merged locally as `230d206abec8`;
local `main` is running at `http://localhost:8648` and awaiting user
verification. Production is not deployed or probed.

The Agent Bridge now reads the profile's raw `config.yaml` layer before merging
it over shared configuration. Hermes v0.19's default-filled `load_config()`
result is intentionally not used as an override layer, so defaults cannot erase
shared custom providers, model settings, or agent settings.

This is the only WebUI compatibility source change for the local Hermes v0.19
switch. Hermes Agent source, authentication, routing, and page behavior are
unchanged.

## Verification

- `packages/server/src/services/hermes/agent-bridge/python/test_bridge_custom_providers.py`
- focused Agent Bridge Vitest contracts
- focused Run Chat Vitest contracts
- `npm run harness:check`
- `npm run typecheck`
- `npm run build`
- local `/health`: HTTP 200, Agent `v0.19.0`, Agent Bridge ready/running
- Agent Bridge socket ping: broker mode, pong true

No browser visual check, model call, Feishu message, cron execution, or
production action was performed.
