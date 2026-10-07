import { execFileSync } from 'child_process'

export const BRIDGE_POOL_PATH = 'packages/server/src/services/hermes/agent-bridge/python/bridge_pool.py'

/**
 * Runs a Python snippet that prints one JSON object on stdout and returns it.
 * Mirrors the harness used by the other agent-bridge Python tests.
 */
export function runBridgePython(script: string): any {
  try {
    const output = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
      maxBuffer: 4 * 1024 * 1024,
    })
    return JSON.parse(output)
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error([
      err.message || 'Python agent-bridge script failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${err.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

/**
 * Builds the prelude that stubs `bridge_runtime`, loads the real `bridge_pool`
 * module from disk and installs a recording `run_agent.AIAgent`.
 *
 * `runtimeOverrides` is Python source appended to the stub, so a test can
 * replace individual `bridge_runtime` helpers before `bridge_pool` is executed.
 */
export function bridgePoolPrelude(runtimeOverrides = ''): string {
  return String.raw`
import contextlib
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

bridge_runtime = types.ModuleType("bridge_runtime")
bridge_runtime.APPROVAL_TIMEOUT_MS = 1000
bridge_runtime.APPROVAL_TIMEOUT_SECONDS = 1
bridge_runtime._approval_pattern_keys = lambda *_args, **_kwargs: []
bridge_runtime._base_hermes_home = lambda *_args, **_kwargs: Path(tempfile.gettempdir())
bridge_runtime._bridge_platform = lambda *_args, **_kwargs: "agent-bridge"
bridge_runtime._cfg_max_turns = lambda *_args, **_kwargs: 20
bridge_runtime._discover_bridge_mcp_tools = lambda *_args, **_kwargs: []
bridge_runtime._ensure_agent_imports = lambda *_args, **_kwargs: None
bridge_runtime._hermes_home = lambda *_args, **_kwargs: Path(tempfile.gettempdir())
bridge_runtime._install_execute_code_approval_memory_patch = lambda *_args, **_kwargs: None
bridge_runtime._jsonable = lambda value: value
bridge_runtime._load_cfg = lambda *_args, **_kwargs: {}
bridge_runtime._load_enabled_toolsets = lambda *_args, **_kwargs: []
bridge_runtime._load_fallback_model = lambda *_args, **_kwargs: None
bridge_runtime._load_reasoning_config = lambda *_args, **_kwargs: {}
bridge_runtime._load_service_tier = lambda *_args, **_kwargs: None
bridge_runtime._mcp_tool_names_from_names = lambda *_args, **_kwargs: []
bridge_runtime._persist_execute_code_approval_choice = lambda *_args, **_kwargs: None
bridge_runtime._profile_home = lambda *_args, **_kwargs: Path(tempfile.gettempdir())
bridge_runtime._refresh_approval_allowlist = lambda *_args, **_kwargs: None
bridge_runtime._refresh_worker_profile_env = lambda *_args, **_kwargs: None
bridge_runtime._resolve_model = lambda *_args, **_kwargs: "primary-model"
bridge_runtime._resolve_runtime = lambda *_args, **_kwargs: {"provider": "primary"}
bridge_runtime._suppress_bridge_platform_hint = lambda *_args, **_kwargs: None
bridge_runtime._title_user_message = lambda value: value
bridge_runtime._tool_names_from_definitions = lambda *_args, **_kwargs: []


@contextlib.contextmanager
def _profile_env(_profile=None):
    yield


bridge_runtime._profile_env = _profile_env
` + runtimeOverrides + String.raw`
sys.modules["bridge_runtime"] = bridge_runtime

run_agent = types.ModuleType("run_agent")


class AIAgent:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.tools = []
        self.model = kwargs.get("model")
        self.compression_enabled = True


run_agent.AIAgent = AIAgent
sys.modules["run_agent"] = run_agent

spec = importlib.util.spec_from_file_location(
    "bridge_pool",
    "` + BRIDGE_POOL_PATH + String.raw`",
)
bridge_pool = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["bridge_pool"] = bridge_pool
spec.loader.exec_module(bridge_pool)
`
}
