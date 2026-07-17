import { afterEach, describe, expect, it, vi } from 'vitest'

const workspaceDiffTracker = vi.hoisted(() => ({
  start: vi.fn(() => ({ key: 'checkpoint-1' })),
  discard: vi.fn(),
  complete: vi.fn(() => ({
    change_id: 'change-1',
    session_id: 's1',
    run_id: 'rm',
    files_changed: 1,
    files: [{ id: 7, path: 'a.txt', additions: 1, deletions: 0 }],
  })),
}))
const sessionStore = vi.hoisted(() => ({
  getSession: vi.fn(() => null),
  getSessionRowId: vi.fn(() => 1),
  getSessionIncarnation: vi.fn(() => 1),
  updateSession: vi.fn(),
}))
const pathSecurity = vi.hoisted(() => ({
  isNearestExistingRealPathWithin: vi.fn(async () => true),
}))

// config.runBrokerUrl / runBrokerKey drive the fetch target.
vi.mock('../../packages/server/src/config', () => ({
  config: { runBrokerUrl: 'http://broker.test', runBrokerKey: 'k' },
}))
// Keep DB + input builders inert — replay mode doesn't touch them.
vi.mock('../../packages/server/src/db/hermes/session-store', () => sessionStore)
vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: () => '/tmp',
}))
vi.mock('../../packages/server/src/services/hermes/hermes-path', () => pathSecurity)
vi.mock('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker', () => ({
  startWorkspaceRunCheckpoint: workspaceDiffTracker.start,
  discardWorkspaceRunCheckpoint: workspaceDiffTracker.discard,
  completeWorkspaceRunCheckpoint: workspaceDiffTracker.complete,
}))

import { handleBrokerRun } from '../../packages/server/src/services/hermes/run-chat/handle-broker-run'

function sseStream(...frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f))
      c.close()
    },
  })
}

function fakeContext() {
  const state = { messages: [], isWorking: false, events: [], queue: [], runId: undefined, abortController: undefined } as any
  return {
    sessionMap: new Map([['s1', state]]),
    getOrCreateSession: () => state,
    getResponseRunState: () => ({ responseId: undefined, insertedKeys: new Set(), toolCalls: new Map() }),
    markCompleted: vi.fn(async () => ({ finalized: true })),
    abandonRun: vi.fn(() => true),
    dequeueNextQueuedRun: vi.fn(() => true),
    buildInput: (x: any) => x,
  } as any
}

const socket = { data: { user: { openid: 'ou_alice' } }, join: vi.fn(), connected: true } as any

afterEach(() => {
  vi.restoreAllMocks()
  sessionStore.getSession.mockReset()
  sessionStore.getSession.mockReturnValue(null)
  sessionStore.getSessionRowId.mockReset()
  sessionStore.getSessionRowId.mockReturnValue(1)
  sessionStore.getSessionIncarnation.mockReset()
  sessionStore.getSessionIncarnation.mockReturnValue(1)
  sessionStore.updateSession.mockClear()
  workspaceDiffTracker.start.mockClear()
  workspaceDiffTracker.discard.mockClear()
  workspaceDiffTracker.complete.mockClear()
  pathSecurity.isNearestExistingRealPathWithin.mockReset()
  pathSecurity.isNearestExistingRealPathWithin.mockResolvedValue(true)
})

