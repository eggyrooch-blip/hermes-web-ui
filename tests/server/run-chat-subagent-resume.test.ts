import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mapRunBrokerFrameForChat, rememberBrokerWorkflowEvent } from '../../packages/server/src/services/hermes/run-chat/handle-broker-run'

const persistedMessages = vi.hoisted(() => [] as any[])
const handleBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const resumeBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const handleApiRunMock = vi.hoisted(() => vi.fn(async () => {}))
const handleCodingAgentRunMock = vi.hoisted(() => vi.fn(async () => {}))
const loadSessionStateFromDbMock = vi.hoisted(() => vi.fn())
const ensureReadyMock = vi.hoisted(() => vi.fn())
const getRuntimeStateMock = vi.hoisted(() => vi.fn())
const getSessionMock = vi.hoisted(() => vi.fn((sessionId?: string) => sessionId
  ? { id: sessionId, profile: 'default', source: 'cli', model: 'gpt-test', provider: 'openai' }
  : undefined))
const bridgeMock = vi.hoisted(() => ({
  status: vi.fn(),
  statusIfLoaded: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/handle-bridge-run', () => ({
  handleBridgeRun: handleBridgeRunMock,
  resumeBridgeRun: resumeBridgeRunMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/handle-api-run', () => ({
  handleApiRun: handleApiRunMock,
  loadSessionStateFromDb: loadSessionStateFromDbMock,
  resolveRunSource: vi.fn((source?: string) => source || 'cli'),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/handle-coding-agent-run', () => ({
  handleCodingAgentRun: handleCodingAgentRunMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/session-command', () => ({
  handleSessionCommand: vi.fn(),
  isSessionCommand: vi.fn(() => false),
  parseSessionCommand: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/services/hermes/agent-bridge', () => ({
  AgentBridgeClient: vi.fn(function () { return bridgeMock }),
}))

vi.mock('../../packages/server/src/services/hermes/agent-bridge/manager', () => ({
  getAgentBridgeManager: vi.fn(() => ({
    ensureReady: ensureReadyMock,
    getRuntimeState: getRuntimeStateMock,
  })),
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/lib/llm-prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSession: getSessionMock,
  getSessionDetail: vi.fn(() => ({ profile: 'default', source: 'api_server', messages: persistedMessages })),
  createSession: vi.fn(),
  addMessage: vi.fn(message => { persistedMessages.push({ ...message, id: persistedMessages.length + 1 }) }),
  updateSession: vi.fn(),
  updateSessionStats: vi.fn(),
  getSessionRowId: vi.fn(() => 1),
  getSessionIncarnation: vi.fn(() => 1),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: vi.fn(() => 'default'),
  getProfileDir: vi.fn(() => '/tmp/hermes-default'),
  listProfileNamesFromDisk: vi.fn(() => ['default']),
}))

vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  authenticateUserToken: vi.fn(),
  isAuthEnabled: vi.fn(async () => false),
}))

vi.mock('../../packages/server/src/db/hermes/users-store', () => ({
  userCanAccessProfile: vi.fn(() => true),
}))

function makeServerHarness() {
  const handlers = new Map<string, Function>()
  const namespace = {
    adapter: { rooms: new Map() },
    to: vi.fn(() => ({ emit: vi.fn() })),
    use: vi.fn(),
    on: vi.fn(),
  }
  const io = { of: vi.fn(() => namespace) }
  const socket = {
    id: 'socket-1',
    connected: true,
    handshake: { auth: {}, query: { profile: 'default' } },
    data: {},
    emit: vi.fn(),
    join: vi.fn(),
    to: vi.fn(() => ({ emit: vi.fn() })),
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler)
    }),
  }
  return { handlers, io, namespace, socket }
}

/** Feed real broker SSE frames through the real mapper + memory, as a run does. */
function playBrokerFrames(state: any, frames: any[]): void {
  for (const frame of frames) {
    const mapped = mapRunBrokerFrameForChat(frame)
    if (mapped.type !== 'emit') throw new Error(`expected emit for ${frame.kind}`)
    rememberBrokerWorkflowEvent(state, mapped.event, mapped.payload)
  }
}

function subagentFrame(kind: string, extra: Record<string, unknown> = {}): any {
  return {
    kind,
    run_id: 'resp_run_1',
    payload: { subagent_id: 'sa-0', task_index: 0, task_count: 2, goal: 'summarise', ...extra },
  }
}

