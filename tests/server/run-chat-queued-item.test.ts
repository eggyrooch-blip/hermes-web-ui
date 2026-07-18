import { beforeEach, describe, expect, it, vi } from 'vitest'

const handleBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const resumeBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const handleApiRunMock = vi.hoisted(() => vi.fn(async () => {}))
const handleCodingAgentRunMock = vi.hoisted(() => vi.fn(async () => {}))
const handleSessionCommandMock = vi.hoisted(() => vi.fn(async () => {}))
const loadSessionStateFromDbMock = vi.hoisted(() => vi.fn())
const ensureReadyMock = vi.hoisted(() => vi.fn())
const ensureWorkspaceMock = vi.hoisted(() => vi.fn(async () => '/tmp/hermes-default/workspace'))
const bridgeMock = vi.hoisted(() => ({
  status: vi.fn(),
  statusIfLoaded: vi.fn(),
  interrupt: vi.fn(),
  goalPause: vi.fn(),
}))
const sessionGenerationMock = vi.hoisted(() => ({
  rowId: vi.fn(() => 1),
  incarnation: vi.fn(() => 1),
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
  handleSessionCommand: handleSessionCommandMock,
  isSessionCommand: vi.fn(() => false),
  parseSessionCommand: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/workspace', () => ({
  ensureHermesRunWorkspace: ensureWorkspaceMock,
}))

vi.mock('../../packages/server/src/services/hermes/agent-bridge', () => ({
  AgentBridgeClient: vi.fn(() => bridgeMock),
}))

