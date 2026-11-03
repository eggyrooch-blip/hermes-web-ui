import { describe, expect, it } from 'vitest'
import { runBridgePython } from './helpers/bridge-pool-python'

const reasoningHarness = String.raw`
import contextlib
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

config = {
    "model": "gpt-5.6-luna",
    "agent": {
        "reasoning_effort": "xhigh",
        "reasoning_overrides": {
            "gpt-5.6-luna": "max",
            "gpt-5.6-sol": "xhigh",
        },
    },
}
resolved_configs = {
    "gpt-5.6-luna": {"enabled": True, "effort": "max"},
    "gpt-5.6-sol": {"enabled": True, "effort": "xhigh"},
    "gpt-5.6-orbit": {"enabled": True, "effort": "xhigh"},
}
resolver_calls = []

hermes_constants = types.ModuleType("hermes_constants")


def parse_reasoning_effort(effort):
    normalized = str(effort or "").strip()
    return {"enabled": True, "effort": normalized} if normalized else None


def resolve_reasoning_config(cfg, model):
    resolver_calls.append({"model": model, "received_config": cfg is config})
    return resolved_configs[model]


hermes_constants.parse_reasoning_effort = parse_reasoning_effort
hermes_constants.resolve_reasoning_config = resolve_reasoning_config
sys.modules["hermes_constants"] = hermes_constants

runtime_spec = importlib.util.spec_from_file_location(
    "bridge_runtime",
    "packages/server/src/services/hermes/agent-bridge/python/bridge_runtime.py",
)
bridge_runtime = importlib.util.module_from_spec(runtime_spec)
assert runtime_spec.loader is not None
sys.modules["bridge_runtime"] = bridge_runtime
runtime_spec.loader.exec_module(bridge_runtime)

bridge_runtime._ensure_agent_imports = lambda *_args, **_kwargs: None
bridge_runtime._load_cfg = lambda *_args, **_kwargs: config
bridge_runtime._base_hermes_home = lambda *_args, **_kwargs: Path(tempfile.gettempdir())
bridge_runtime._bridge_platform = lambda *_args, **_kwargs: "agent-bridge"
bridge_runtime._cfg_max_turns = lambda *_args, **_kwargs: 20
bridge_runtime._discover_bridge_mcp_tools = lambda *_args, **_kwargs: []
bridge_runtime._hermes_home = lambda *_args, **_kwargs: Path(tempfile.gettempdir())
bridge_runtime._install_execute_code_approval_memory_patch = lambda *_args, **_kwargs: None
bridge_runtime._jsonable = lambda value: value
bridge_runtime._load_enabled_toolsets = lambda *_args, **_kwargs: []
bridge_runtime._load_fallback_model = lambda *_args, **_kwargs: None
bridge_runtime._load_service_tier = lambda *_args, **_kwargs: None
bridge_runtime._mcp_tool_names_from_names = lambda *_args, **_kwargs: []
bridge_runtime._profile_home = lambda *_args, **_kwargs: Path(tempfile.gettempdir())
bridge_runtime._refresh_approval_allowlist = lambda *_args, **_kwargs: None
bridge_runtime._refresh_worker_profile_env = lambda *_args, **_kwargs: None
bridge_runtime._resolve_model = lambda cfg: str(cfg.get("model") or "")
bridge_runtime._resolve_runtime = lambda model, provider=None: {"provider": provider or "openai"}
bridge_runtime._suppress_bridge_platform_hint = lambda *_args, **_kwargs: None
bridge_runtime._tool_names_from_definitions = lambda *_args, **_kwargs: []


@contextlib.contextmanager
def profile_env(_profile=None):
    yield


bridge_runtime._profile_env = profile_env


class FakeAIAgent:
    def __init__(self, **kwargs):
        self.model = kwargs.get("model")
        self.provider = kwargs.get("provider")
        self.reasoning_config = kwargs.get("reasoning_config")
        self.tools = []
        self.raise_on_run = False
        self.run_reasoning_configs = []

    def switch_model(self, **kwargs):
        self.model = kwargs["new_model"]
        self.provider = kwargs["new_provider"]

    def run_conversation(self, _message, **_kwargs):
        self.run_reasoning_configs.append(dict(self.reasoning_config or {}))
        if self.raise_on_run:
            raise RuntimeError("run failed")
        return {"final_response": "ok", "messages": []}


run_agent = types.ModuleType("run_agent")
run_agent.AIAgent = FakeAIAgent
sys.modules["run_agent"] = run_agent

pool_spec = importlib.util.spec_from_file_location(
    "bridge_pool",
    "packages/server/src/services/hermes/agent-bridge/python/bridge_pool.py",
)
bridge_pool = importlib.util.module_from_spec(pool_spec)
assert pool_spec.loader is not None
sys.modules["bridge_pool"] = bridge_pool
pool_spec.loader.exec_module(bridge_pool)

pool = bridge_pool.AgentPool()
pool._db = types.SimpleNamespace(
    get_for_profile=lambda _profile: None,
    error=None,
)
`

