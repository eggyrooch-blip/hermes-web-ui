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
      err.message || 'Python bridge transport script failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${err.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

function endpointProbe(tempDirExpr: string, transport: string | null): string {
  const transportLine = transport === null
    ? 'os.environ.pop("HERMES_AGENT_BRIDGE_WORKER_TRANSPORT", None)'
    : `os.environ["HERMES_AGENT_BRIDGE_WORKER_TRANSPORT"] = ${JSON.stringify(transport)}`
  return String.raw`
import importlib.util
import json
import os
import sys
import types

bridge_runtime = types.ModuleType("bridge_runtime")
bridge_runtime._hidden_subprocess_kwargs = lambda: {}
bridge_runtime._json_line_bytes = lambda req: (json.dumps(req) + "\n").encode("utf-8")
bridge_runtime._platform_text_encoding = lambda: "utf-8"
sys.modules["bridge_runtime"] = bridge_runtime

spec = importlib.util.spec_from_file_location(
    "bridge_transport",
    "packages/server/src/services/hermes/agent-bridge/python/bridge_transport.py",
)
bridge_transport = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge_transport)

original_name = bridge_transport.os.name
original_gettempdir = bridge_transport.tempfile.gettempdir
try:
    bridge_transport.os.name = "posix"
    bridge_transport.tempfile.gettempdir = lambda: ` + tempDirExpr + `
    ` + transportLine + `
    endpoint = bridge_transport._worker_endpoint("default", "ipc:///tmp/hermes-agent-bridge.sock")
finally:
    bridge_transport.os.name = original_name
    bridge_transport.tempfile.gettempdir = original_gettempdir
    os.environ.pop("HERMES_AGENT_BRIDGE_WORKER_TRANSPORT", None)

print(json.dumps({"endpoint": endpoint}))
`
}

const DEEP_TEMP_DIR = '"/" + "/".join(["deep-temp-dir"] * 12)'

