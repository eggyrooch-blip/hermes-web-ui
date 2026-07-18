import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSessionDetail: vi.fn(),
  createSession: vi.fn(),
  addMessage: vi.fn(),
  updateSession: vi.fn(),
  updateSessionStats: vi.fn(),
  getSessionRowId: vi.fn(),
  getSessionIncarnation: vi.fn(),
}))
const tracker = vi.hoisted(() => ({
  start: vi.fn(),
  complete: vi.fn(),
  discard: vi.fn(),
}))

vi.mock('../../packages/server/src/config', () => ({
  config: {
    authMode: 'token',
    uploadDir: '/tmp/uploads',
    webuiRunBroker: true,
    runBrokerUrl: 'http://broker.test',
    runBrokerKey: 'secret',
  },
}))
vi.mock('../../packages/server/src/db/hermes/session-store', () => store)
vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  getSessionDetailFromDb: vi.fn(async () => null),
  getSessionDetailFromDbWithProfile: vi.fn(async () => null),
}))
vi.mock('../../packages/server/src/db/hermes/compression-snapshot', () => ({
  getCompressionSnapshot: vi.fn(() => null),
}))
vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({ updateUsage: vi.fn() }))
vi.mock('../../packages/server/src/lib/context-compressor', () => ({
  ChatContextCompressor: vi.fn(),
  SUMMARY_PREFIX: '[Previous context summary]',
  countTokens: vi.fn(() => 0),
}))
vi.mock('../../packages/server/src/lib/llm-prompt', () => ({ getSystemPrompt: vi.fn(() => '') }))
vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../packages/server/src/services/feishu-oauth', () => ({
  extractFeishuSessionFromCookieHeader: vi.fn(),
  getFeishuSessionSecret: vi.fn(() => 'secret'),
  parseFeishuSessionCookie: vi.fn(),
}))
vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: vi.fn(() => '/tmp/hermes-profile'),
}))
vi.mock('../../packages/server/src/services/hermes/agent-ownership', () => ({
  ownerOwnsProfile: vi.fn(() => false),
  resolveOwnedProfileAgentId: vi.fn(),
}))
vi.mock('../../packages/server/src/services/compat-user', () => ({
  ensureWebUserForFeishu: vi.fn(() => ({ id: 1 })),
}))
vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  authenticateUserToken: vi.fn(),
  isAuthEnabled: vi.fn(async () => false),
}))
vi.mock('../../packages/server/src/db/hermes/users-store', () => ({
  userCanAccessProfile: vi.fn(() => true),
}))
vi.mock('../../packages/server/src/services/hermes/model-context', () => ({
  getModelContextLength: vi.fn(() => 200000),
}))
vi.mock('../../packages/server/src/services/hermes/run-chat/workspace', () => ({
  ensureHermesRunWorkspace: vi.fn(async () => '/tmp/workspace'),
}))
vi.mock('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker', () => ({
  startWorkspaceRunCheckpoint: tracker.start,
  completeWorkspaceRunCheckpoint: tracker.complete,
  discardWorkspaceRunCheckpoint: tracker.discard,
}))

import { BrokerRunController } from '../../packages/server/src/services/hermes/broker-controller'
import { config } from '../../packages/server/src/config'