function makeSessionState(overrides: Record<string, unknown> = {}): any {
  return {
    messages: [],
    messageTotal: 0,
    messageLoadedCount: 0,
    messagePageLimit: 50,
    hasMoreBefore: false,
    isWorking: false,
    isAborting: false,
    events: [],
    queue: [],
    ...overrides,
  }
}

async function resume(state: any) {
  const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
  const { handlers, io, socket } = makeServerHarness()
  const server = new ChatRunSocket(io as any)
  ;(server as any).sessionMap.set('session-1', state)
  ;(server as any).onConnection(socket)
  await handlers.get('resume')?.({ session_id: 'session-1' })
  const resumed = socket.emit.mock.calls.find(call => call[0] === 'resumed')?.[1]
  const replayed = socket.emit.mock.calls.filter(call => String(call[0]).startsWith('subagent.'))
  return { resumed, replayed, socket }
}

describe('subagent card replay across a resume', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    bridgeMock.statusIfLoaded.mockResolvedValue({ ok: true, exists: false, running: false, loaded: false })
    ensureReadyMock.mockResolvedValue({ reachable: true, status: 'ready', endpoint: 'ipc:///tmp/bridge.sock' })
    getRuntimeStateMock.mockReturnValue({ endpoint: 'ipc:///tmp/bridge.sock' })
    getSessionMock.mockImplementation((sessionId?: string) => sessionId
      ? { id: sessionId, profile: 'default', source: 'cli', model: 'gpt-test', provider: 'openai' }
      : undefined)
    loadSessionStateFromDbMock.mockImplementation(async () => makeSessionState())
  })

  // Failure mode 1: the run finished, then the tab reloads. The idle branch of
  // resumeSession used to drop every event except run.reattach_failed, so the
  // finished delegate_task cards vanished on refresh.
  it('restores completed subagent cards when an idle session resumes after the run finished', async () => {
    const state = makeSessionState({ isWorking: false })
    playBrokerFrames(state, [
      subagentFrame('subagent.start'),
      subagentFrame('subagent.tool', { tool_name: 'terminal' }),
      subagentFrame('subagent.complete', { status: 'completed', summary: 'summarised 3 files', duration_seconds: 9 }),
    ])

    const { resumed, replayed } = await resume(state)

    // The card the client rebuilds from the resumed array carries the finished
    // state, not just a surviving row: same card id inputs, status completed.
    const snapshots = resumed.events.filter((item: any) => String(item.event).startsWith('subagent.'))
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].event).toBe('subagent.complete')
    expect(snapshots[0].data).toEqual(expect.objectContaining({
      run_id: 'resp_run_1',
      subagent_id: 'sa-0',
      task_index: 0,
      task_count: 2,
      status: 'completed',
      summary: 'summarised 3 files',
      duration_seconds: 9,
    }))

    // And the same snapshot goes out under the listened event name, carrying the
    // session_id the client's global handler requires to route it.
    expect(replayed).toHaveLength(1)
    expect(replayed[0][0]).toBe('subagent.complete')
    expect(replayed[0][1]).toEqual(expect.objectContaining({
      session_id: 'session-1',
      subagent_id: 'sa-0',
      status: 'completed',
    }))
  })

  // Failure mode 2: the socket drops mid-run and the subagent completes while
  // it is down. The in-run reconnect paths ignore subagent entries in the
  // resumed array, so the completion has to arrive as a socket event.
  it('re-emits the completion that landed while the socket was disconnected', async () => {
    const state = makeSessionState({ isWorking: true })
    playBrokerFrames(state, [subagentFrame('subagent.start')])
    // socket drops here; the run keeps going server-side
    playBrokerFrames(state, [
      subagentFrame('subagent.progress', { text: 'reading' }),
      subagentFrame('subagent.complete', { status: 'completed', summary: 'done' }),
    ])

    const { resumed, replayed } = await resume(state)

    expect(resumed.isWorking).toBe(true)
    expect(replayed).toHaveLength(1)
    expect(replayed[0][0]).toBe('subagent.complete')
    expect(replayed[0][1]).toEqual(expect.objectContaining({
      session_id: 'session-1',
      run_id: 'resp_run_1',
      subagent_id: 'sa-0',
      status: 'completed',
      summary: 'done',
    }))
  })

  it('replays one card per subagent and leaves other resume events alone', async () => {
    const state = makeSessionState({ isWorking: false })
    playBrokerFrames(state, [
      subagentFrame('subagent.start'),
      subagentFrame('subagent.complete', { status: 'completed' }),
      { kind: 'subagent.start', run_id: 'resp_run_1', payload: { subagent_id: 'sa-1', task_index: 1, task_count: 2, goal: 'draft' } },
    ])
    state.events.push({ event: 'run.reattach_failed', data: { event: 'run.reattach_failed', error: 'bridge down' } })

    const { resumed, replayed } = await resume(state)

    expect(resumed.events.map((item: any) => item.event)).toEqual([
      'run.reattach_failed',
      'subagent.complete',
      'subagent.complete',
    ])
    expect(replayed.map(call => [call[0], call[1].subagent_id])).toEqual([
      ['subagent.complete', 'sa-0'],
      ['subagent.complete', 'sa-1'],
    ])
  })

  // subagent.text / subagent.thinking stream live but have no client listener
  // and no card status. If one arrives after the completion it must not pull
  // the card back to "running" on the next resume.
  it('keeps a completed card completed when later text, thinking or tool frames arrive', async () => {
    const state = makeSessionState({ isWorking: false })
    playBrokerFrames(state, [
      subagentFrame('subagent.start'),
      subagentFrame('subagent.complete', { status: 'completed', summary: 'final' }),
      subagentFrame('subagent.text', { text: 'trailing narration' }),
      subagentFrame('subagent.thinking', { text: 'trailing thought' }),
      subagentFrame('subagent.tool', { tool_name: 'terminal' }),
    ])

    expect(state.events.map((item: any) => item.event)).toEqual(['subagent.complete'])

    const { resumed, replayed } = await resume(state)

    const snapshots = resumed.events.filter((item: any) => String(item.event).startsWith('subagent.'))
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].event).toBe('subagent.complete')
    expect(snapshots[0].data.summary).toBe('final')
    expect(replayed.map(call => call[0])).toEqual(['subagent.complete'])
  })
  it('keeps start A, start B, complete A in A,B order with original timestamps', async () => {
    const state = makeSessionState({ isWorking: true })
    rememberBrokerWorkflowEvent(state, 'subagent.start', { run_id: 'r', subagent_id: 'A', created_at: 100 })
    rememberBrokerWorkflowEvent(state, 'subagent.start', { run_id: 'r', subagent_id: 'B', created_at: 200 })
    rememberBrokerWorkflowEvent(state, 'subagent.complete', { run_id: 'r', subagent_id: 'A', created_at: 300 })
    expect(state.events.map((item: any) => item.data.created_at)).toEqual([100, 200])
    const { replayed } = await resume(state)
    expect(replayed.map(call => call[1].subagent_id)).toEqual(['A', 'B'])
    // Older caches may arrive in update order; timestamps still determine replay order.
    state.events.reverse()
    expect((await resume(state)).replayed.map(call => call[1].subagent_id)).toEqual(['A', 'B'])
  })

})