describe('handleBrokerRun replay mode', () => {
  it('POSTs the broker replay endpoint (not /runs) when replay_run_id is set', async () => {
    const seen: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(String(url))
      return { ok: true, body: sseStream('event: done\ndata: {"kind":"done","run_id":"r"}\n\n'), status: 200 } as any
    })
    vi.stubGlobal('fetch', fetchMock)

    const emit = vi.fn()
    await handleBrokerRun(socket, { input: '', session_id: 's1', replay_run_id: 'sig-42' }, 'default', 'rm', emit, fakeContext())

    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe('http://broker.test/api/run-broker/credentials/replay/sig-42')
    expect(seen[0]).not.toContain('/api/run-broker/runs')
  })

  it('POSTs /runs (not replay) for a normal run', async () => {
    const seen: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(String(url))
      return { ok: true, body: sseStream('event: done\ndata: {"kind":"done","run_id":"r"}\n\n'), status: 200 } as any
    })
    vi.stubGlobal('fetch', fetchMock)

    const emit = vi.fn()
    await handleBrokerRun(socket, { input: 'hi', session_id: 's1' }, 'default', 'rm', emit, fakeContext())

    expect(seen[0]).toBe('http://broker.test/api/run-broker/runs')
    expect(seen[0]).not.toContain('/replay/')
  })

  it('does not dispatch after the session id is deleted and recreated during checkpoint startup', async () => {
    let resolveCheckpoint!: (value: { key: string }) => void
    workspaceDiffTracker.start.mockReturnValueOnce(new Promise(resolve => {
      resolveCheckpoint = resolve
    }))
    sessionStore.getSession
      .mockReturnValueOnce({ id: 's1', profile: 'default', workspace: '/tmp/work' })
      .mockReturnValue({ id: 's1', profile: 'default', workspace: '/tmp/work' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const pending = handleBrokerRun(
      socket,
      { input: 'hi', session_id: 's1', workspace: '/tmp/work' },
      'default',
      'rm',
      vi.fn(),
      fakeContext(),
    )
    await vi.waitFor(() => expect(workspaceDiffTracker.start).toHaveBeenCalled())
    sessionStore.getSessionRowId.mockReturnValue(2)
    sessionStore.getSessionIncarnation.mockReturnValue(2)
    resolveCheckpoint({ key: 'deleted-session-checkpoint' })
    await pending

    expect(workspaceDiffTracker.discard).toHaveBeenCalledWith({
      sessionId: 's1',
      checkpoint: { key: 'deleted-session-checkpoint' },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('attaches the broker run id to live session messages', async () => {
    const state = { messages: [], isWorking: false, events: [], queue: [], runId: undefined, abortController: undefined } as any
    const run = { runMarker: 'rm', responseId: undefined, insertedKeys: new Set<string>(), toolCalls: new Map() }
    const context = {
      sessionMap: new Map([['s1', state]]),
      getOrCreateSession: () => state,
      getResponseRunState: () => run,
      markCompleted: vi.fn(async () => ({ finalized: true })),
      abandonRun: vi.fn(() => true),
      dequeueNextQueuedRun: vi.fn(() => true),
      buildInput: (value: any) => value,
    } as any
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      body: sseStream(
        'event: content\ndata: {"kind":"content","run_id":"run-live","text":"hello"}\n\n',
        'event: done\ndata: {"kind":"done","run_id":"run-live","output":"hello"}\n\n',
      ),
    })))

    await handleBrokerRun(socket, { input: 'hi', session_id: 's1' }, 'default', 'rm', vi.fn(), context)

    expect(state.runId).toBe('run-live')
    expect(state.messages).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'hello', run_id: 'run-live' }),
    ])
  })

  it('tracks the default profile workspace with the webui marker when broker omits run_id', async () => {
    sessionStore.getSession.mockReturnValue({ id: 's1', profile: 'default', workspace: null } as any)
    const state = { messages: [], isWorking: false, events: [], queue: [], runId: undefined, abortController: undefined } as any
    const run = { runMarker: 'rm', responseId: undefined, insertedKeys: new Set<string>(), toolCalls: new Map() }
    const context = {
      sessionMap: new Map([['s1', state]]),
      getOrCreateSession: () => state,
      getResponseRunState: () => run,
      markCompleted: vi.fn(async () => ({ finalized: true })),
      abandonRun: vi.fn(() => true),
      dequeueNextQueuedRun: vi.fn(() => true),
      buildInput: (value: any) => value,
    } as any
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'))
      expect(body.metadata.instructions).toContain('[Current working directory: /tmp/workspace]')
      return {
        ok: true,
        status: 200,
        body: sseStream(
          'event: content\ndata: {"kind":"content","text":"done"}\n\n',
          'event: done\ndata: {"kind":"done"}\n\n',
        ),
      } as any
    }))

    const emit = vi.fn()
    await handleBrokerRun(socket, { input: 'hi', session_id: 's1' }, 'default', 'rm', emit, context)

    expect(workspaceDiffTracker.start).toHaveBeenCalledWith({ sessionId: 's1', workspace: '/tmp/workspace' })
    expect(workspaceDiffTracker.complete).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      runId: 'rm',
      workspace: '/tmp/workspace',
    }))
    expect(sessionStore.updateSession).toHaveBeenCalledWith('s1', { workspace: '/tmp/workspace' })
    expect(state.messages).toEqual([expect.objectContaining({ content: 'done', run_id: 'rm' })])
    expect(emit.mock.calls.map(call => call[0])).toEqual(['message.delta', 'workspace.diff.completed', 'run.completed'])
  })

  it('finishes the workspace diff before completion can schedule a goal continuation', async () => {
    const order: string[] = []
    let finishDiff!: () => void
    workspaceDiffTracker.complete.mockImplementationOnce(() => new Promise(resolve => {
      order.push('diff.started')
      finishDiff = () => {
        order.push('diff.finished')
        resolve({
          change_id: 'change-1',
          session_id: 's1',
          run_id: 'run-1',
          files_changed: 1,
          files: [{ id: 7, path: 'a.txt', additions: 1, deletions: 0 }],
        })
      }
    }))
    const context = fakeContext()
    context.markCompleted.mockImplementation(async () => {
      order.push('mark.completed')
      setTimeout(() => order.push('goal.continuation.started'), 0)
      return { finalized: true }
    })
    const emit = vi.fn((event: string) => order.push(`emit:${event}`))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      body: sseStream('event: done\ndata: {"kind":"done","run_id":"run-1","output":"done"}\n\n'),
    })))

    const pending = handleBrokerRun(socket, { input: 'hi', session_id: 's1' }, 'default', 'rm', emit, context)
    await vi.waitFor(() => expect(workspaceDiffTracker.complete).toHaveBeenCalled())

    expect(context.markCompleted).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalledWith('run.completed', expect.anything())

    finishDiff()
    await pending
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(order).toEqual([
      'diff.started',
      'diff.finished',
      'emit:workspace.diff.completed',
      'mark.completed',
      'emit:run.completed',
      'goal.continuation.started',
    ])
  })

  it('falls back from a stored workspace pointing at another profile', async () => {
    // setWorkspace persists any string, so the stored value is attacker-controlled;
    // the prompt AND the diff tracker must both land on the profile default.
    sessionStore.getSession.mockReturnValueOnce({ id: 's1', workspace: '/tmp/other-profile/workspace' } as any)
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'))
      expect(body.metadata.instructions).toContain('[Current working directory: /tmp/workspace]')
      expect(body.metadata.instructions).not.toContain('/tmp/other-profile')
      return { ok: true, status: 200, body: sseStream('event: done\ndata: {"kind":"done","run_id":"r"}\n\n') } as any
    }))

    await handleBrokerRun(socket, { input: 'hi', session_id: 's1', workspace: 'sub' }, 'default', 'rm', vi.fn(), fakeContext())

    expect(workspaceDiffTracker.start).toHaveBeenCalledWith({ sessionId: 's1', workspace: '/tmp/workspace' })
  })

  it('falls back from broker payload workspaces outside the profile workspace', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'))
      expect(body.metadata.instructions).toContain('[Current working directory: /tmp/workspace]')
      expect(body.metadata.instructions).not.toContain('/tmp/escape')
      return { ok: true, status: 200, body: sseStream('event: done\ndata: {"kind":"done","run_id":"r"}\n\n') } as any
    }))

    await handleBrokerRun(socket, { input: 'hi', session_id: 's1', workspace: '/tmp/escape' }, 'default', 'rm', vi.fn(), fakeContext())

    expect(workspaceDiffTracker.start).toHaveBeenCalledWith({ sessionId: 's1', workspace: '/tmp/workspace' })
  })

  it('falls back when a contained payload path resolves through a symlink escape', async () => {
    pathSecurity.isNearestExistingRealPathWithin.mockResolvedValue(false)
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'))
      expect(body.metadata.instructions).toContain('[Current working directory: /tmp/workspace]')
      expect(body.metadata.instructions).not.toContain('/tmp/workspace/escape')
      return { ok: true, status: 200, body: sseStream('event: done\ndata: {"kind":"done","run_id":"r"}\n\n') } as any
    }))

    await handleBrokerRun(socket, { input: 'hi', session_id: 's1', workspace: '/tmp/workspace/escape' }, 'default', 'rm', vi.fn(), fakeContext())

    expect(pathSecurity.isNearestExistingRealPathWithin).toHaveBeenCalledWith('/tmp/workspace/escape', '/tmp/workspace')
    expect(workspaceDiffTracker.start).toHaveBeenCalledWith({ sessionId: 's1', workspace: '/tmp/workspace' })
  })

  it('retags early fallback messages before completion when broker supplies a late run_id', async () => {
    const state = { messages: [], isWorking: false, events: [], queue: [], runId: undefined, abortController: undefined } as any
    const run = { runMarker: 'rm', responseId: undefined, insertedKeys: new Set<string>(), toolCalls: new Map() }
    const persistedRunIds: Array<string | null | undefined> = []
    const context = {
      sessionMap: new Map([['s1', state]]),
      getOrCreateSession: () => state,
      getResponseRunState: () => run,
      markCompleted: vi.fn(async () => {
        persistedRunIds.push(...state.messages.map((message: any) => message.run_id))
        return { finalized: true }
      }),
      abandonRun: vi.fn(() => true),
      dequeueNextQueuedRun: vi.fn(() => true),
      buildInput: (value: any) => value,
    } as any
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      body: sseStream(
        'event: content\ndata: {"kind":"content","text":"done"}\n\n',
        'event: done\ndata: {"kind":"done","run_id":"run-late"}\n\n',
      ),
    })))

    await handleBrokerRun(socket, { input: 'hi', session_id: 's1' }, 'default', 'rm', vi.fn(), context)

    expect(persistedRunIds).toEqual(['run-late'])
    expect(workspaceDiffTracker.complete).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-late' }))
  })
})
