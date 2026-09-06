import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  getSession: vi.fn(() => ({ id: 's1', profile: 'default', workspace: null })),
  getSessionRowId: vi.fn(() => 1),
  getSessionIncarnation: vi.fn(() => 1),
  updateSession: vi.fn(),
}))
const pathSecurity = vi.hoisted(() => ({
  isNearestExistingRealPathWithin: vi.fn(async () => true),
}))
const profileRoot = vi.hoisted(() => ({ value: '/tmp' }))
const workspaceNormalize = vi.hoisted(() => async (value?: string | null) => {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw === '/tmp/workspace') return null
  if (raw.startsWith('/tmp/workspace/')) return raw.slice('/tmp/workspace/'.length)
  if (raw.startsWith('/')) throw new Error('Invalid workspace')
  return raw
})
const workspace = vi.hoisted(() => ({
  normalize: vi.fn(async (_profile: string, value?: string | null) => workspaceNormalize(value)),
  normalizeStored: vi.fn(async (_profile: string, value?: string | null) => {
    try {
      return await workspaceNormalize(value)
    } catch {
      return null
    }
  }),
  ensure: vi.fn(async (_profile: string, value?: string | null) => {
    const target = value ? `/tmp/workspace/${value}` : '/tmp/workspace'
    if (!(await pathSecurity.isNearestExistingRealPathWithin(target, '/tmp/workspace'))) {
      throw new Error('Invalid workspace')
    }
    return target
  }),
}))

// config.runBrokerUrl / runBrokerKey drive the fetch target.
vi.mock('../../packages/server/src/config', () => ({
  config: { runBrokerUrl: 'http://broker.test', runBrokerKey: 'k' },
}))
// Keep DB + input builders inert — replay mode doesn't touch them.
vi.mock('../../packages/server/src/db/hermes/session-store', () => sessionStore)
vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: () => profileRoot.value,
}))
vi.mock('../../packages/server/src/services/hermes/hermes-path', () => pathSecurity)
vi.mock('../../packages/server/src/services/hermes/run-chat/workspace', () => ({
  ensureHermesRunWorkspace: workspace.ensure,
  normalizeHermesSessionWorkspace: workspace.normalize,
  normalizeStoredHermesSessionWorkspace: workspace.normalizeStored,
}))
vi.mock('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker', () => ({
  startWorkspaceRunCheckpoint: workspaceDiffTracker.start,
  discardWorkspaceRunCheckpoint: workspaceDiffTracker.discard,
  completeWorkspaceRunCheckpoint: workspaceDiffTracker.complete,
}))