vi.mock('../../packages/server/src/config', () => ({ config: {
  authMode: 'token', uploadDir: '/tmp/uploads', webuiRunBroker: true,
  runBrokerUrl: 'http://broker.test', runBrokerKey: 'test',
} }))
vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  getSessionDetailFromDb: vi.fn(async () => ({ messages: persistedMessages })),
  getSessionDetailFromDbWithProfile: vi.fn(async () => ({ messages: persistedMessages })),
}))
vi.mock('../../packages/server/src/db/hermes/compression-snapshot', () => ({ getCompressionSnapshot: vi.fn(() => null) }))
vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({ updateUsage: vi.fn() }))
vi.mock('../../packages/server/src/services/hermes/run-chat/workspace', () => ({
  ensureHermesRunWorkspace: vi.fn(async () => '/tmp/workspace'),
  normalizeHermesSessionWorkspace: vi.fn(async () => null),
  normalizeStoredHermesSessionWorkspace: vi.fn(async () => null),
}))
vi.mock('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker', () => ({
  startWorkspaceRunCheckpoint: vi.fn(async () => null),
  completeWorkspaceRunCheckpoint: vi.fn(async () => null),
  discardWorkspaceRunCheckpoint: vi.fn(),
}))
vi.mock('../../packages/server/src/services/hermes/skill-credentials', () => ({
  listSkillCredentialStatuses: vi.fn(async () => ({ profile_name: 'default', credentials: [] })),
}))

