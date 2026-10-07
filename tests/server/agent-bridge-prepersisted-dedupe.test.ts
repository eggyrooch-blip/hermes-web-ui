import { describe, expect, it } from 'vitest'
import { bridgePoolPrelude, runBridgePython } from './helpers/bridge-pool-python'

const persistenceHarness = bridgePoolPrelude() + String.raw`
class FakeDb:
    def __init__(self):
        self.rows = []

    def create_session(self, **_kwargs):
        pass

    def get_messages(self, _session_id):
        return list(self.rows)

    def append_message(self, **row):
        self.rows.append({"role": row["role"], "content": row["content"]})


class FakeAgent:
    """Mirrors hermes-agent/agent/session_persistence.py: every durable write goes
    through _flush_messages_to_session_db, and _persist_session delegates to it.
    The in-loop writers (turn_tool_round, turn_final_response, turn_stop_gates)
    call the flush entry point directly, never _persist_session."""

    def __init__(self, db):
        self.db = db
        self.flush_calls = 0
        self.raise_on_run = False
        self.inside_run = None
        self.release_run = None

    def _flush_messages_to_session_db(self, messages, _conversation_history=None):
        self.flush_calls += 1
        for message in messages:
            if not message.get("_db_persisted"):
                self.db.append_message(role=message["role"], content=message.get("content"))
                message["_db_persisted"] = True
        return True

    def _persist_session(self, messages, conversation_history=None):
        return self._flush_messages_to_session_db(messages, conversation_history)

    def run_conversation(self, _message, **_kwargs):
        if self.inside_run is not None:
            self.inside_run.set()
        if self.release_run is not None:
            self.release_run.wait(10)
        if self.raise_on_run:
            raise RuntimeError("run failed")
        return {"final_response": "ok", "messages": []}


pool = bridge_pool.AgentPool()
db = FakeDb()
pool._db = types.SimpleNamespace(get_for_profile=lambda _profile: db)
agent = FakeAgent(db)
session = bridge_pool.AgentSession("session-1", agent, config={"model": "test"})
pool._install_prepersist_dedup_hook(agent)
`