function sseDone(runId = 'run-1', output = ''): ReadableStream<Uint8Array> {
  const data = JSON.stringify({ kind: 'done', run_id: runId, ...(output ? { text: output } : {}) })
  const bytes = new TextEncoder().encode(`event: done\ndata: ${data}\n\n`)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function sseFrames(frames: Array<{ event: string; data: Record<string, unknown> }>): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(frames
    .map(frame => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)
    .join(''))
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function controlledSse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start: value => { controller = value } })
  return {
    stream,
    send(event: string, data: Record<string, unknown>) {
      controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
    },
    close() {
      controller.close()
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeHarness() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const emitted: Array<{ event: string; payload: any }> = []
  const nsp = {
    adapter: { rooms: new Map() },
    to: vi.fn(() => ({
      emit: (event: string, payload: any) => emitted.push({ event, payload }),
    })),
  }
  const socket = {
    id: 'socket-1',
    connected: true,
    data: { profile: 'research', user: { openid: 'ou_test' } },
    handshake: { query: { profile: 'research' }, auth: {}, headers: {} },
    join: vi.fn(),
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
  }
  const controller = new BrokerRunController()
  ;(controller as any).nsp = nsp
  ;(controller as any).onConnection(socket)
  return { controller, emitted, handlers, socket }
}

function parkCredentialRun(controller: BrokerRunController, runId = 'parked-run') {
  const state = (controller as any).getOrCreateSession('s1', 'research')
  state.parkedCredentialRuns ||= new Map()
  state.parkedCredentialRuns.set(runId, {
    rowId: 1,
    incarnation: 1,
    resumeEvent: {
      id: `credential-${runId}`,
      event: 'auth.required',
      data: {
        event: 'auth.required',
        session_id: 's1',
        run_id: runId,
        connector_id: 'connector-1',
        provider: 'feishu',
      },
    },
  })
  return state
}

async function waitForSecondFetch(fetchMock: ReturnType<typeof vi.fn>) {
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
}

describe('BrokerRunController run lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    config.webuiRunBroker = true
    store.getSession.mockReturnValue({ id: 's1', profile: 'research', workspace: '/tmp/workspace' })
    store.getSessionDetail.mockReturnValue({ id: 's1', profile: 'research', source: 'api_server', messages: [] })
    store.getSessionRowId.mockReturnValue(1)
    store.getSessionIncarnation.mockReturnValue(1)
    tracker.start.mockResolvedValue({ key: 'checkpoint' })
    tracker.complete.mockResolvedValue(null)
  })

  it('abandons only the exact HTTP-deleted generation without waiting for a socket abort', async () => {
    let upstreamSignal: AbortSignal | undefined
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      upstreamSignal = init?.signal || undefined
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { controller, handlers } = makeHarness()

    const running = handlers.get('run')!({ input: 'keep working', session_id: 's1', queue_id: 'run-1' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const activeState = (controller as any).getSessionState('s1', 'research')

    expect(controller.abandonSessionRun('s1', 'research', { rowId: 1, incarnation: 2 })).toBe(false)
    expect(upstreamSignal?.aborted).toBe(false)
    expect((controller as any).getSessionState('s1', 'research')).toBe(activeState)

    expect(controller.abandonSessionRun('s1', 'research', { rowId: 1, incarnation: 1 })).toBe(true)
    expect(upstreamSignal?.aborted).toBe(true)
    await running

    expect((controller as any).getSessionState('s1', 'research')).toBeUndefined()
    expect(activeState).toMatchObject({
      isWorking: false,
      activeRunMarker: undefined,
      abortController: undefined,
      queue: [],
    })
  })

  it('starts a recreated generation through the public socket instead of queueing it on the old state', async () => {
    const checkpoint = deferred<{ key: string }>()
    tracker.start.mockReturnValueOnce(checkpoint.promise)
    const recreatedRun = deferred<any>()
    const fetchMock = vi.fn().mockReturnValueOnce(recreatedRun.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, handlers, socket } = makeHarness()

    const oldRun = handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })
    await vi.waitFor(() => expect(tracker.start).toHaveBeenCalled())
    const oldState = (controller as any).getSessionState('s1', 'research')
    oldState.queue.push({ queue_id: 'old-queued', input: 'old', profile: 'research' })
    store.getSessionRowId.mockReturnValue(2)
    store.getSessionIncarnation.mockReturnValue(2)
    const newRun = handlers.get('run')!({ input: 'new generation', session_id: 's1', queue_id: 'new' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const recreated = (controller as any).getSessionState('s1', 'research')
    expect(recreated).not.toBe(oldState)
    expect(recreated).toMatchObject({ isWorking: true, queue: [], sessionRowId: 2, sessionIncarnation: 2 })

    checkpoint.resolve({ key: 'checkpoint' })
    await oldRun

    expect(oldState).toMatchObject({ isWorking: false, queue: [], activeRunMarker: undefined })
    expect((controller as any).getSessionState('s1', 'research')).toBe(recreated)
    expect(recreated).toMatchObject({ isWorking: true, queue: [] })
    expect(tracker.discard).toHaveBeenCalled()
    expect(socket.emit).not.toHaveBeenCalledWith('run.failed', expect.anything())
    recreatedRun.resolve({ ok: true, status: 200, body: sseDone('run-new') })
    await newRun
    expect(recreated.isWorking).toBe(false)
  })

  it('aborts and releases a hanging old upstream as soon as same-id admission sees a new generation', async () => {
    const replacementRun = deferred<any>()
    let oldSignal: AbortSignal | undefined
    const fetchMock = vi.fn()
      .mockImplementationOnce((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        oldSignal = init?.signal || undefined
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }))
      .mockReturnValueOnce(replacementRun.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, handlers, socket } = makeHarness()

    const oldRun = handlers.get('run')!({ input: 'old generation', session_id: 's1', queue_id: 'old' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const oldState = (controller as any).getSessionState('s1', 'research')
    oldState.queue.push({ queue_id: 'must-drop', input: 'stale queued', profile: 'research' })
    store.getSessionRowId.mockReturnValue(2)
    store.getSessionIncarnation.mockReturnValue(2)

    const replacement = handlers.get('run')!({ input: 'replacement', session_id: 's1', queue_id: 'replacement' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await oldRun

    const current = (controller as any).getSessionState('s1', 'research')
    expect(oldSignal?.aborted).toBe(true)
    expect(oldState).toMatchObject({
      isWorking: false,
      activeRunMarker: undefined,
      abortController: undefined,
      queue: [],
    })
    expect(current).not.toBe(oldState)
    expect(current).toMatchObject({ isWorking: true, sessionRowId: 2, sessionIncarnation: 2 })

    replacementRun.resolve({ ok: true, status: 200, body: sseDone('run-replacement') })
    await replacement
    expect(current.isWorking).toBe(false)
  })

  it('rebinds a brand-new session before broker dispatch without replacing its first user state', async () => {
    let exists = false
    let stateAtCreate: any
    const response = deferred<any>()
    store.getSession.mockImplementation(() => exists
      ? { id: 'new-session', profile: 'research', workspace: '/tmp/workspace' }
      : null)
    store.getSessionRowId.mockImplementation(() => exists ? 1 : null)
    store.getSessionIncarnation.mockImplementation(() => exists ? 1 : null)
    const fetchMock = vi.fn().mockReturnValue(response.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, handlers, socket } = makeHarness()
    store.createSession.mockImplementation(() => {
      exists = true
      stateAtCreate = (controller as any).getSessionState('new-session', 'research')
    })

    const pending = handlers.get('run')!({ input: 'first user message', session_id: 'new-session', queue_id: 'first' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const current = (controller as any).getSessionState('new-session', 'research')
    expect(current).toBe(stateAtCreate)
    expect(current).toMatchObject({ sessionRowId: 1, sessionIncarnation: 1, isWorking: true })
    expect(current.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'first user message' }),
    ]))

    response.resolve({ ok: true, status: 200, body: sseDone('run-new') })
    await pending
    expect(current.isWorking).toBe(false)
  })

  it('does not let a delayed resume load overwrite a concurrently admitted live run', async () => {
    const loaded = deferred<any>()
    const activeRun = deferred<any>()
    const fetchMock = vi.fn().mockReturnValue(activeRun.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, handlers, socket } = makeHarness()
    vi.spyOn(controller as any, 'loadSessionStateFromDb').mockReturnValueOnce(loaded.promise)

    const resume = (controller as any).resumeSession(socket, 's1', 'research')
    await new Promise(resolve => setTimeout(resolve, 0))
    const running = handlers.get('run')!({ input: 'live', session_id: 's1', queue_id: 'live' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const liveState = (controller as any).getSessionState('s1', 'research')

    loaded.resolve({ messages: [{ role: 'user', content: 'stale' }], isWorking: false, events: [], queue: [] })
    await resume

    expect((controller as any).getSessionState('s1', 'research')).toBe(liveState)
    expect(liveState.isWorking).toBe(true)
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 's1',
      isWorking: true,
    }))
    activeRun.resolve({ ok: true, status: 200, body: sseDone('run-live') })
    await running
  })

  it('does not let a delayed replay load overwrite or start beside a concurrently admitted live run', async () => {
    const loaded = deferred<any>()
    const activeRun = deferred<any>()
    const urls: string[] = []
    const fetchMock = vi.fn((url: string) => {
      urls.push(String(url))
      return activeRun.promise
    })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, handlers, socket } = makeHarness()
    vi.spyOn(controller as any, 'loadSessionStateFromDb').mockReturnValueOnce(loaded.promise)

    const replay = (controller as any).handleReplay(socket, 's1', 'parked-run', 'research')
    await new Promise(resolve => setTimeout(resolve, 0))
    const running = handlers.get('run')!({ input: 'live', session_id: 's1', queue_id: 'live' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const liveState = (controller as any).getSessionState('s1', 'research')
    liveState.parkedCredentialRuns = new Map([['parked-run', {
      rowId: 1,
      incarnation: 1,
      resumeEvent: {
        id: 'credential-parked-run',
        event: 'auth.required',
        data: { event: 'auth.required', session_id: 's1', run_id: 'parked-run' },
      },
    }]])

    loaded.resolve({ messages: [{ role: 'user', content: 'stale' }], isWorking: false, events: [], queue: [] })
    await replay

    expect((controller as any).getSessionState('s1', 'research')).toBe(liveState)
    expect(liveState.isWorking).toBe(true)
    expect(urls.filter(url => url.includes('/credentials/replay/'))).toHaveLength(0)
    activeRun.resolve({ ok: true, status: 200, body: sseDone('run-live') })
    await running
  })

  it('ignores public credential replay after the session was deleted', async () => {
    store.getSession.mockReturnValue(null)
    store.getSessionDetail.mockReturnValue(null)
    store.getSessionRowId.mockReturnValue(null)
    store.getSessionIncarnation.mockReturnValue(null)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { controller, handlers, socket } = makeHarness()

    await handlers.get('credential.replay')!({
      session_id: 's1',
      run_id: 'parked-run',
      connector_id: 'connector-1',
      provider: 'feishu',
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.createSession).not.toHaveBeenCalled()
    expect(store.addMessage).not.toHaveBeenCalled()
    expect((controller as any).getSessionState('s1', 'research')).toBeUndefined()
    expect(socket.emit).toHaveBeenCalledWith('run.reattach_failed', expect.objectContaining({
      session_id: 's1',
      run_id: 'parked-run',
      terminal: true,
    }))
  })

  it('restores the authoritative auth card before a pre-dispatch failure and allows retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: sseDone('replayed-run'),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers, socket } = makeHarness()
    const state = parkCredentialRun(controller)
    const originalId = state.parkedCredentialRuns.get('parked-run').resumeEvent.id
    handlers.get('resume.events.ack')!({ session_id: 's1', event_ids: [originalId] })
    store.getSessionRowId.mockImplementation(() => { throw new Error('identity database unavailable') })
    socket.emit.mockClear()

    await handlers.get('credential.replay')!({ session_id: 's1', run_id: 'parked-run' })

    expect(fetchMock).not.toHaveBeenCalled()
    const renewed = state.parkedCredentialRuns.get('parked-run').resumeEvent
    expect(renewed.id).not.toBe(originalId)
    expect(renewed).toMatchObject({
      id: expect.any(String),
      event: 'auth.required',
      data: {
        event: 'auth.required',
        session_id: 's1',
        run_id: 'parked-run',
        connector_id: 'connector-1',
        provider: 'feishu',
        resume_event_id: expect.any(String),
      },
    })
    expect(renewed.acknowledgedSocketIds).toBeUndefined()
    expect(emitted.at(-1)).toMatchObject({
      event: 'auth.required',
      payload: { resume_event_id: renewed.id },
    })
    expect(socket.emit.mock.calls.map(call => call[0])).toEqual([
      'auth.required',
      'run.reattach_failed',
    ])
    expect(socket.emit).toHaveBeenCalledWith('run.reattach_failed', expect.objectContaining({
      session_id: 's1',
      run_id: 'parked-run',
      terminal: true,
      error: 'identity database unavailable',
    }))

    store.getSessionRowId.mockReturnValue(1)
    socket.emit.mockClear()
    await handlers.get('credential.replay')!({ session_id: 's1', run_id: 'parked-run' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/credentials/replay/parked-run')
    expect(state.parkedCredentialRuns.has('parked-run')).toBe(false)
  })

  it('bounds generation-bound credential cards and consumes only the replayed run id', async () => {
    const parkedRunIds = Array.from({ length: 22 }, (_, index) => `parked-${index}`)
    const initialFrames = parkedRunIds.map(runId => ({
      event: 'auth_required',
      data: { kind: 'auth_required', run_id: runId, connector_id: 'connector-1', provider: 'feishu' },
    }))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: sseFrames([
          ...initialFrames,
          { event: 'done', data: { kind: 'done', run_id: 'original-run' } },
        ]),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, body: sseDone('replayed-run') })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, handlers, socket } = makeHarness()

    await handlers.get('run')!({ input: 'needs auth', session_id: 's1', queue_id: 'initial' })

    const state = (controller as any).getSessionState('s1', 'research')
    expect([...state.parkedCredentialRuns.keys()]).toEqual(parkedRunIds.slice(-20))

    await handlers.get('credential.replay')!({ session_id: 's1', run_id: parkedRunIds.at(-1) })

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(`/credentials/replay/${parkedRunIds.at(-1)}`)
    expect(state.parkedCredentialRuns.has(parkedRunIds.at(-1))).toBe(false)
    expect(state.parkedCredentialRuns.size).toBe(19)

    await handlers.get('resume')!({ session_id: 's1' })
    const resumedAfterReplay = socket.emit.mock.calls.filter(call => call[0] === 'resumed').at(-1)?.[1]
    expect(resumedAfterReplay.events).not.toContainEqual(expect.objectContaining({
      event: 'auth.required',
      data: expect.objectContaining({ run_id: parkedRunIds.at(-1) }),
    }))

    socket.emit.mockClear()
    await handlers.get('credential.replay')!({ session_id: 's1', run_id: parkedRunIds.at(-1) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(socket.emit).toHaveBeenCalledWith('run.reattach_failed', expect.objectContaining({
      run_id: parkedRunIds.at(-1),
      error: 'Credential replay is no longer available',
    }))
  })

  it('keeps auth.required resumable after done and hides it from the acknowledging socket', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: sseFrames([
        {
          event: 'auth_required',
          data: { kind: 'auth_required', run_id: 'parked-run', connector_id: 'connector-1', provider: 'feishu' },
        },
        { event: 'done', data: { kind: 'done', run_id: 'original-run' } },
      ]),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { emitted, handlers, socket } = makeHarness()

    await handlers.get('run')!({ input: 'needs auth', session_id: 's1', queue_id: 'initial' })

    const liveAuth = emitted.find(item => item.event === 'auth.required')?.payload
    expect(liveAuth).toMatchObject({
      session_id: 's1',
      run_id: 'parked-run',
      session_row_id: 1,
      session_incarnation: 1,
      resume_event_id: expect.any(String),
    })

    socket.emit.mockClear()
    await handlers.get('resume')!({ session_id: 's1' })
    const firstResume = socket.emit.mock.calls.filter(call => call[0] === 'resumed').at(-1)?.[1]
    const replayedAuth = firstResume.events.find((event: any) => event.event === 'auth.required')
    expect(replayedAuth).toMatchObject({
      id: liveAuth.resume_event_id,
      data: expect.objectContaining({
        event: 'auth.required',
        session_id: 's1',
        run_id: 'parked-run',
        session_row_id: 1,
        session_incarnation: 1,
        resume_event_id: liveAuth.resume_event_id,
      }),
    })

    handlers.get('resume.events.ack')!({ session_id: 's1', event_ids: [replayedAuth.id] })
    await handlers.get('resume')!({ session_id: 's1' })
    const acknowledgedResume = socket.emit.mock.calls.filter(call => call[0] === 'resumed').at(-1)?.[1]
    expect(acknowledgedResume.events).not.toContainEqual(expect.objectContaining({ id: replayedAuth.id }))
  })

  it('rotates the stable auth card id when replay is deferred behind a working sibling', async () => {
    const activeRun = deferred<any>()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: sseFrames([
          {
            event: 'auth_required',
            data: { kind: 'auth_required', run_id: 'parked-run', connector_id: 'connector-1', provider: 'feishu' },
          },
          { event: 'done', data: { kind: 'done', run_id: 'original-run' } },
        ]),
      })
      .mockReturnValueOnce(activeRun.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers, socket } = makeHarness()
    await handlers.get('run')!({ input: 'needs auth', session_id: 's1', queue_id: 'initial' })
    const state = (controller as any).getSessionState('s1', 'research')
    const originalId = state.parkedCredentialRuns.get('parked-run').resumeEvent.id
    handlers.get('resume.events.ack')!({ session_id: 's1', event_ids: [originalId] })

    const sibling = handlers.get('run')!({ input: 'active sibling', session_id: 's1', queue_id: 'sibling' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await handlers.get('credential.replay')!({
      session_id: 's1',
      run_id: 'parked-run',
      connector_id: 'tampered-connector',
      provider: 'tampered-provider',
    })

    const renewed = state.parkedCredentialRuns.get('parked-run').resumeEvent
    expect(renewed.id).not.toBe(originalId)
    expect(renewed.acknowledgedSocketIds).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(emitted.filter(item => item.event === 'auth.required').at(-1)?.payload).toMatchObject({
      run_id: 'parked-run',
      connector_id: 'connector-1',
      provider: 'feishu',
      resume_event_id: renewed.id,
    })

    socket.emit.mockClear()
    await handlers.get('resume')!({ session_id: 's1' })
    const resumed = socket.emit.mock.calls.find(call => call[0] === 'resumed')?.[1]
    expect(resumed.events).toContainEqual(expect.objectContaining({ id: renewed.id, event: 'auth.required' }))

    activeRun.resolve({ ok: true, status: 200, body: sseDone('sibling-run') })
    await sibling
  })

  it('broadcasts an accepted replay resolution and resumes it until each socket acknowledges', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: sseDone('replayed-run'),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers, socket } = makeHarness()
    const state = parkCredentialRun(controller)
    const secondHandlers = new Map<string, (...args: any[]) => any>()
    const secondSocket = {
      id: 'socket-2',
      connected: true,
      data: { profile: 'research', user: { openid: 'ou_test' } },
      handshake: { query: { profile: 'research' }, auth: {}, headers: {} },
      join: vi.fn(),
      emit: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => any) => secondHandlers.set(event, handler)),
    }
    ;(controller as any).onConnection(secondSocket)

    await handlers.get('credential.replay')!({ session_id: 's1', run_id: 'parked-run' })

    const liveResolved = emitted.find(item => item.event === 'auth.resolved')?.payload
    expect(liveResolved).toMatchObject({
      event: 'auth.resolved',
      session_id: 's1',
      run_id: 'parked-run',
      session_row_id: 1,
      session_incarnation: 1,
      resume_event_id: expect.any(String),
    })
    expect(state.parkedCredentialRuns.has('parked-run')).toBe(false)

    socket.emit.mockClear()
    secondSocket.emit.mockClear()
    handlers.get('resume')!({ session_id: 's1' })
    secondHandlers.get('resume')!({ session_id: 's1' })
    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith('resumed', expect.anything())
      expect(secondSocket.emit).toHaveBeenCalledWith('resumed', expect.anything())
    })
    const firstResume = socket.emit.mock.calls.find(call => call[0] === 'resumed')?.[1]
    const secondResume = secondSocket.emit.mock.calls.find(call => call[0] === 'resumed')?.[1]
    expect(firstResume.events).toContainEqual(expect.objectContaining({
      id: liveResolved.resume_event_id,
      event: 'auth.resolved',
    }))
    expect(secondResume.events).toContainEqual(expect.objectContaining({
      id: liveResolved.resume_event_id,
      event: 'auth.resolved',
    }))

    handlers.get('resume.events.ack')!({ session_id: 's1', event_ids: [liveResolved.resume_event_id] })
    socket.emit.mockClear()
    secondSocket.emit.mockClear()
    handlers.get('resume')!({ session_id: 's1' })
    secondHandlers.get('resume')!({ session_id: 's1' })
    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith('resumed', expect.anything())
      expect(secondSocket.emit).toHaveBeenCalledWith('resumed', expect.anything())
    })
    const acknowledgedResume = socket.emit.mock.calls.find(call => call[0] === 'resumed')?.[1]
    const unacknowledgedResume = secondSocket.emit.mock.calls.find(call => call[0] === 'resumed')?.[1]
    expect(acknowledgedResume.events).not.toContainEqual(expect.objectContaining({ id: liveResolved.resume_event_id }))
    expect(unacknowledgedResume.events).toContainEqual(expect.objectContaining({ id: liveResolved.resume_event_id }))

    secondHandlers.get('resume.events.ack')!({ session_id: 's1', event_ids: [liveResolved.resume_event_id] })
    expect(state.pendingTerminalEvents.find((event: any) => event.id === liveResolved.resume_event_id)
      ?.acknowledgedSocketIds).toEqual(new Set(['socket-1', 'socket-2']))
  })

  it('replays a broker-unavailable failure with the same terminal id until this socket acknowledges it', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: sseFrames([
        {
          event: 'auth_required',
          data: { kind: 'auth_required', run_id: 'parked-run', connector_id: 'connector-1', provider: 'feishu' },
        },
        { event: 'done', data: { kind: 'done', run_id: 'original-run' } },
      ]),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { handlers, socket } = makeHarness()
    await handlers.get('run')!({ input: 'needs auth', session_id: 's1', queue_id: 'initial' })

    config.webuiRunBroker = false
    socket.emit.mockClear()
    await handlers.get('credential.replay')!({ session_id: 's1', run_id: 'parked-run' })

    const liveFailure = socket.emit.mock.calls.find(call => call[0] === 'run.reattach_failed')?.[1]
    expect(liveFailure).toMatchObject({
      session_id: 's1',
      run_id: 'parked-run',
      terminal: true,
      error: 'Run broker is unavailable',
      resume_event_id: expect.any(String),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await handlers.get('resume')!({ session_id: 's1' })
    const firstResume = socket.emit.mock.calls.filter(call => call[0] === 'resumed').at(-1)?.[1]
    expect(firstResume.events).toContainEqual(expect.objectContaining({
      id: liveFailure.resume_event_id,
      event: 'run.reattach_failed',
      data: expect.objectContaining({ error: 'Run broker is unavailable' }),
    }))

    handlers.get('resume.events.ack')!({ session_id: 's1', event_ids: [liveFailure.resume_event_id] })
    await handlers.get('resume')!({ session_id: 's1' })
    const acknowledgedResume = socket.emit.mock.calls.filter(call => call[0] === 'resumed').at(-1)?.[1]
    expect(acknowledgedResume.events).not.toContainEqual(expect.objectContaining({ id: liveFailure.resume_event_id }))
  })

  it('aborts replay without emitting or persisting after same-id recreation', async () => {
    const upstream = controlledSse()
    let replaySignal: AbortSignal | undefined
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      replaySignal = init?.signal || undefined
      return Promise.resolve({ ok: true, status: 200, body: upstream.stream })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()
    parkCredentialRun(controller)

    const replay = handlers.get('credential.replay')!({ session_id: 's1', run_id: 'parked-run' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const staleState = (controller as any).getSessionState('s1', 'research')
    store.getSession.mockReturnValue({ id: 's1', profile: 'research', workspace: '/tmp/new-workspace' })
    store.getSessionRowId.mockReturnValue(2)
    store.getSessionIncarnation.mockReturnValue(2)
    upstream.send('content', { kind: 'content', run_id: 'old-replay', text: 'must not leak' })
    await replay

    expect(replaySignal?.aborted).toBe(true)
    expect(staleState).toMatchObject({ isWorking: false, activeRunMarker: undefined, events: [] })
    expect((controller as any).getSessionState('s1', 'research')).toBeUndefined()
    expect(emitted.filter(item => item.event === 'message.delta')).toHaveLength(0)
    expect(store.createSession).not.toHaveBeenCalled()
    expect(store.addMessage).not.toHaveBeenCalled()
  })

  it('keeps a brand-new plan command on the same generation-bound state', async () => {
    let exists = false
    let stateAtCreate: any
    const brokerRun = deferred<any>()
    store.getSession.mockImplementation(() => exists
      ? { id: 'command-session', profile: 'research', workspace: '/tmp/workspace' }
      : null)
    store.getSessionRowId.mockImplementation(() => exists ? 1 : null)
    store.getSessionIncarnation.mockImplementation(() => exists ? 1 : null)
    const fetchMock = vi.fn((url: string) => {
      if (String(url).endsWith('/session-commands')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ handled: true, command: 'plan', action: 'plan', kickoff_prompt: 'hidden plan' }),
        })
      }
      return brokerRun.promise
    })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, handlers } = makeHarness()
    store.createSession.mockImplementation(() => {
      exists = true
      stateAtCreate = (controller as any).getSessionState('command-session', 'research')
    })

    const pending = handlers.get('run')!({ input: '/plan build it', session_id: 'command-session' })
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/runs'))).toBe(true))
    const current = (controller as any).getSessionState('command-session', 'research')
    expect(current).toBe(stateAtCreate)
    expect(current).toMatchObject({ sessionRowId: 1, sessionIncarnation: 1, isWorking: true })
    expect(current.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'command', content: '/plan build it' }),
      expect.objectContaining({ role: 'command', content: 'Plan started.' }),
    ]))

    brokerRun.resolve({ ok: true, status: 200, body: sseDone('run-plan') })
    await pending
    expect(current.isWorking).toBe(false)
  })

  it('reports a brand-new command persistence failure after create and still releases its queued run', async () => {
    let exists = false
    const nextRun = deferred<any>()
    store.getSession.mockImplementation(() => exists
      ? { id: 'command-session', profile: 'research', workspace: '/tmp/workspace' }
      : null)
    store.getSessionRowId.mockImplementation(() => exists ? 1 : null)
    store.getSessionIncarnation.mockImplementation(() => exists ? 1 : null)
    store.createSession.mockImplementation(() => { exists = true })
    store.addMessage.mockImplementationOnce(() => { throw new Error('command message failed') })
    const fetchMock = vi.fn().mockReturnValue(nextRun.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()
    const state = (controller as any).getOrCreateSession('command-session', 'research')
    state.queue.push({ queue_id: 'next', input: 'queued user', profile: 'research' })

    await handlers.get('run')!({ input: '/plan build it', session_id: 'command-session', queue_id: 'plan' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    expect(state).toMatchObject({
      isWorking: true,
      sessionRowId: 1,
      sessionIncarnation: 1,
      queue: [],
    })
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'session.command',
        payload: expect.objectContaining({
          ok: false,
          terminal: false,
          message: 'Command failed: command message failed',
        }),
      }),
    ]))
    nextRun.resolve({ ok: true, status: 200, body: sseDone('run-next') })
    await vi.waitFor(() => expect(state.isWorking).toBe(false))
  })

  it.each([
    { label: 'user', input: 'first user', queueId: 'first', failedEvent: 'run.failed' },
    { label: 'command', input: '/plan first', queueId: 'command', failedEvent: 'session.command' },
  ])('rebinds a newly created $label state after a one-time generation read failure and preserves both queued runs', async ({ input, queueId, failedEvent }) => {
    let exists = false
    let failFirstCreatedRead = true
    let runCount = 0
    store.getSession.mockImplementation(() => exists
      ? { id: 'bootstrap-session', profile: 'research', workspace: '/tmp/workspace' }
      : null)
    store.getSessionRowId.mockImplementation(() => {
      if (!exists) return null
      if (failFirstCreatedRead) {
        failFirstCreatedRead = false
        throw new Error('bind identity failed')
      }
      return 1
    })
    store.getSessionIncarnation.mockImplementation(() => exists ? 1 : null)
    store.createSession.mockImplementation(() => { exists = true })
    const fetchMock = vi.fn(async () => {
      runCount++
      return { ok: true, status: 200, body: sseDone(`queued-${runCount}`) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()
    const state = (controller as any).getOrCreateSession('bootstrap-session', 'research')
    state.queue.push(
      { queue_id: 'next-1', input: 'queued one', profile: 'research' },
      { queue_id: 'next-2', input: 'queued two', profile: 'research' },
    )

    await handlers.get('run')!({ input, session_id: 'bootstrap-session', queue_id: queueId })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(state.isWorking).toBe(false))

    expect(state).toMatchObject({
      sessionRowId: 1,
      sessionIncarnation: 1,
      isWorking: false,
      queue: [],
    })
    expect(emitted.filter(item => item.event === failedEvent)).toHaveLength(1)
    expect(store.addMessage).toHaveBeenCalledWith(expect.objectContaining({ client_id: 'next-1' }))
    expect(store.addMessage).toHaveBeenCalledWith(expect.objectContaining({ client_id: 'next-2' }))
  })

  it('silences and aborts a delayed plan result when the session generation is recreated', async () => {
    const replacementRun = deferred<any>()
    let commandSignal: AbortSignal | undefined
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/session-commands')) {
        commandSignal = init?.signal || undefined
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }
      return replacementRun.promise
    })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()

    const command = handlers.get('run')!({ input: '/plan old generation', session_id: 's1', queue_id: 'plan' })
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/session-commands'))).toBe(true))
    const oldState = (controller as any).getSessionState('s1', 'research')
    store.getSessionRowId.mockReturnValue(2)
    store.getSessionIncarnation.mockReturnValue(2)

    const replacement = handlers.get('run')!({ input: 'new generation', session_id: 's1', queue_id: 'new' })
    await command
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/runs'))).toBe(true))

    const current = (controller as any).getSessionState('s1', 'research')
    expect(commandSignal?.aborted).toBe(true)
    expect(oldState).toMatchObject({ isWorking: false, activeRunMarker: undefined, abortController: undefined })
    expect(current).not.toBe(oldState)
    expect(current).toMatchObject({ isWorking: true, sessionRowId: 2, sessionIncarnation: 2 })
    expect(emitted.filter(item => item.event === 'session.command')).toHaveLength(0)

    replacementRun.resolve({ ok: true, status: 200, body: sseDone('run-new') })
    await replacement
  })

  it('drops the mapped stale command queue when DB generation changes without another socket admission', async () => {
    const commandResult = deferred<any>()
    const urls: string[] = []
    const fetchMock = vi.fn((url: string) => {
      urls.push(String(url))
      return commandResult.promise
    })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()

    const command = handlers.get('run')!({ input: '/plan old generation', session_id: 's1', queue_id: 'plan' })
    await vi.waitFor(() => expect(urls.some(url => url.endsWith('/session-commands'))).toBe(true))
    const oldState = (controller as any).getSessionState('s1', 'research')
    oldState.queue.push({ queue_id: 'stale-next', input: 'must drop', profile: 'research' })
    store.getSessionRowId.mockReturnValue(2)
    store.getSessionIncarnation.mockReturnValue(2)
    commandResult.resolve({
      ok: true,
      json: async () => ({ handled: true, command: 'plan', kickoff_prompt: 'must not run' }),
    })
    await command

    expect(oldState).toMatchObject({ isWorking: false, activeRunMarker: undefined, queue: [] })
    expect((controller as any).getSessionState('s1', 'research')).toBeUndefined()
    expect(urls.filter(url => url.endsWith('/runs'))).toHaveLength(0)
    expect(emitted.filter(item => item.event === 'session.command')).toHaveLength(0)
  })

  it('does not start a hidden plan when abort wins even if command lookup ignores its signal', async () => {
    const commandResult = deferred<any>()
    const urls: string[] = []
    const fetchMock = vi.fn((url: string) => {
      urls.push(String(url))
      return commandResult.promise
    })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers, socket } = makeHarness()

    const command = handlers.get('run')!({ input: '/plan abort me', session_id: 's1', queue_id: 'plan' })
    await vi.waitFor(() => expect(urls.some(url => url.endsWith('/session-commands'))).toBe(true))
    await (controller as any).handleAbort(socket, 's1', 'research')
    commandResult.resolve({
      ok: true,
      json: async () => ({ handled: true, command: 'plan', action: 'plan', kickoff_prompt: 'must not run' }),
    })
    await command

    const state = (controller as any).getSessionState('s1', 'research')
    expect(urls.filter(url => url.endsWith('/runs'))).toHaveLength(0)
    expect(state).toMatchObject({ isWorking: false, isAborting: false, activeRunMarker: undefined })
    expect(emitted.filter(item => item.event === 'abort.completed')).toHaveLength(1)
    expect(emitted.filter(item => item.event === 'session.command' && item.payload?.started)).toHaveLength(0)
  })

  it('completes command abort before surfacing a trailing generation lookup failure', async () => {
    const commandResult = deferred<any>()
    const fetchMock = vi.fn().mockReturnValue(commandResult.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers, socket } = makeHarness()

    const command = handlers.get('run')!({ input: '/plan abort identity', session_id: 's1', queue_id: 'plan' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    store.getSessionRowId.mockImplementation(() => { throw new Error('command identity failed') })
    await (controller as any).handleAbort(socket, 's1', 'research')
    commandResult.resolve({
      ok: true,
      json: async () => ({ handled: true, command: 'plan', kickoff_prompt: 'must not run' }),
    })
    await command

    const liveAbort = emitted.find(item => item.event === 'abort.completed')
    const liveCommandFailure = emitted.find(item => item.event === 'session.command')
    expect(liveAbort?.payload.resume_event_id).toMatch(/^terminal_/)
    expect(liveCommandFailure?.payload.resume_event_id).toMatch(/^terminal_/)
    expect(liveCommandFailure?.payload.resume_event_id).not.toBe(liveAbort?.payload.resume_event_id)
    expect(emitted.filter(item => item.event === 'abort.completed')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ failure_pending: true }) }),
    ])
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'session.command',
        payload: expect.objectContaining({ ok: false, message: 'Command failed: command identity failed' }),
      }),
    ]))
    expect((controller as any).getSessionState('s1', 'research')).toMatchObject({
      isWorking: false,
      isAborting: false,
      activeRunMarker: undefined,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    store.getSessionRowId.mockReturnValue(1)
    store.getSessionIncarnation.mockReturnValue(1)
    await (controller as any).resumeSession(socket, 's1', 'research')
    const resumed = socket.emit.mock.calls.filter(call => call[0] === 'resumed').at(-1)?.[1]
    expect(resumed.events).toEqual([
      expect.objectContaining({
        id: liveAbort?.payload.resume_event_id,
        event: 'abort.completed',
        data: expect.objectContaining({ failure_pending: true }),
      }),
      expect.objectContaining({
        id: liveCommandFailure?.payload.resume_event_id,
        event: 'session.command',
        data: expect.objectContaining({ ok: false, message: 'Command failed: command identity failed' }),
      }),
    ])
  })

  it('reads the latest queue after delayed diff completion and dequeues once', async () => {
    const diff = deferred<null>()
    tracker.complete.mockReturnValueOnce(diff.promise)
    const secondFetch = deferred<any>()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, body: sseDone('run-1') })
      .mockReturnValueOnce(secondFetch.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, handlers } = makeHarness()

    const first = handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })
    await vi.waitFor(() => expect(tracker.complete).toHaveBeenCalled())
    await handlers.get('run')!({ input: 'second', session_id: 's1', queue_id: 'second' })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    diff.resolve(null)
    await first
    await waitForSecondFetch(fetchMock)
    const state = (controller as any).getSessionState('s1', 'research')
    expect(state.isWorking).toBe(true)
    expect(state.queue).toHaveLength(0)
    expect(state.activeRunMarker).toMatch(/^resp_run_/)
    secondFetch.resolve({ ok: true, status: 200, body: sseDone('run-2') })
    await vi.waitFor(() => expect(state.isWorking).toBe(false))
  })

  it('keeps an active plan command behind the current diff and reserves the session through command lookup', async () => {
    const diff = deferred<null>()
    const command = deferred<any>()
    const planRun = deferred<any>()
    const userRun = deferred<any>()
    tracker.complete.mockReturnValueOnce(diff.promise)
    let runCalls = 0
    const urls: string[] = []
    const fetchMock = vi.fn((url: string) => {
      urls.push(String(url))
      if (String(url).endsWith('/session-commands')) return command.promise
      runCalls++
      if (runCalls === 1) return Promise.resolve({ ok: true, status: 200, body: sseDone('run-1') })
      if (runCalls === 2) return planRun.promise
      return userRun.promise
    })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()

    const first = handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })
    await vi.waitFor(() => expect(tracker.complete).toHaveBeenCalled())
    const firstMarker = (controller as any).getSessionState('s1', 'research').activeRunMarker
    await handlers.get('run')!({ input: '/plan build it', session_id: 's1', queue_id: 'plan' })
    expect(runCalls).toBe(1)
    expect((controller as any).getSessionState('s1', 'research')).toMatchObject({
      activeRunMarker: firstMarker,
      queue: [expect.objectContaining({ queue_id: 'plan' })],
    })

    diff.resolve(null)
    await first
    await vi.waitFor(() => expect(urls.some(url => url.endsWith('/session-commands'))).toBe(true))
    const commandState = (controller as any).getSessionState('s1', 'research')
    expect(commandState.activeRunMarker).toMatch(/^command_/)

    await handlers.get('run')!({ input: 'user after plan', session_id: 's1', queue_id: 'user' })
    expect(runCalls).toBe(1)
    expect(commandState.queue).toEqual([expect.objectContaining({ queue_id: 'user' })])
    command.resolve({
      ok: true,
      json: async () => ({ handled: true, command: 'plan', action: 'plan', kickoff_prompt: 'hidden plan' }),
    })

    await vi.waitFor(() => expect(runCalls).toBe(2))
    expect(commandState.activeRunMarker).toMatch(/^resp_run_/)
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'session.command',
        payload: expect.objectContaining({ command: 'plan', terminal: false, started: true }),
      }),
    ]))
    planRun.resolve({ ok: true, status: 200, body: sseDone('run-plan') })
    await vi.waitFor(() => expect(runCalls).toBe(3))
    userRun.resolve({ ok: true, status: 200, body: sseDone('run-user') })
    await vi.waitFor(() => expect(commandState.isWorking).toBe(false))
    expect(urls.filter(url => url.endsWith('/runs'))).toHaveLength(3)
  })

  it('keeps command handlers nonterminal while a no-kickoff plan releases the next queued user run', async () => {
    const command = deferred<any>()
    const userRun = deferred<any>()
    const fetchMock = vi.fn((url: string) => {
      if (String(url).endsWith('/session-commands')) return command.promise
      return userRun.promise
    })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()

    const pending = handlers.get('run')!({ input: '/plan status', session_id: 's1', queue_id: 'plan' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await handlers.get('run')!({ input: 'next user', session_id: 's1', queue_id: 'next' })
    command.resolve({
      ok: true,
      json: async () => ({ handled: false, command: 'plan', action: 'noop', message: 'No plan started.' }),
    })

    await pending
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/runs'))).toBe(true))
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'session.command',
        payload: expect.objectContaining({ terminal: false, started: false }),
      }),
    ]))
    const state = (controller as any).getSessionState('s1', 'research')
    expect(state).toMatchObject({ isWorking: true, queue: [] })
    userRun.resolve({ ok: true, status: 200, body: sseDone('run-user') })
    await vi.waitFor(() => expect(state.isWorking).toBe(false))
  })

  it('keeps an active sibling live when an immediate status command succeeds', async () => {
    const activeRun = deferred<any>()
    const fetchMock = vi.fn((url: string) => {
      if (String(url).endsWith('/session-commands')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ handled: true, command: 'status', action: 'status', message: 'Goal is active.' }),
        })
      }
      return activeRun.promise
    })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()

    const active = handlers.get('run')!({ input: 'active', session_id: 's1', queue_id: 'active' })
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/runs'))).toBe(true))
    const state = (controller as any).getSessionState('s1', 'research')
    const activeMarker = state.activeRunMarker

    await handlers.get('run')!({ input: '/status', session_id: 's1', queue_id: 'status' })

    expect(state).toMatchObject({ isWorking: true, activeRunMarker: activeMarker })
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'session.command',
        payload: expect.objectContaining({ command: 'status', terminal: false }),
      }),
    ]))
    activeRun.resolve({ ok: true, status: 200, body: sseDone('run-active') })
    await active
    expect(state.isWorking).toBe(false)
  })

  it('lets a nonserialized command generation fence abort a hanging stale sibling', async () => {
    const statusResult = deferred<any>()
    let runSignal: AbortSignal | undefined
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/session-commands')) return statusResult.promise
      runSignal = init?.signal || undefined
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()

    const active = handlers.get('run')!({ input: 'active', session_id: 's1', queue_id: 'active' })
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/runs'))).toBe(true))
    const status = handlers.get('run')!({ input: '/status', session_id: 's1', queue_id: 'status' })
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/session-commands'))).toBe(true))
    const oldState = (controller as any).getSessionState('s1', 'research')
    store.getSessionRowId.mockReturnValue(2)
    store.getSessionIncarnation.mockReturnValue(2)
    statusResult.resolve({
      ok: true,
      json: async () => ({ handled: true, command: 'status', action: 'status', message: 'stale' }),
    })

    await status
    await active
    expect(runSignal?.aborted).toBe(true)
    expect(oldState).toMatchObject({ isWorking: false, activeRunMarker: undefined, queue: [] })
    expect((controller as any).getSessionState('s1', 'research')).toBeUndefined()
    expect(emitted.filter(item => item.event === 'session.command')).toHaveLength(0)
  })

  it('rejects command admission identity failure without terminating the active room run', async () => {
    const activeResponse = deferred<any>()
    const fetchMock = vi.fn().mockReturnValue(activeResponse.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers, socket } = makeHarness()

    const active = handlers.get('run')!({ input: 'active', session_id: 's1', queue_id: 'active' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const state = (controller as any).getSessionState('s1', 'research')
    const activeMarker = state.activeRunMarker
    store.getSessionRowId.mockImplementationOnce(() => { throw new Error('admission identity failed') })

    await handlers.get('run')!({ input: '/status', session_id: 's1', queue_id: 'status-command' })

    expect(state).toMatchObject({ isWorking: true, activeRunMarker: activeMarker, queue: [] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(emitted.filter(item => item.event === 'run.failed')).toHaveLength(0)
    expect(socket.emit).toHaveBeenCalledWith('run.rejected', expect.objectContaining({
      session_id: 's1',
      queue_id: 'status-command',
      error: 'admission identity failed',
    }))
    expect(emitted.filter(item => item.event === 'session.command')).toHaveLength(0)

    activeResponse.resolve({ ok: true, status: 200, body: sseDone('run-active') })
    await active
    expect(state.isWorking).toBe(false)
  })

  it('fails closed and releases the queue when generation lookup throws inside the stream catch path', async () => {
    const firstResponse = deferred<any>()
    const secondResponse = deferred<any>()
    const fetchMock = vi.fn()
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()

    const first = handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await handlers.get('run')!({ input: 'second', session_id: 's1', queue_id: 'second' })
    store.getSessionRowId.mockImplementationOnce(() => { throw new Error('catch identity failed') })
    firstResponse.reject(new Error('upstream failed'))

    await first
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const state = (controller as any).getSessionState('s1', 'research')
    expect(state).toMatchObject({ isWorking: true, queue: [] })
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'run.failed',
        payload: expect.objectContaining({ error: 'catch identity failed' }),
      }),
    ]))

    secondResponse.resolve({ ok: true, status: 200, body: sseDone('run-second') })
    await vi.waitFor(() => expect(state.isWorking).toBe(false))
  })

  it('keeps the trailing identity failure deliverable after abort completion', async () => {
    const response = deferred<any>()
    const fetchMock = vi.fn().mockReturnValue(response.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers, socket } = makeHarness()

    const pending = handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await (controller as any).handleAbort(socket, 's1', 'research')
    store.getSessionRowId.mockImplementationOnce(() => { throw new Error('abort identity failed') })
    response.reject(new Error('upstream failed'))
    await pending

    expect(emitted.filter(item => item.event === 'abort.completed')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ failure_pending: true }) }),
    ])
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'run.failed',
        payload: expect.objectContaining({ error: 'abort identity failed' }),
      }),
    ]))
    expect((controller as any).getSessionState('s1', 'research')).toMatchObject({
      isWorking: false,
      isAborting: false,
      activeRunMarker: undefined,
    })
  })

  it('finishes abort and replays its failure once when generation lookup keeps throwing', async () => {
    let runSignal: AbortSignal | undefined
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      runSignal = init?.signal || undefined
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers, socket } = makeHarness()

    const pending = handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    store.getSessionRowId.mockImplementation(() => { throw new Error('persistent identity failure') })
    await expect((controller as any).handleAbort(socket, 's1', 'research')).resolves.toBeUndefined()
    await pending

    const liveAbort = emitted.find(item => item.event === 'abort.completed')
    const liveRunFailure = emitted.find(item => item.event === 'run.failed')
    expect(liveAbort?.payload.resume_event_id).toMatch(/^terminal_/)
    expect(liveRunFailure?.payload.resume_event_id).toMatch(/^terminal_/)
    expect(liveRunFailure?.payload.resume_event_id).not.toBe(liveAbort?.payload.resume_event_id)
    expect(runSignal?.aborted).toBe(true)
    expect(emitted.filter(item => item.event === 'abort.started')).toHaveLength(1)
    expect(emitted.filter(item => item.event === 'abort.completed')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ failure_pending: true }) }),
    ])
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'run.failed',
        payload: expect.objectContaining({ error: 'persistent identity failure' }),
      }),
    ]))

    store.getSessionRowId.mockReturnValue(1)
    store.getSessionIncarnation.mockReturnValue(1)
    await (controller as any).resumeSession(socket, 's1', 'research')
    const firstResume = socket.emit.mock.calls.filter(call => call[0] === 'resumed').at(-1)?.[1]
    expect(firstResume?.events).toEqual([
      expect.objectContaining({
        id: liveAbort?.payload.resume_event_id,
        event: 'abort.completed',
        data: expect.objectContaining({ failure_pending: true }),
      }),
      expect.objectContaining({
        id: liveRunFailure?.payload.resume_event_id,
        event: 'run.failed',
        data: expect.objectContaining({ error: 'persistent identity failure' }),
      }),
    ])
    await (controller as any).resumeSession(socket, 's1', 'research')
    const concurrentResume = socket.emit.mock.calls.filter(call => call[0] === 'resumed').at(-1)?.[1]
    expect(concurrentResume.events).toEqual(firstResume.events)
    handlers.get('resume.events.ack')!({
      session_id: 's1',
      event_ids: firstResume.events.map((event: any) => event.id),
    })
    const otherSocket = { ...socket, id: 'socket-2', emit: vi.fn() }
    await (controller as any).resumeSession(otherSocket, 's1', 'research')
    const otherResume = otherSocket.emit.mock.calls.filter(call => call[0] === 'resumed').at(-1)?.[1]
    expect(otherResume.events).toEqual(firstResume.events)
    await (controller as any).resumeSession(socket, 's1', 'research')
    const secondResume = socket.emit.mock.calls.filter(call => call[0] === 'resumed').at(-1)?.[1]
    expect(secondResume?.events).toEqual([])
  })

  it('fails closed when the catch precheck passes but the finish recheck identity lookup throws', async () => {
    const response = deferred<any>()
    tracker.start.mockResolvedValueOnce(null)
    const fetchMock = vi.fn().mockReturnValue(response.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers, socket } = makeHarness()

    const pending = handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await (controller as any).handleAbort(socket, 's1', 'research')
    store.getSessionRowId
      .mockReturnValueOnce(1)
      .mockImplementationOnce(() => { throw new Error('finish identity failed') })
    response.reject(new Error('upstream failed'))
    await pending

    expect(emitted.filter(item => item.event === 'abort.completed')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ failure_pending: true }) }),
    ])
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'run.failed',
        payload: expect.objectContaining({ error: 'finish identity failed' }),
      }),
    ]))
    expect((controller as any).getSessionState('s1', 'research')).toMatchObject({
      isWorking: false,
      isAborting: false,
      activeRunMarker: undefined,
    })
  })

  it('lets the stream own abort finalization until delayed diff completes', async () => {
    const diff = deferred<null>()
    tracker.complete.mockReturnValueOnce(diff.promise)
    const secondFetch = deferred<any>()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, body: sseDone('run-1') })
      .mockReturnValueOnce(secondFetch.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers, socket } = makeHarness()

    const first = handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })
    await vi.waitFor(() => expect(tracker.complete).toHaveBeenCalled())
    const oldMarker = (controller as any).getSessionState('s1', 'research').activeRunMarker
    await handlers.get('run')!({ input: 'second', session_id: 's1', queue_id: 'second' })
    await (controller as any).handleAbort(socket, 's1', 'research')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((controller as any).getSessionState('s1', 'research')).toMatchObject({
      isWorking: true,
      isAborting: true,
    })
    expect(emitted.filter(item => item.event === 'abort.completed')).toHaveLength(0)

    diff.resolve(null)
    await first
    await waitForSecondFetch(fetchMock)
    const state = (controller as any).getSessionState('s1', 'research')
    expect(state.isWorking).toBe(true)
    expect(state.isAborting).toBe(false)
    expect(state.activeRunMarker).not.toBe(oldMarker)
    expect(emitted.filter(item => item.event === 'abort.completed')).toHaveLength(1)
    expect(emitted.filter(item => item.event === 'run.failed' || item.event === 'run.completed')).toHaveLength(0)
    secondFetch.resolve({ ok: true, status: 200, body: sseDone('run-2') })
    await vi.waitFor(() => expect(state.isWorking).toBe(false))
  })

  it('emits only abort.completed when fetch rejects with AbortError and then dequeues', async () => {
    const secondFetch = deferred<any>()
    const fetchMock = vi.fn()
      .mockImplementationOnce((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }))
      .mockReturnValueOnce(secondFetch.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers, socket } = makeHarness()

    const first = handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await handlers.get('run')!({ input: 'second', session_id: 's1', queue_id: 'second' })
    await (controller as any).handleAbort(socket, 's1', 'research')

    await first
    await waitForSecondFetch(fetchMock)
    const state = (controller as any).getSessionState('s1', 'research')
    expect(state).toMatchObject({ isWorking: true, isAborting: false, queue: [] })
    expect(emitted.filter(item => item.event === 'abort.completed')).toHaveLength(1)
    expect(emitted.filter(item => item.event === 'run.failed' || item.event === 'run.completed')).toHaveLength(0)
    secondFetch.resolve({ ok: true, status: 200, body: sseDone('run-2') })
    await vi.waitFor(() => expect(state.isWorking).toBe(false))
  })

  it('reports a finalization error during abort while still releasing the queue', async () => {
    const diff = deferred<null>()
    tracker.complete.mockReturnValueOnce(diff.promise)
    store.updateSessionStats.mockImplementationOnce(() => { throw new Error('abort stats failed') })
    const nextRun = deferred<any>()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, body: sseDone('run-1') })
      .mockReturnValueOnce(nextRun.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers, socket } = makeHarness()

    const first = handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })
    await vi.waitFor(() => expect(tracker.complete).toHaveBeenCalled())
    await handlers.get('run')!({ input: 'second', session_id: 's1', queue_id: 'second' })
    await (controller as any).handleAbort(socket, 's1', 'research')
    diff.resolve(null)

    await first
    await waitForSecondFetch(fetchMock)
    const state = (controller as any).getSessionState('s1', 'research')
    expect(state).toMatchObject({ isWorking: true, isAborting: false, queue: [] })
    expect(emitted.filter(item => item.event === 'abort.completed')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ failure_pending: true }) }),
    ])
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'run.failed',
        payload: expect.objectContaining({ error: 'Run finalization failed: abort stats failed' }),
      }),
    ]))
    expect(emitted.filter(item => item.event === 'run.completed')).toHaveLength(0)
    await (controller as any).resumeSession(socket, 's1', 'research')
    const resumed = socket.emit.mock.calls.filter(call => call[0] === 'resumed').at(-1)?.[1]
    expect(resumed).toMatchObject({ isWorking: true })
    expect(resumed.events).toEqual([
      expect.objectContaining({ event: 'abort.completed', data: expect.objectContaining({ failure_pending: true }) }),
      expect.objectContaining({ event: 'run.failed', data: expect.objectContaining({ error: 'Run finalization failed: abort stats failed' }) }),
    ])
    nextRun.resolve({ ok: true, status: 200, body: sseDone('run-2') })
    await vi.waitFor(() => expect(state.isWorking).toBe(false))
  })

  it('stops emitting old stream frames after the session state is replaced', async () => {
    const upstream = controlledSse()
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, body: upstream.stream }))
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()

    const pending = handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const oldState = (controller as any).getSessionState('s1', 'research')
    oldState.queue.push({ queue_id: 'old-queued', input: 'old', profile: 'research' })
    const recreated = { messages: [], isWorking: false, events: [], queue: [], profile: 'research' }
    ;(controller as any).setSessionState('s1', 'research', recreated)
    store.getSessionRowId.mockReturnValue(2)
    store.getSessionIncarnation.mockReturnValue(2)

    upstream.send('content', { kind: 'content', run_id: 'old-run', text: 'must not leak' })
    await pending

    expect(emitted.map(item => item.event)).not.toContain('message.delta')
    expect(emitted.map(item => item.event)).not.toContain('workspace.diff.completed')
    expect(oldState).toMatchObject({ isWorking: false, queue: [], activeRunMarker: undefined })
    expect((controller as any).getSessionState('s1', 'research')).toBe(recreated)
    expect(recreated).toMatchObject({ messages: [], isWorking: false, queue: [] })
  })

  it('does not emit old usage after a replacement generation starts', async () => {
    const usage = deferred<any>()
    const replacementRun = deferred<any>()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, body: sseDone('run-1') })
      .mockReturnValueOnce(replacementRun.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()
    const usageSpy = vi.spyOn(controller as any, 'getSessionDetailForProfile')
      .mockReturnValueOnce(usage.promise)
      .mockReturnValue({ id: 's1', source: 'api_server', profile: 'research', messages: [] })

    const first = handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })
    await vi.waitFor(() => expect(usageSpy).toHaveBeenCalled())
    const oldState = (controller as any).getSessionState('s1', 'research')
    store.getSessionRowId.mockReturnValue(2)
    store.getSessionIncarnation.mockReturnValue(2)
    const replacement = handlers.get('run')!({ input: 'replacement', session_id: 's1', queue_id: 'replacement' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const newState = (controller as any).getSessionState('s1', 'research')
    expect(newState).not.toBe(oldState)

    usage.resolve({ id: 's1', source: 'api_server', profile: 'research', messages: [] })
    await first
    expect(emitted.filter(item => item.event === 'usage.updated')).toHaveLength(0)
    expect(newState).toMatchObject({ isWorking: true, sessionRowId: 2, sessionIncarnation: 2 })

    replacementRun.resolve({ ok: true, status: 200, body: sseDone('run-2') })
    await replacement
    expect(newState.isWorking).toBe(false)
  })

  it('does not start a goal continuation beside a user queued during goal evaluation', async () => {
    const goal = deferred<any>()
    const userRun = deferred<any>()
    const urls: string[] = []
    let runCalls = 0
    const fetchMock = vi.fn((url: string) => {
      urls.push(String(url))
      if (String(url).endsWith('/goals/evaluate')) return goal.promise
      runCalls++
      if (runCalls === 1) return Promise.resolve({ ok: true, status: 200, body: sseDone('run-1', 'continue') })
      return userRun.promise
    })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, handlers } = makeHarness()

    const first = handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })
    await vi.waitFor(() => expect(urls.some(url => url.endsWith('/goals/evaluate'))).toBe(true))
    await handlers.get('run')!({ input: 'user follow-up', session_id: 's1', queue_id: 'user-next' })
    goal.resolve({
      ok: true,
      json: async () => ({ should_continue: true, continuation_prompt: 'hidden goal continuation' }),
    })

    await first
    await vi.waitFor(() => expect(runCalls).toBe(2))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(runCalls).toBe(2)
    const state = (controller as any).getSessionState('s1', 'research')
    expect(state.isWorking).toBe(true)
    expect(state.queue).toHaveLength(0)
    userRun.resolve({ ok: true, status: 200, body: sseDone('run-2') })
    await vi.waitFor(() => expect(state.isWorking).toBe(false))
  })

  it('serializes an idle goal continuation through the session queue', async () => {
    const continuationRun = deferred<any>()
    const urls: string[] = []
    let runCalls = 0
    const fetchMock = vi.fn((url: string) => {
      urls.push(String(url))
      if (String(url).endsWith('/goals/evaluate')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            should_continue: true,
            continuation_prompt: 'hidden goal continuation',
          }),
        })
      }
      runCalls++
      if (runCalls === 1) return Promise.resolve({ ok: true, status: 200, body: sseDone('run-1', 'continue') })
      return continuationRun.promise
    })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()

    await handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })
    await vi.waitFor(() => expect(runCalls).toBe(2))

    const state = (controller as any).getSessionState('s1', 'research')
    expect(state).toMatchObject({ isWorking: true, queue: [] })
    expect(state.activeRunMarker).toMatch(/^resp_run_/)
    expect(urls.filter(url => url.endsWith('/goals/evaluate'))).toHaveLength(1)
    const terminalIndex = emitted.findIndex(item => item.event === 'run.completed')
    const dequeueIndex = emitted.findIndex(item => item.event === 'run.queued')
    expect(terminalIndex).toBeGreaterThanOrEqual(0)
    expect(dequeueIndex).toBeGreaterThan(terminalIndex)

    continuationRun.resolve({ ok: true, status: 200, body: sseDone('run-2') })
    await vi.waitFor(() => expect(state.isWorking).toBe(false))
  })

  it('does not queue a goal continuation when abort arrives during goal evaluation', async () => {
    const goal = deferred<any>()
    const urls: string[] = []
    const fetchMock = vi.fn((url: string) => {
      urls.push(String(url))
      if (String(url).endsWith('/goals/evaluate')) return goal.promise
      return Promise.resolve({ ok: true, status: 200, body: sseDone('run-1', 'continue') })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers, socket } = makeHarness()

    const pending = handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })
    await vi.waitFor(() => expect(urls.some(url => url.endsWith('/goals/evaluate'))).toBe(true))
    await (controller as any).handleAbort(socket, 's1', 'research')
    goal.resolve({
      ok: true,
      json: async () => ({ should_continue: true, continuation_prompt: 'must not start' }),
    })
    await pending
    await new Promise(resolve => setTimeout(resolve, 0))

    const state = (controller as any).getSessionState('s1', 'research')
    expect(urls.filter(url => url.endsWith('/runs'))).toHaveLength(1)
    expect(state).toMatchObject({ isWorking: false, isAborting: false, queue: [] })
    expect(emitted.filter(item => item.event === 'abort.completed')).toHaveLength(1)
  })

  it('aborts a hanging goal evaluation without waiting for the upstream request to return', async () => {
    let goalSignal: AbortSignal | undefined
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/goals/evaluate')) {
        goalSignal = init?.signal || undefined
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }
      return Promise.resolve({ ok: true, status: 200, body: sseDone('run-1', 'continue') })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers, socket } = makeHarness()

    const pending = handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })
    await vi.waitFor(() => expect(goalSignal).toBeDefined())
    await (controller as any).handleAbort(socket, 's1', 'research')
    await pending

    const state = (controller as any).getSessionState('s1', 'research')
    expect(goalSignal?.aborted).toBe(true)
    expect(state).toMatchObject({ isWorking: false, isAborting: false, queue: [] })
    expect(emitted.filter(item => item.event === 'abort.completed')).toHaveLength(1)
    expect(emitted.filter(item => item.event === 'run.failed')).toHaveLength(0)
    expect(emitted.filter(item => item.event === 'run.completed')).toHaveLength(0)
  })

  it('cancels only a hanging goal evaluation when a user queues and releases that run without abort', async () => {
    const nextRun = deferred<any>()
    let runCalls = 0
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/goals/evaluate')) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }
      runCalls++
      if (runCalls === 1) return Promise.resolve({ ok: true, status: 200, body: sseDone('run-1', 'continue') })
      return nextRun.promise
    })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()

    const first = handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/goals/evaluate'))).toBe(true))
    await handlers.get('run')!({ input: 'queued user', session_id: 's1', queue_id: 'queued' })

    await first
    await vi.waitFor(() => expect(runCalls).toBe(2))
    const state = (controller as any).getSessionState('s1', 'research')
    expect(state).toMatchObject({ isWorking: true, isAborting: false, queue: [] })
    expect(emitted.filter(item => item.event === 'abort.completed')).toHaveLength(0)
    expect(emitted.filter(item => item.event === 'run.failed')).toHaveLength(0)
    expect(emitted.filter(item => item.event === 'run.completed')).toHaveLength(1)
    nextRun.resolve({ ok: true, status: 200, body: sseDone('run-2') })
    await vi.waitFor(() => expect(state.isWorking).toBe(false))
  })

  it('fails visibly and clears working state when session identity setup throws', async () => {
    store.getSession
      .mockReturnValueOnce({ id: 's1', profile: 'research', workspace: '/tmp/workspace' })
      .mockImplementationOnce(() => { throw new Error('identity failed') })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()

    await handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })

    const state = (controller as any).getSessionState('s1', 'research')
    expect(state).toMatchObject({ isWorking: false, activeRunMarker: undefined, abortController: undefined })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.updateSessionStats).not.toHaveBeenCalled()
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'run.failed', payload: expect.objectContaining({ error: 'identity failed' }) }),
    ]))
  })

  it('clears working state when the first session lookup throws before broker setup', async () => {
    store.getSession.mockImplementationOnce(() => { throw new Error('initial lookup failed') })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()

    await handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })

    const state = (controller as any).getSessionState('s1', 'research')
    expect(state).toMatchObject({ isWorking: false, activeRunMarker: undefined, abortController: undefined })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'run.failed', payload: expect.objectContaining({ error: 'initial lookup failed' }) }),
    ]))
  })

  it('fails safely when the broker handoff identity getter throws and starts the queued run', async () => {
    let rowChecks = 0
    store.getSessionRowId.mockImplementation(() => {
      rowChecks++
      if (rowChecks === 5) throw new Error('handoff identity failed')
      return 1
    })
    const nextRun = deferred<any>()
    const fetchMock = vi.fn().mockReturnValue(nextRun.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()
    const state = (controller as any).getOrCreateSession('s1', 'research')
    state.queue.push({ queue_id: 'queued', input: 'follow-up', profile: 'research' })

    await handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    const current = (controller as any).getSessionState('s1', 'research')
    expect(current).toBe(state)
    expect(current).toMatchObject({ isWorking: true, isAborting: false, queue: [] })
    expect(store.updateSessionStats).not.toHaveBeenCalled()
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'run.failed', payload: expect.objectContaining({ error: 'handoff identity failed' }) }),
    ]))
    nextRun.resolve({ ok: true, status: 200, body: sseDone('run-2') })
    await vi.waitFor(() => expect(current.isWorking).toBe(false))
  })

  it('keeps and starts the queued follow-up when create succeeds but addMessage throws', async () => {
    let exists = false
    const nextRun = deferred<any>()
    store.getSession.mockImplementation(() => exists
      ? { id: 'new-session', profile: 'research', workspace: '/tmp/workspace' }
      : null)
    store.getSessionRowId.mockImplementation(() => exists ? 1 : null)
    store.getSessionIncarnation.mockImplementation(() => exists ? 1 : null)
    store.createSession.mockImplementation(() => { exists = true })
    store.addMessage.mockImplementationOnce(() => { throw new Error('message write failed') })
    const fetchMock = vi.fn().mockReturnValue(nextRun.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()
    const state = (controller as any).getOrCreateSession('new-session', 'research')
    state.queue.push({ queue_id: 'queued', input: 'follow-up', profile: 'research' })

    await handlers.get('run')!({ input: 'first', session_id: 'new-session', queue_id: 'first' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    const current = (controller as any).getSessionState('new-session', 'research')
    expect(current).toBe(state)
    expect(current).toMatchObject({ isWorking: true, queue: [], sessionRowId: 1, sessionIncarnation: 1 })
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'run.failed', payload: expect.objectContaining({ error: 'message write failed' }) }),
    ]))
    nextRun.resolve({ ok: true, status: 200, body: sseDone('run-2') })
    await vi.waitFor(() => expect(current.isWorking).toBe(false))
  })

  it('fails closed when the first finalizer identity check throws and releases the queue', async () => {
    const diff = deferred<null>()
    let diffSettled = false
    let identityChecksAfterDiff = 0
    let identityThrew = false
    tracker.complete.mockImplementationOnce(async () => {
      await diff.promise
      diffSettled = true
      return null
    })
    store.getSessionRowId.mockImplementation(() => {
      if (diffSettled && ++identityChecksAfterDiff === 3) {
        identityThrew = true
        throw new Error('final identity failed')
      }
      return 1
    })
    const nextRun = deferred<any>()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, body: sseDone('run-1') })
      .mockReturnValueOnce(nextRun.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()
    const flushSpy = vi.spyOn(controller as any, 'flushResponseRunToDb')

    const first = handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })
    await vi.waitFor(() => expect(tracker.complete).toHaveBeenCalled())
    await handlers.get('run')!({ input: 'second', session_id: 's1', queue_id: 'second' })
    diff.resolve(null)

    await first
    await waitForSecondFetch(fetchMock)
    const state = (controller as any).getSessionState('s1', 'research')
    expect(identityThrew).toBe(true)
    expect(flushSpy).not.toHaveBeenCalled()
    expect(store.updateSessionStats).not.toHaveBeenCalled()
    expect(state).toMatchObject({ isWorking: true, isAborting: false, queue: [] })
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'run.failed',
        payload: expect.objectContaining({ error: 'final identity failed' }),
      }),
    ]))
    nextRun.resolve({ ok: true, status: 200, body: sseDone('run-2') })
    await vi.waitFor(() => expect(state.isWorking).toBe(false))
  })

  it('releases the latest queue and reports failure when completion persistence throws', async () => {
    const diff = deferred<null>()
    tracker.complete.mockReturnValueOnce(diff.promise)
    store.updateSessionStats.mockImplementationOnce(() => { throw new Error('stats failed') })
    const nextRun = deferred<any>()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, body: sseDone('run-1') })
      .mockReturnValueOnce(nextRun.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()

    const first = handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })
    await vi.waitFor(() => expect(tracker.complete).toHaveBeenCalled())
    await handlers.get('run')!({ input: 'second', session_id: 's1', queue_id: 'second' })
    diff.resolve(null)

    await first
    await waitForSecondFetch(fetchMock)
    const state = (controller as any).getSessionState('s1', 'research')
    expect(state.isWorking).toBe(true)
    expect(state.queue).toHaveLength(0)
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'run.failed',
        payload: expect.objectContaining({ error: 'Run finalization failed: stats failed' }),
      }),
    ]))
    nextRun.resolve({ ok: true, status: 200, body: sseDone('run-2') })
    await vi.waitFor(() => expect(state.isWorking).toBe(false))
  })

  it('cleans the exact run when checkpoint setup rejects', async () => {
    tracker.start.mockRejectedValueOnce(new Error('checkpoint failed'))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = makeHarness()

    await handlers.get('run')!({ input: 'first', session_id: 's1', queue_id: 'first' })

    expect((controller as any).getSessionState('s1', 'research')).toMatchObject({
      isWorking: false,
      isAborting: false,
      activeRunMarker: undefined,
      abortController: undefined,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'run.failed', payload: expect.objectContaining({ error: 'checkpoint failed' }) }),
    ]))
  })
})