describe('agent bridge model-aware reasoning overrides', () => {
  it('uses Hermes model-aware reasoning for fresh AgentPool sessions', () => {
    const result = runBridgePython(reasoningHarness + String.raw`
luna = pool.get_or_create("luna", model="gpt-5.6-luna")
sol = pool.get_or_create("sol", model="gpt-5.6-sol")
orbit = pool.get_or_create("orbit", model="gpt-5.6-orbit")
print(json.dumps({
    "luna": luna.agent.reasoning_config,
    "sol": sol.agent.reasoning_config,
    "orbit": orbit.agent.reasoning_config,
    "resolver_calls": resolver_calls,
}))
`)

    expect(result.luna.effort).toBe('max')
    expect(result.sol.effort).toBe('xhigh')
    expect(result.orbit.effort).toBe('xhigh')
    expect(result.resolver_calls).toEqual([
      { model: 'gpt-5.6-luna', received_config: true },
      { model: 'gpt-5.6-sol', received_config: true },
      { model: 'gpt-5.6-orbit', received_config: true },
    ])
  })

  it('refreshes model-aware reasoning for a loaded session switched from Luna to Sol', () => {
    const result = runBridgePython(reasoningHarness + String.raw`
session = pool.get_or_create("switched", model="gpt-5.6-luna")
before = dict(session.agent.reasoning_config)
pool.switch_session_model("switched", "gpt-5.6-sol", "openai", "default")
print(json.dumps({
    "before": before,
    "after": session.agent.reasoning_config,
    "model": session.config["model"],
}))
`)

    expect(result.before.effort).toBe('max')
    expect(result.after.effort).toBe('xhigh')
    expect(result.model).toBe('gpt-5.6-sol')
  })

  it('keeps the global parser fallback for Hermes runtimes without the shared resolver', () => {
    const result = runBridgePython(reasoningHarness + String.raw`
delattr(hermes_constants, "resolve_reasoning_config")
legacy = bridge_runtime._load_reasoning_config("gpt-5.6-luna")
print(json.dumps(legacy))
`)

    expect(result).toEqual({ enabled: true, effort: 'xhigh' })
  })

  it('does not hide errors raised inside the shared Hermes resolver', () => {
    const result = runBridgePython(reasoningHarness + String.raw`
def exploding_resolver(_cfg, _model):
    raise RuntimeError("resolver exploded")


hermes_constants.resolve_reasoning_config = exploding_resolver
caught = None
try:
    bridge_runtime._load_reasoning_config("gpt-5.6-luna")
except RuntimeError as exc:
    caught = str(exc)
print(json.dumps({"caught": caught}))
`)

    expect(result.caught).toBe('resolver exploded')
  })

  it('restores the model-aware default after explicit run overrides succeed or fail', () => {
    const result = runBridgePython(reasoningHarness + String.raw`
session = pool.get_or_create("override", model="gpt-5.6-luna")
pool._enter_exec_ask_scope = lambda: None
pool._exit_exec_ask_scope = lambda: None
pool._install_approval_dispatcher_for_current_thread = lambda *_args: None
pool._approval_callback = lambda *_args: None
pool._prepersist_user_message = lambda *_args: None
pool._session_db_message_count = lambda *_args: None
pool._prepend_pending_model_switch_note = lambda _session, message: message
pool._sync_result_tail_to_session_db = lambda *_args: None
pool._result_from_agent_messages_for_sync = lambda *_args: None
pool._apply_pending_session_model_switch = lambda *_args: None

default_before = dict(session.agent.reasoning_config)
session.running = True
success = bridge_pool.RunRecord("success", session.session_id)
pool._run_chat(session, success, "hello", reasoning_effort="high")
after_success = dict(session.agent.reasoning_config)

session.agent.raise_on_run = True
session.running = True
failure = bridge_pool.RunRecord("failure", session.session_id)
pool._run_chat(session, failure, "hello", reasoning_effort="low")
after_failure = dict(session.agent.reasoning_config)

print(json.dumps({
    "default_before": default_before,
    "seen_during_runs": session.agent.run_reasoning_configs,
    "after_success": after_success,
    "after_failure": after_failure,
    "statuses": [success.status, failure.status],
    "failure_error": failure.error,
}))
`)

    expect(result.default_before.effort).toBe('max')
    expect(result.seen_during_runs).toEqual([
      { enabled: true, effort: 'high' },
      { enabled: true, effort: 'low' },
    ])
    expect(result.after_success.effort).toBe('max')
    expect(result.after_failure.effort).toBe('max')
    expect(result.statuses).toEqual(['complete', 'error'])
    expect(result.failure_error).toBe('run failed')
  })
})