vi.mock('../../packages/server/src/services/hermes/agent-bridge/manager', () => ({
  getAgentBridgeManager: vi.fn(() => ({
    ensureReady: ensureReadyMock,
  })),
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/lib/llm-prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSession: vi.fn(() => ({ id: 'session-1', profile: 'default', source: 'cli' })),
  getSessionRowId: sessionGenerationMock.rowId,
  getSessionIncarnation: sessionGenerationMock.incarnation,
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
  const sockets = new Map<string, any>()
  const namespace = {
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
    sockets,
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
  sockets.set(socket.id, socket)
  return { handlers, io, namespace, socket }
}

describe('ChatRunSocket queued bridge runs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureReadyMock.mockResolvedValue({
      reachable: true,
      status: 'ready',
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
    })
    bridgeMock.statusIfLoaded.mockResolvedValue({ ok: true, exists: false, running: false, loaded: false })
    bridgeMock.interrupt.mockResolvedValue({ synced: true })
    bridgeMock.goalPause.mockResolvedValue({ handled: true })
    sessionGenerationMock.rowId.mockReturnValue(1)
    sessionGenerationMock.incarnation.mockReturnValue(1)
    loadSessionStateFromDbMock.mockResolvedValue({
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    })
  })

  it('persists normal queued bridge messages when they are dequeued', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).runQueuedItem(socket, 'session-1', {
      queue_id: 'queue-normal',
      input: 'queued follow-up',
      source: 'cli',
      profile: 'default',
    }, 'default')

    await vi.waitFor(() => expect(handleBridgeRunMock).toHaveBeenCalled())
    const call = handleBridgeRunMock.mock.calls.at(-1)!
    expect(call[2]).toEqual(expect.objectContaining({
      input: 'queued follow-up',
      display_input: undefined,
      storage_message: undefined,
      queue_id: 'queue-normal',
    }))
    expect(call[6]).toBe(false)
  })

  it('persists the visible plan command when dequeuing expanded plan command runs', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).runQueuedItem(socket, 'session-1', {
      queue_id: 'queue-plan',
      input: '[IMPORTANT: expanded plan skill prompt]',
      displayInput: '/plan build the feature',
      displayRole: 'command',
      storageMessage: '/plan build the feature',
      source: 'cli',
      profile: 'default',
    }, 'default')

    await vi.waitFor(() => expect(handleBridgeRunMock).toHaveBeenCalled())
    const call = handleBridgeRunMock.mock.calls.at(-1)!
    expect(call[2]).toEqual(expect.objectContaining({
      input: '[IMPORTANT: expanded plan skill prompt]',
      display_input: '/plan build the feature',
      display_role: 'command',
      storage_message: '/plan build the feature',
      queue_id: 'queue-plan',
    }))
    expect(call[6]).toBe(false)
  })

  it('continues the latest queued bridge run when current bridge setup rejects', async () => {
    handleBridgeRunMock
      .mockRejectedValueOnce(new Error('workspace setup failed'))
      .mockResolvedValueOnce(undefined)
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const state = {
      messages: [],
      isWorking: false,
      events: [],
      queue: [{
        queue_id: 'queue-follow-up',
        input: 'latest follow-up',
        source: 'cli',
        profile: 'default',
      }],
    }
    ;(server as any).sessionMap.set('session-1', state)

    await expect((server as any).handleRun(socket, {
      input: 'failing request',
      session_id: 'session-1',
      source: 'cli',
    }, 'default')).rejects.toThrow('workspace setup failed')

    await vi.waitFor(() => expect(handleBridgeRunMock).toHaveBeenCalledTimes(2))
    expect(handleBridgeRunMock.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
      input: 'latest follow-up',
      queue_id: 'queue-follow-up',
    }))
    expect(state.queue).toEqual([])
  })

  it('continues queued work when the bridge handler releases admission before throwing', async () => {
    const { releaseBridgeRunAdmission } = await import('../../packages/server/src/services/hermes/run-chat/bridge-run-admission')
    handleBridgeRunMock.mockImplementationOnce(async (...args: any[]) => {
      releaseBridgeRunAdmission(args[4], args[9])
      throw new Error('internal bridge setup failed')
    })
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const state = {
      messages: [],
      isWorking: false,
      events: [],
      queue: [{
        queue_id: 'queue-after-internal-release',
        input: 'continue after internal release',
        source: 'cli',
        profile: 'default',
      }],
    }
    ;(server as any).sessionMap.set('session-1', state)

    await expect((server as any).handleRun(socket, {
      input: 'failing request',
      session_id: 'session-1',
      source: 'cli',
    }, 'default')).rejects.toThrow('internal bridge setup failed')

    await vi.waitFor(() => expect(handleBridgeRunMock).toHaveBeenCalledTimes(2))
    expect(handleBridgeRunMock.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
      queue_id: 'queue-after-internal-release',
    }))
    expect(state.queue).toEqual([])
  })

  it('does not dequeue a replacement run when an older bridge setup rejection lost ownership', async () => {
    let rejectOldSetup!: (error: Error) => void
    handleBridgeRunMock.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectOldSetup = reject
    }))
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    const oldRun = (server as any).handleRun(socket, {
      input: 'old setup',
      session_id: 'session-1',
      source: 'cli',
    }, 'default')
    await vi.waitFor(() => expect(handleBridgeRunMock).toHaveBeenCalledTimes(1))

    const state = (server as any).sessionMap.get('session-1')
    state.activeRunMarker = 'replacement-active-run'
    state.isWorking = true
    state.queue.push({
      queue_id: 'replacement-follow-up',
      input: 'must wait for replacement',
      source: 'cli',
      profile: 'default',
    })

    rejectOldSetup(new Error('old setup rejected late'))
    await expect(oldRun).rejects.toThrow('old setup rejected late')

    expect(handleBridgeRunMock).toHaveBeenCalledTimes(1)
    expect(state).toMatchObject({
      isWorking: true,
      activeRunMarker: 'replacement-active-run',
    })
    expect(state.queue).toEqual([
      expect.objectContaining({ queue_id: 'replacement-follow-up' }),
    ])
  })

  it('does not shift a queue while the current state still owns an active run', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const state = {
      messages: [],
      isWorking: true,
      events: [],
      activeRunMarker: 'active-run',
      queue: [{
        queue_id: 'queued-after-active',
        input: 'wait your turn',
        source: 'cli',
        profile: 'default',
      }],
    }
    ;(server as any).sessionMap.set('session-1', state)

    expect((server as any).dequeueNextQueuedRun(socket, 'session-1', 'default')).toBe(false)
    expect(handleBridgeRunMock).not.toHaveBeenCalled()
    expect(state.queue).toEqual([
      expect.objectContaining({ queue_id: 'queued-after-active' }),
    ])
  })

  it('reserves a queued session command after bridge readiness rejects the current run', async () => {
    ensureReadyMock.mockResolvedValueOnce({
      reachable: false,
      status: 'failed',
      error: 'bridge unavailable',
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
    })
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const state = {
      messages: [],
      isWorking: false,
      events: [],
      queue: [{
        queue_id: 'queue-plan',
        input: '/plan next',
        displayInput: '/plan next',
        displayRole: 'command',
        storageMessage: '/plan next',
        source: 'cli',
        profile: 'default',
        sessionCommand: {
          name: 'plan',
          rawName: 'plan',
          args: 'next',
          sessionRowId: 1,
          sessionIncarnation: 1,
        },
      }],
    }
    ;(server as any).sessionMap.set('session-1', state)

    await (server as any).handleRun(socket, {
      input: 'failing request',
      session_id: 'session-1',
      source: 'cli',
    }, 'default')

    await vi.waitFor(() => expect(handleSessionCommandMock).toHaveBeenCalledTimes(1))
    expect(state.queue).toEqual([])
    expect(state.commandReservationMarker).toBeTruthy()
  })

  it('releases an aborted bridge admission without waiting for readiness to return', async () => {
    ensureReadyMock.mockImplementationOnce(() => new Promise(() => {}))
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handleAbort } = await import('../../packages/server/src/services/hermes/run-chat/abort')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    const running = (server as any).handleRun(socket, {
      input: 'wait for bridge readiness',
      session_id: 'session-1',
      source: 'cli',
    }, 'default')
    await vi.waitFor(() => expect(ensureReadyMock).toHaveBeenCalledTimes(1))
    const state = (server as any).sessionMap.get('session-1')
    expect(state).toMatchObject({ isWorking: true, activeRunMarker: expect.any(String) })

    await Promise.all([
      running,
      handleAbort(
        (server as any).nsp,
        socket as any,
        'session-1',
        (server as any).sessionMap,
        bridgeMock,
        vi.fn(),
        (server as any).dequeueNextQueuedRun.bind(server),
      ),
    ])

    expect(bridgeMock.interrupt).toHaveBeenCalledWith('session-1', 'Aborted by user', 'default')
    expect(handleBridgeRunMock).not.toHaveBeenCalled()
    expect(state).toMatchObject({
      isWorking: false,
      isAborting: false,
      activeRunMarker: undefined,
      abortController: undefined,
    })
  })

  it('reports a generation lookup failure to the requesting socket', async () => {
    sessionGenerationMock.rowId.mockImplementationOnce(() => { throw new Error('generation lookup failed') })
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)

    await handlers.get('run')?.({
      input: 'request with unavailable identity',
      session_id: 'session-1',
      source: 'cli',
    })

    expect(socket.emit).toHaveBeenCalledWith('run.failed', {
      event: 'run.failed',
      session_id: 'session-1',
      error: 'generation lookup failed',
    })
    expect(handleBridgeRunMock).not.toHaveBeenCalled()
  })

  it('queues coding-agent messages while a coding-agent turn is active', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, namespace, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    ;(server as any).sessionMap.set('session-1', {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [],
      source: 'coding_agent',
    })

    await handlers.get('run')?.({
      session_id: 'session-1',
      input: 'queued codex follow-up',
      source: 'coding_agent',
      coding_agent_id: 'codex',
      queue_id: 'queue-codex',
      model: 'gpt-5-codex',
      provider: 'openai-codex',
      profile: 'default',
    })

    expect(handleCodingAgentRunMock).not.toHaveBeenCalled()
    expect((server as any).sessionMap.get('session-1').queue).toEqual([
      expect.objectContaining({
        queue_id: 'queue-codex',
        input: 'queued codex follow-up',
        source: 'coding_agent',
        codingAgentId: 'codex',
      }),
    ])
    expect(namespace.to).toHaveBeenCalledWith('session:session-1')
  })

  it('dequeues coding-agent messages when an external coding-agent run completes', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const state = {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [{
        queue_id: 'queue-codex',
        input: 'queued codex follow-up',
        source: 'coding_agent',
        codingAgentId: 'codex',
        model: 'gpt-5-codex',
        provider: 'openai-codex',
        profile: 'default',
        originSocketId: socket.id,
      }],
      source: 'coding_agent',
      runId: 'agent-run-1',
      sessionRowId: 1,
      sessionIncarnation: 1,
    }
    ;(server as any).sessionMap.set('session-1', state)

    ;(server as any).markExternalRunCompleted('session-1', 'run.completed', {
      state,
      runId: 'agent-run-1',
      turnMarker: null,
      sessionRowId: 1,
      sessionIncarnation: 1,
    })

    await vi.waitFor(() => expect(handleCodingAgentRunMock).toHaveBeenCalled())
    const call = handleCodingAgentRunMock.mock.calls.at(-1)!
    expect(call[2]).toEqual(expect.objectContaining({
      input: 'queued codex follow-up',
      source: 'coding_agent',
      coding_agent_id: 'codex',
      queue_id: 'queue-codex',
    }))
    expect((server as any).sessionMap.get('session-1').queue).toEqual([])
  })

  it('checks bridge resume status without cold-starting the profile worker', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(bridgeMock.statusIfLoaded).toHaveBeenCalledWith('session-1', 'default', { timeoutMs: 1000 })
    expect(bridgeMock.status).not.toHaveBeenCalled()
    expect(resumeBridgeRunMock).not.toHaveBeenCalled()
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      isWorking: false,
    }))
  })

  it('reattaches a loaded running bridge run during resume', async () => {
    bridgeMock.statusIfLoaded.mockResolvedValueOnce({
      ok: true,
      exists: true,
      running: true,
      current_run_id: 'run-1',
      loaded: true,
    })
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(resumeBridgeRunMock).toHaveBeenCalledWith(
      expect.anything(),
      socket,
      expect.objectContaining({
        sessionId: 'session-1',
        runId: 'run-1',
        profile: 'default',
      }),
      expect.any(Map),
      bridgeMock,
      expect.any(Function),
    )
  })

  it('replays stable terminal events until this socket acknowledges their exact ids', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set('session-1', {
      messages: [],
      isWorking: false,
      events: [],
      queue: [],
      sessionRowId: 1,
      sessionIncarnation: 1,
      pendingTerminalEvents: [
        {
          id: 'terminal-abort-1',
          event: 'abort.completed',
          data: { event: 'abort.completed', session_id: 'session-1', failure_pending: true },
        },
        {
          id: 'terminal-failure-1',
          event: 'run.failed',
          data: { event: 'run.failed', session_id: 'session-1', error: 'stats failed' },
        },
      ],
    })
    ;(server as any).onConnection(socket)

    await handlers.get('resume')?.({ session_id: 'session-1' })
    const firstResume = socket.emit.mock.calls.find(call => call[0] === 'resumed')?.[1]
    expect(firstResume.events).toEqual([
      expect.objectContaining({ id: 'terminal-abort-1', event: 'abort.completed' }),
      expect.objectContaining({ id: 'terminal-failure-1', event: 'run.failed' }),
    ])

    handlers.get('resume.events.ack')?.({
      session_id: 'session-1',
      event_ids: ['terminal-abort-1'],
    })
    socket.emit.mockClear()
    await handlers.get('resume')?.({ session_id: 'session-1' })
    const secondResume = socket.emit.mock.calls.find(call => call[0] === 'resumed')?.[1]
    expect(secondResume.events).toEqual([
      expect.objectContaining({ id: 'terminal-failure-1', event: 'run.failed' }),
    ])
  })
})