describe('agent bridge pre-persisted user messages', () => {
  it('marks only a successfully pre-persisted current user before native flush', () => {
    const result = runBridgePython(persistenceHarness + String.raw`
assert pool._prepersist_user_message(session, "hello", None, [], "default") is True
messages = [
    {"role": "user", "content": "hello"},
    {"role": "assistant", "content": "hi"},
    {"role": "tool", "content": "done"},
]
agent._persist_session(messages, [])
print(json.dumps({"rows": db.rows, "pending": getattr(agent, "_hermes_bridge_prepersisted_user_run", None)}))
`)

    expect(result.rows).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'tool', content: 'done' },
    ])
    expect(result.pending).toBeNull()
  })

  it('does not suppress a native user write when bridge pre-persist fails', () => {
    const result = runBridgePython(persistenceHarness + String.raw`
pool._db = types.SimpleNamespace(get_for_profile=lambda _profile: None)
assert pool._prepersist_user_message(session, "fallback", None, [], "default") is False
agent._persist_session([{"role": "user", "content": "fallback"}], [])
print(json.dumps({"rows": db.rows, "pending": getattr(agent, "_hermes_bridge_prepersisted_user_run", None)}))
`)

    expect(result.rows).toEqual([{ role: 'user', content: 'fallback' }])
    expect(result.pending).toBeNull()
  })

  it('skips exactly one earlier user entry when the flush list holds several', () => {
    const result = runBridgePython(persistenceHarness + String.raw`
assert pool._prepersist_user_message(session, "second", None, [{"role": "user", "content": "first"}], "default") is True
db.rows = []
messages = [
    {"role": "user", "content": "first"},
    {"role": "assistant", "content": "answer"},
    {"role": "user", "content": "second"},
]
agent._persist_session(messages, [])
print(json.dumps({"rows": db.rows, "pending": getattr(agent, "_hermes_bridge_prepersisted_user_run", None)}))
`)

    expect(result.rows).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
    ])
    expect(result.pending).toBeNull()
  })

  it('installs the dedup wrapper only once per agent', () => {
    const result = runBridgePython(persistenceHarness + String.raw`
pool._install_prepersist_dedup_hook(agent)
pool._install_prepersist_dedup_hook(agent)
assert pool._prepersist_user_message(session, "hello", None, [], "default") is True
db.rows = []
agent._persist_session([{"role": "user", "content": "hello"}], [])
print(json.dumps({"rows": db.rows, "pending": getattr(agent, "_hermes_bridge_prepersisted_user_run", None)}))
`)

    expect(result.rows).toEqual([])
    expect(result.pending).toBeNull()
  })

  it('consumes the marker on a direct tool-round flush that never calls _persist_session', () => {
    const result = runBridgePython(persistenceHarness + String.raw`
assert pool._prepersist_user_message(session, "hello", None, [], "default") is True
# turn_tool_round.py flushes mid-turn through the direct entry point.
tool_round = [
    {"role": "user", "content": "hello"},
    {"role": "assistant", "content": "calling a tool"},
    {"role": "tool", "content": "tool output"},
]
agent._flush_messages_to_session_db(tool_round, [])
# turn_finalizer.py then persists the same live list at the turn boundary.
tool_round.append({"role": "assistant", "content": "final answer"})
agent._persist_session(tool_round, [])
print(json.dumps({"rows": db.rows, "flush_calls": agent.flush_calls}))
`)

    expect(result.rows).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'calling a tool' },
      { role: 'tool', content: 'tool output' },
      { role: 'assistant', content: 'final answer' },
    ])
    expect(result.flush_calls).toBe(2)
  })

  it('wraps the flush entry point rather than only the turn boundary', () => {
    const result = runBridgePython(persistenceHarness + String.raw`
print(json.dumps({
    "flush_wrapped": getattr(agent._flush_messages_to_session_db, "_hermes_bridge_prepersist_dedup_wrapper", False),
}))
`)

    expect(result.flush_wrapped).toBe(true)
  })

  it('still wraps _persist_session on runtimes without the flush entry point', () => {
    const result = runBridgePython(persistenceHarness + String.raw`
class LegacyAgent:
    def __init__(self, db):
        self.db = db

    def _persist_session(self, messages, _conversation_history=None):
        for message in messages:
            if not message.get("_db_persisted"):
                self.db.append_message(role=message["role"], content=message.get("content"))
                message["_db_persisted"] = True


legacy_db = FakeDb()
legacy_pool = bridge_pool.AgentPool()
legacy_pool._db = types.SimpleNamespace(get_for_profile=lambda _profile: legacy_db)
legacy_agent = LegacyAgent(legacy_db)
legacy_session = bridge_pool.AgentSession("legacy-1", legacy_agent, config={"model": "test"})
legacy_pool._install_prepersist_dedup_hook(legacy_agent)
assert legacy_pool._prepersist_user_message(legacy_session, "hello", None, [], "default") is True
legacy_db.rows = []
legacy_agent._persist_session([{"role": "user", "content": "hello"}], [])
print(json.dumps({
    "rows": legacy_db.rows,
    "has_flush_attr": hasattr(legacy_agent, "_flush_messages_to_session_db"),
}))
`)

    expect(result.rows).toEqual([])
    expect(result.has_flush_attr).toBe(false)
  })

  it('marks the message as already durable when the row is in the DB from a failed retry', () => {
    const result = runBridgePython(persistenceHarness + String.raw`
# A previous run pre-persisted "hello" and then died before any assistant output,
# so the DB tail is still that user row and the marker was cleared with the run.
db.rows.append({"role": "user", "content": "hello"})
agent._hermes_bridge_prepersisted_user_run = None

assert pool._prepersist_user_message(session, "hello", None, [], "default") is False
before = len(db.rows)
agent._persist_session([{"role": "user", "content": "hello"}], [])
print(json.dumps({"rows": db.rows, "wrote": len(db.rows) - before}))
`)

    expect(result.wrote).toBe(0)
    expect(result.rows).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('still lets the native flush write when the bridge write itself failed', () => {
    const result = runBridgePython(persistenceHarness + String.raw`
pool._db = types.SimpleNamespace(get_for_profile=lambda _profile: None)
assert pool._prepersist_user_message(session, "hello", None, [], "default") is False
print(json.dumps({"pending": getattr(agent, "_hermes_bridge_prepersisted_user_run", None)}))
`)

    expect(result.pending).toBeNull()
  })

  it('does not let a late-finishing run clear the marker a following run armed', () => {
    const result = runBridgePython(persistenceHarness + String.raw`
import threading

for name in [
    "_enter_exec_ask_scope",
    "_exit_exec_ask_scope",
    "_apply_pending_session_model_switch",
]:
    setattr(pool, name, lambda *_args, **_kwargs: None)
pool._install_approval_dispatcher_for_current_thread = lambda *_args: None
pool._approval_callback = lambda *_args: None
pool._session_db_message_count = lambda *_args: None
pool._prepend_pending_model_switch_note = lambda _session, message: message
pool._sync_result_tail_to_session_db = lambda *_args: None
pool._result_from_agent_messages_for_sync = lambda *_args: None

agent.inside_run = threading.Event()
agent.release_run = threading.Event()
agent.raise_on_run = True

record_a = bridge_pool.RunRecord("run-A", session.session_id)
session.running = True
thread = threading.Thread(target=pool._run_chat, args=(session, record_a, "first"))
thread.start()
assert agent.inside_run.wait(10), "run A never entered run_conversation"

owner_during_a = getattr(agent, "_hermes_bridge_prepersisted_user_run", None)

# Run B starts and arms its own marker while run A is still unwinding.
db.rows.append({"role": "assistant", "content": "unrelated"})
assert pool._prepersist_user_message(session, "second", None, [], "default", None, "run-B") is True
owner_after_b = getattr(agent, "_hermes_bridge_prepersisted_user_run", None)

agent.release_run.set()
thread.join(10)
owner_after_a_finished = getattr(agent, "_hermes_bridge_prepersisted_user_run", None)

before = len(db.rows)
agent._persist_session([{"role": "user", "content": "second"}], [])
print(json.dumps({
    "owner_during_a": owner_during_a,
    "owner_after_b": owner_after_b,
    "owner_after_a_finished": owner_after_a_finished,
    "wrote_after_flush": len(db.rows) - before,
    "status_a": record_a.status,
}))
`)

    expect(result.owner_during_a).toBe('run-A')
    expect(result.owner_after_b).toBe('run-B')
    expect(result.owner_after_a_finished).toBe('run-B')
    expect(result.wrote_after_flush).toBe(0)
    expect(result.status_a).toBe('error')
  })

  it('clears its own marker when the run ends without reaching a native flush', () => {
    const result = runBridgePython(persistenceHarness + String.raw`
pool._mark_prepersisted_user(session, "run-A")
owner_before = getattr(agent, "_hermes_bridge_prepersisted_user_run", None)
pool._release_prepersist_marker(session, "run-A")
print(json.dumps({
    "owner_before": owner_before,
    "owner_after": getattr(agent, "_hermes_bridge_prepersisted_user_run", None),
}))
`)

    expect(result.owner_before).toBe('run-A')
    expect(result.owner_after).toBeNull()
  })
})
