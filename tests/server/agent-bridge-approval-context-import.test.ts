import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'

function runPython(script: string): any {
  try {
    const output = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    return JSON.parse(output)
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error([
      err.message || 'Python bridge approval-import script failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${err.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

// Extracts the shipped import block out of bridge_pool.py and executes it, so the
// assertions run against the real source rather than a copy of it.
const harness = String.raw`
import json
import sys
import textwrap
import types
from pathlib import Path

POOL = Path("packages/server/src/services/hermes/agent-bridge/python/bridge_pool.py")
lines = POOL.read_text(encoding="utf-8").splitlines()


def import_block(anchor):
    start = next(i for i, line in enumerate(lines) if line.strip() == anchor)
    block = []
    for line in lines[start:]:
        if not line.strip():
            break
        block.append(line)
    return compile(textwrap.dedent("\n".join(block)), "<bridge_pool-import-block>", "exec")


SETTER_BLOCK = import_block("from tools.approval import register_gateway_notify")
RESETTER_BLOCK = import_block("from tools.approval import unregister_gateway_notify")


def install_tools(with_approval_context, missing_dep=False):
    for name in [n for n in sys.modules if n == "tools" or n.startswith("tools.")]:
        del sys.modules[name]
    tools = types.ModuleType("tools")
    tools.__path__ = []
    sys.modules["tools"] = tools

    approval = types.ModuleType("tools.approval")
    approval.register_gateway_notify = lambda *a, **k: None
    approval.unregister_gateway_notify = lambda *a, **k: None
    approval.set_current_session_key = lambda key: "legacy-token"
    approval.reset_current_session_key = lambda token: "legacy-reset"
    sys.modules["tools.approval"] = approval
    tools.approval = approval

    if missing_dep:
        class Raiser:
            def find_spec(self, name, path=None, target=None):
                if name == "tools.approval_context":
                    raise ModuleNotFoundError("No module named 'some_dep'", name="some_dep")
                return None

        sys.meta_path.insert(0, Raiser())
        return

    if with_approval_context:
        ctx = types.ModuleType("tools.approval_context")
        ctx.set_current_session_key = lambda key: "context-token"
        ctx.reset_current_session_key = lambda token: "context-reset"
        sys.modules["tools.approval_context"] = ctx
        tools.approval_context = ctx
`

function scenario(body: string): string {
  return harness + '\n' + body
}

describe('agent bridge approval session-key imports', () => {
  it('prefers tools.approval_context on hermes-agent 0.21+ runtimes', () => {
    const result = runPython(scenario(String.raw`
install_tools(with_approval_context=True)
ns = {}
exec(SETTER_BLOCK, ns)
exec(RESETTER_BLOCK, ns)
print(json.dumps({
    "set": ns["set_current_session_key"]("s1"),
    "reset": ns["reset_current_session_key"]("t1"),
    "has_register": callable(ns["register_gateway_notify"]),
    "has_unregister": callable(ns["unregister_gateway_notify"]),
}))
`))

    expect(result.set).toBe('context-token')
    expect(result.reset).toBe('context-reset')
    expect(result.has_register).toBe(true)
    expect(result.has_unregister).toBe(true)
  })

  it('falls back to tools.approval on legacy runtimes without approval_context', () => {
    const result = runPython(scenario(String.raw`
install_tools(with_approval_context=False)
ns = {}
exec(SETTER_BLOCK, ns)
exec(RESETTER_BLOCK, ns)
print(json.dumps({
    "set": ns["set_current_session_key"]("s1"),
    "reset": ns["reset_current_session_key"]("t1"),
}))
`))

    expect(result.set).toBe('legacy-token')
    expect(result.reset).toBe('legacy-reset')
  })

  it('re-raises a ModuleNotFoundError raised by approval_context itself', () => {
    const result = runPython(scenario(String.raw`
install_tools(with_approval_context=False, missing_dep=True)
ns = {}
try:
    exec(SETTER_BLOCK, ns)
    outcome = "no-raise"
except ModuleNotFoundError as exc:
    outcome = exc.name
print(json.dumps({"outcome": outcome}))
`))

    expect(result.outcome).toBe('some_dep')
  })
})