async function brokerHarness() {
  const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
  const { socket, namespace } = makeServerHarness()
  Object.assign(socket.data, { profile: 'default', user: { openid: 'test-user' } })
  const server = new BrokerRunController() as any
  server.nsp = namespace
  return { server, socket }
}

function brokerStream(frames: any[]) {
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')))
    controller.close()
  } }))
}

describe('real broker subagent run lifecycle', () => {
  beforeEach(() => { persistedMessages.length = 0 })
  afterEach(() => vi.unstubAllGlobals())

  it.each(['run.failed', 'run.completed', 'abort'])('settles unfinished start/tool snapshots on %s before resume', async (terminal) => {
    const { server, socket } = await brokerHarness()
    vi.stubGlobal('fetch', vi.fn(async (url) => !String(url).endsWith('/runs') ? Response.json({}) : brokerStream([
      subagentFrame('subagent.start'), subagentFrame('subagent.tool', { tool_name: 'terminal' }),
      { kind: terminal === 'run.completed' ? 'done' : 'run.failed', run_id: 'resp_run_1', text: 'ended' },
    ])))
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    if (terminal === 'abort') {
      vi.stubGlobal('fetch', vi.fn(async (url) => !String(url).endsWith('/runs') ? Response.json({}) : new Response(new ReadableStream({ start(controller) {
        streamController = controller
        controller.enqueue(new TextEncoder().encode([
          subagentFrame('subagent.start'), subagentFrame('subagent.tool'),
        ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')))
      } }))))
    }
    const run = server.handleRun(socket, { session_id: 'session-1', input: 'delegate', source: 'cli' }, 'default')
    if (terminal === 'abort') {
      await vi.waitFor(() => expect(server.getSessionState('session-1', 'default')?.events[0]?.event).toBe('subagent.tool'))
      await server.handleAbort(socket, 'session-1', 'default')
      streamController!.error(new DOMException('aborted', 'AbortError'))
    }
    await run
    const state = server.getSessionState('session-1', 'default')
    expect(state.isWorking).toBe(false)
    expect(state.events).toEqual([expect.objectContaining({
      event: 'subagent.complete', data: expect.objectContaining({ status: 'interrupted' }),
    })])
    await server.resumeSession(socket, 'session-1', 'default')
    expect(socket.emit).toHaveBeenCalledWith('subagent.complete', expect.objectContaining({ status: 'interrupted' }))
  })

  it('preserves first-round cards through real second-round initialization, message loading and replay', async () => {
    const { server, socket } = await brokerHarness()
    const loadMessages = vi.spyOn(server, 'getSessionDetailForProfile')
    let round = 0
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (!String(url).endsWith('/runs')) return Response.json({})
      round++
      const run_id = `round-${round}`
      return brokerStream([
        { ...subagentFrame('subagent.start'), run_id },
        { ...subagentFrame('subagent.complete', { status: 'completed', summary: `result-${round}` }), run_id },
        { kind: 'done', run_id, text: `answer-${round}` },
      ])
    }))
    await server.handleRun(socket, { session_id: 'session-1', input: 'first', source: 'cli' }, 'default')
    expect(server.getSessionState('session-1', 'default').isWorking).toBe(false)
    await server.handleRun(socket, { session_id: 'session-1', input: 'second', source: 'cli' }, 'default')
    expect(vi.mocked(fetch).mock.calls.map(call => String(call[0]))).toContain('http://broker.test/api/run-broker/runs')
    expect(round).toBe(2)
    const loaded = await server.loadSessionStateFromDb('session-1', 'default')
    expect(loaded.messages.filter((message: any) => message.role === 'user').map((message: any) => message.content)).toEqual(['first', 'second'])
    expect(loadMessages).toHaveBeenCalled()
    await server.resumeSession(socket, 'session-1', 'default')
    const resumed = socket.emit.mock.calls.find((call: any[]) => call[0] === 'resumed')![1]
    expect(resumed.messages.filter((message: any) => message.role === 'user').map((message: any) => message.content)).toEqual(['first', 'second'])
    const cards = resumed.events.filter((item: any) => item.event === 'subagent.complete')
    expect(cards.map((item: any) => [item.data.run_id, item.data.summary])).toEqual([
      ['round-1', 'result-1'], ['round-2', 'result-2'],
    ])
    expect(socket.emit.mock.calls.filter((call: any[]) => call[0] === 'subagent.complete')).toHaveLength(2)
  })
})