describe('agent bridge worker endpoint', () => {
  it('uses an ipc endpoint when the worker socket path fits in sun_path', () => {
    const result = runPython(endpointProbe('"/tmp"', null))

    expect(result.endpoint).toMatch(/^ipc:\/\/.*\.sock$/)
  })

  it('falls back to an OS-assigned TCP port when the temp dir pushes the socket path past sun_path', () => {
    const result = runPython(endpointProbe(DEEP_TEMP_DIR, null))

    // Port 0, not a hashed port: the hashed range holds 1000 slots, so two
    // profiles of one namespace collide and the second worker cannot bind.
    expect(result.endpoint).toBe('tcp://127.0.0.1:0')
  })

  it('keeps the deterministic hashed port when TCP transport is requested explicitly', () => {
    const result = runPython(endpointProbe('"/tmp"', 'tcp'))

    expect(result.endpoint).toMatch(/^tcp:\/\/127\.0\.0\.1:\d+$/)
    const port = Number(result.endpoint.split(':').pop())
    expect(port).toBeGreaterThanOrEqual(18780)
    expect(port).toBeLessThan(19780)
  })

  it('keeps the ipc endpoint when the transport is explicitly forced to ipc', () => {
    const result = runPython(endpointProbe(DEEP_TEMP_DIR, 'ipc'))

    expect(result.endpoint).toMatch(/^ipc:\/\/.*\.sock$/)
    expect(result.endpoint).toContain('deep-temp-dir')
  })
  it('brings up two workers whose hashed ports collide, each reachable on its own port', () => {
    const result = runPython(String.raw`
import hashlib
import json
import os
import subprocess
import sys
import textwrap
import types
import importlib.util

REPO = os.getcwd()
TRANSPORT = os.path.join(REPO, "packages/server/src/services/hermes/agent-bridge/python/bridge_transport.py")

bridge_runtime = types.ModuleType("bridge_runtime")
bridge_runtime._hidden_subprocess_kwargs = lambda: {}
bridge_runtime._json_line_bytes = lambda req: (json.dumps(req) + chr(10)).encode("utf-8")
bridge_runtime._platform_text_encoding = lambda: "utf-8"
sys.modules["bridge_runtime"] = bridge_runtime
spec = importlib.util.spec_from_file_location("bridge_transport", TRANSPORT)
bridge_transport = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["bridge_transport"] = bridge_transport
spec.loader.exec_module(bridge_transport)

# The two profile keys the review found sharing a hashed port.
KEY_A = "profile-9"
KEY_B = "profile-36"
NAMESPACE = "ipc:///tmp/hermes-agent-bridge.sock"


def hashed_port(key):
    safe = hashlib.sha256((NAMESPACE + chr(0) + key).encode("utf-8")).hexdigest()[:16]
    return 18780 + int(safe[:4], 16) % 1000


original_name = bridge_transport.os.name
original_gettempdir = bridge_transport.tempfile.gettempdir
os.environ.pop("HERMES_AGENT_BRIDGE_WORKER_TRANSPORT", None)
try:
    bridge_transport.os.name = "posix"
    bridge_transport.tempfile.gettempdir = lambda: "/" + "/".join(["deep-temp-dir"] * 12)
    endpoint_a = bridge_transport._worker_endpoint(KEY_A, NAMESPACE)
    endpoint_b = bridge_transport._worker_endpoint(KEY_B, NAMESPACE)
finally:
    bridge_transport.os.name = original_name
    bridge_transport.tempfile.gettempdir = original_gettempdir

WORKER = textwrap.dedent(
    '''
    import json, sys, types
    import importlib.util
    bridge_runtime = types.ModuleType("bridge_runtime")
    bridge_runtime._hidden_subprocess_kwargs = lambda: {}
    bridge_runtime._json_line_bytes = lambda req: (json.dumps(req) + chr(10)).encode("utf-8")
    bridge_runtime._platform_text_encoding = lambda: "utf-8"
    sys.modules["bridge_runtime"] = bridge_runtime
    spec = importlib.util.spec_from_file_location("bridge_transport", sys.argv[1])
    bt = importlib.util.module_from_spec(spec)
    sys.modules["bridge_transport"] = bt
    spec.loader.exec_module(bt)

    requested, key = sys.argv[2], sys.argv[3]
    server = bt._make_listen_socket(requested)
    server.listen(4)
    endpoint = bt._endpoint_for_listen_socket(requested, server)
    print(json.dumps({"event": "ready", "endpoint": endpoint}), flush=True)
    while True:
        conn, _addr = server.accept()
        try:
            bt._read_json_request(conn)
            bt._write_json_response(conn, {"ok": True, "worker": key})
        finally:
            conn.close()
    '''
)

procs = []
workers = []
try:
    for key, requested in ((KEY_A, endpoint_a), (KEY_B, endpoint_b)):
        proc = subprocess.Popen(
            [sys.executable, "-c", WORKER, TRANSPORT, requested, key],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        procs.append(proc)
        worker = bridge_transport.WorkerProcess(key, key, requested, None, None)
        worker.process = proc
        # The real readiness handshake, including adopting the reported endpoint.
        worker._wait_ready()
        workers.append(worker)

    replies = [
        bridge_transport._send_bridge_request(worker.endpoint, {"op": "ping"}, 5)
        for worker in workers
    ]
    payload = {
        "requested": [endpoint_a, endpoint_b],
        "requested_kept": [worker.requested_endpoint for worker in workers],
        "bound": [worker.endpoint for worker in workers],
        "replies": [reply.get("worker") for reply in replies],
        "hashed_ports": [hashed_port(KEY_A), hashed_port(KEY_B)],
    }
finally:
    for proc in procs:
        proc.kill()
        proc.wait(timeout=5)

print(json.dumps(payload))
`)

    // The two keys really do collide under the old hashed scheme.
    expect(result.hashed_ports[0]).toBe(result.hashed_ports[1])

    expect(result.requested).toEqual(['tcp://127.0.0.1:0', 'tcp://127.0.0.1:0'])
    // A restart re-draws the port instead of re-binding the old one.
    expect(result.requested_kept).toEqual(['tcp://127.0.0.1:0', 'tcp://127.0.0.1:0'])

    const [boundA, boundB] = result.bound
    expect(boundA).toMatch(/^tcp:\/\/127\.0\.0\.1:\d+$/)
    expect(boundB).toMatch(/^tcp:\/\/127\.0\.0\.1:\d+$/)
    expect(boundA).not.toBe(boundB)

    // Both workers are ready and each concrete endpoint reaches its own worker.
    expect(result.replies).toEqual(['profile-9', 'profile-36'])
  })
})