import { handleBrokerRun } from '../../packages/server/src/services/hermes/run-chat/handle-broker-run'
import { publishRunAssistantMedia } from '../../packages/server/src/services/hermes/media-directives'

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
  sessionStore.getSession.mockReturnValue({ id: 's1', profile: 'default', workspace: null })
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
  workspace.normalize.mockClear()
  workspace.ensure.mockClear()
  if (profileRoot.value !== '/tmp') rmSync(profileRoot.value, { recursive: true, force: true })
  profileRoot.value = '/tmp'
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

  it('keeps a bound session workspace across a credential replay', async () => {
    // A replay does not re-resolve the binding, so the run-side workspace is null.
    // Writing that back would silently unbind the session and send every later run
    // to the workspace root — acceptance scenario 5 says the path must survive.
    sessionStore.getSession.mockReturnValue({ id: 's1', profile: 'default', workspace: 'work' } as any)
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      body: sseStream('event: done\ndata: {"kind":"done","run_id":"r"}\n\n'),
    } as any)))

    await handleBrokerRun(socket, { input: '', session_id: 's1', replay_run_id: 'sig-42' }, 'default', 'rm', vi.fn(), fakeContext())

    expect(sessionStore.updateSession).not.toHaveBeenCalledWith('s1', expect.objectContaining({ workspace: null }))
    expect(sessionStore.updateSession).not.toHaveBeenCalled()
  })

  it('runs a bound session in its stored workspace and leaves the binding alone', async () => {
    sessionStore.getSession.mockReturnValue({ id: 's1', profile: 'default', workspace: 'work' } as any)
    let body: any
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body || '{}'))
      return { ok: true, status: 200, body: sseStream('event: done\ndata: {"kind":"done","run_id":"r"}\n\n') } as any
    }))

    await handleBrokerRun(socket, { input: 'hi', session_id: 's1' }, 'default', 'rm', vi.fn(), fakeContext())

    expect(body.workspace).toBe('work')
    expect(body.metadata.instructions).toContain('[Current working directory: /tmp/workspace/work]')
    expect(sessionStore.updateSession).not.toHaveBeenCalled()
  })

  it('binds a request workspace on a session whose first user message is already persisted', async () => {
    // The controller writes the user message BEFORE dispatch, so a brand-new
    // session's first turn arrives here with message_count=1. Gating the payload on
    // message count would drop the workspace the user just picked.
    sessionStore.getSession.mockReturnValue({ id: 's1', profile: 'default', workspace: null, message_count: 1 } as any)
    let body: any
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body || '{}'))
      return { ok: true, status: 200, body: sseStream('event: done\ndata: {"kind":"done","run_id":"r"}\n\n') } as any
    }))

    await handleBrokerRun(socket, { input: 'hi', session_id: 's1', workspace: 'sub' }, 'default', 'rm', vi.fn(), fakeContext())

    expect(body.workspace).toBe('sub')
    expect(body.metadata.instructions).toContain('[Current working directory: /tmp/workspace/sub]')
    expect(sessionStore.updateSession).toHaveBeenCalledWith('s1', { workspace: 'sub' })
  })

  it('lets the stored binding win over a conflicting request workspace', async () => {
    sessionStore.getSession.mockReturnValue({ id: 's1', profile: 'default', workspace: 'work', message_count: 5 } as any)
    let body: any
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body || '{}'))
      return { ok: true, status: 200, body: sseStream('event: done\ndata: {"kind":"done","run_id":"r"}\n\n') } as any
    }))

    await handleBrokerRun(socket, { input: 'hi', session_id: 's1', workspace: 'sub' }, 'default', 'rm', vi.fn(), fakeContext())

    expect(body.workspace).toBe('work')
    expect(sessionStore.updateSession).not.toHaveBeenCalled()
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
      .mockReturnValueOnce({ id: 's1', profile: 'default', workspace: 'work' })
      .mockReturnValue({ id: 's1', profile: 'default', workspace: 'work' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const pending = handleBrokerRun(
      socket,
      { input: 'hi', session_id: 's1', workspace: 'work' },
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
      expect.objectContaining({ role: 'assistant', content: 'hello', run_id: 'run-live', finish_reason: 'stop' }),
    ])
  })

  it('publishes a terminal MEDIA artifact into persisted state and the live completion payload', async () => {
    profileRoot.value = mkdtempSync(join(tmpdir(), 'broker-publication-'))
    mkdirSync(join(profileRoot.value, 'workspace'), { recursive: true })
    writeFileSync(join(profileRoot.value, 'workspace', 'live.html'), '<p>live</p>')
    const state = { messages: [], isWorking: false, events: [], queue: [], runId: undefined, abortController: undefined } as any
    let persistedContent = ''
    const context = {
      sessionMap: new Map([['s1', state]]),
      getOrCreateSession: () => state,
      getResponseRunState: () => ({ runMarker: 'rm', responseId: undefined, insertedKeys: new Set(), toolCalls: new Map() }),
      markCompleted: vi.fn(async () => {
        persistedContent = state.messages.at(-1)?.content || ''
        return { finalized: true }
      }),
      abandonRun: vi.fn(() => true),
      dequeueNextQueuedRun: vi.fn(() => true),
      buildInput: (value: any) => value,
      publishRunAssistantMedia: (_sid: string, marker: string, _profile: string, fallback: string) => (
        publishRunAssistantMedia({ messages: state.messages, runMarker: marker, profileDir: profileRoot.value, fallbackContent: fallback })
      ),
    } as any
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      body: sseStream(
        'event: content\ndata: {"kind":"content","run_id":"run-publication","text":"MEDIA:/workspace/live.html"}\n\n',
        'event: done\ndata: {"kind":"done","run_id":"run-publication","output":"MEDIA:/workspace/live.html"}\n\n',
      ),
    })))
    const emit = vi.fn()

    await handleBrokerRun(socket, { input: 'publish', session_id: 's1' }, 'default', 'rm', emit, context)

    const expected = '[live.html](/workspace/live.html?hermes_mime=text%2Fhtml&hermes_bytes=11)'
    expect(persistedContent).toBe(expected)
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      parsed_content: expected,
      output: expected,
    }))
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
    expect(sessionStore.updateSession).not.toHaveBeenCalled()
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

  it('rejects a stored workspace pointing at another profile before dispatch', async () => {
    sessionStore.getSession.mockReturnValueOnce({ id: 's1', profile: 'default', workspace: '/tmp/other-profile/workspace' } as any)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await handleBrokerRun(socket, { input: 'hi', session_id: 's1', workspace: 'sub' }, 'default', 'rm', vi.fn(), fakeContext())

    expect(fetchMock).not.toHaveBeenCalled()
    expect(workspaceDiffTracker.start).not.toHaveBeenCalled()
  })

  it('rejects broker payload workspaces outside the profile workspace before dispatch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await handleBrokerRun(socket, { input: 'hi', session_id: 's1', workspace: '/tmp/escape' }, 'default', 'rm', vi.fn(), fakeContext())

    expect(fetchMock).not.toHaveBeenCalled()
    expect(workspaceDiffTracker.start).not.toHaveBeenCalled()
  })

  it('rejects a contained payload path that resolves through a symlink escape before dispatch', async () => {
    pathSecurity.isNearestExistingRealPathWithin.mockResolvedValue(false)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await handleBrokerRun(socket, { input: 'hi', session_id: 's1', workspace: '/tmp/workspace/escape' }, 'default', 'rm', vi.fn(), fakeContext())

    expect(pathSecurity.isNearestExistingRealPathWithin).toHaveBeenCalledWith('/tmp/workspace/escape', '/tmp/workspace')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(workspaceDiffTracker.start).not.toHaveBeenCalled()
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

  it('persists and authorizes sources when the final answer arrives only in done output', async () => {
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
        'event: done\ndata: {"kind":"done","run_id":"run-output","text":"Output-only final","source_refs":[{"id":"guide","type":"web","label":"Guide","uri":"https://example.com/guide"}]}\n\n',
      ),
    })))
    const emit = vi.fn()

    await handleBrokerRun(socket, { input: 'hi', session_id: 's1' }, 'default', 'rm', emit, context)

    expect(state.messages).toEqual([expect.objectContaining({
      role: 'assistant',
      content: 'Output-only final',
      run_id: 'run-output',
      source_refs: [{ id: 'guide', type: 'web', label: 'Guide', uri: 'https://example.com/guide' }],
    })])
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      output: 'Output-only final',
      source_refs: [{ id: 'guide', type: 'web', label: 'Guide', uri: 'https://example.com/guide' }],
    }))
  })
})
