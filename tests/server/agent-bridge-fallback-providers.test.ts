import { describe, expect, it } from 'vitest'
import { bridgePoolPrelude, runBridgePython } from './helpers/bridge-pool-python'

describe('Agent Bridge fallback providers', () => {
  it('passes the configured fallback chain to each newly created agent', () => {
    const result = runBridgePython(bridgePoolPrelude(String.raw`
bridge_runtime._load_cfg = lambda *_args, **_kwargs: {"fallback_providers": [{"provider": "backup", "model": "backup-model"}]}
bridge_runtime._load_fallback_model = lambda cfg: cfg["fallback_providers"]
`) + String.raw`
session = bridge_pool.AgentPool().get_or_create("session-1")
print(json.dumps({"fallback_model": session.agent.kwargs.get("fallback_model")}))
`)

    expect(result).toEqual({
      fallback_model: [{ provider: 'backup', model: 'backup-model' }],
    })
  })

  it('passes no fallback chain when the config declares none', () => {
    const result = runBridgePython(bridgePoolPrelude() + String.raw`
session = bridge_pool.AgentPool().get_or_create("session-1")
print(json.dumps({
    "has_key": "fallback_model" in session.agent.kwargs,
    "fallback_model": session.agent.kwargs.get("fallback_model"),
}))
`)

    expect(result).toEqual({ has_key: true, fallback_model: null })
  })

  it('reads the fallback chain through hermes_cli.fallback_config', () => {
    const result = runBridgePython(String.raw`
import importlib.util
import json
import sys
import types

hermes_cli = types.ModuleType("hermes_cli")
hermes_cli.__path__ = []
sys.modules["hermes_cli"] = hermes_cli
fallback_config = types.ModuleType("hermes_cli.fallback_config")
fallback_config.get_fallback_chain = lambda cfg: cfg.get("chain") or []
sys.modules["hermes_cli.fallback_config"] = fallback_config
hermes_cli.fallback_config = fallback_config

spec = importlib.util.spec_from_file_location(
    "bridge_runtime",
    "packages/server/src/services/hermes/agent-bridge/python/bridge_runtime.py",
)
bridge_runtime = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["bridge_runtime"] = bridge_runtime
spec.loader.exec_module(bridge_runtime)

configured = bridge_runtime._load_fallback_model({"chain": [{"provider": "backup", "model": "backup-model"}]})
empty = bridge_runtime._load_fallback_model({"chain": []})

del sys.modules["hermes_cli.fallback_config"]
del sys.modules["hermes_cli"]
missing = bridge_runtime._load_fallback_model({"chain": [{"provider": "backup"}]})

print(json.dumps({"configured": configured, "empty": empty, "missing": missing}))
`)

    expect(result.configured).toEqual([{ provider: 'backup', model: 'backup-model' }])
    expect(result.empty).toBeNull()
    expect(result.missing).toBeNull()
  })
})
