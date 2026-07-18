import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dbState = vi.hoisted(() => ({
  db: null as DatabaseSync | null,
  appHome: '',
}))
const namespaceEmit = vi.hoisted(() => vi.fn())
const handleBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const bridgeMock = vi.hoisted(() => ({
  command: vi.fn(),
  status: vi.fn(async () => ({ exists: true, running: false, current_run_id: null })),
  statusIfLoaded: vi.fn(async () => ({ ok: true, exists: false, running: false, loaded: false })),
  interrupt: vi.fn(async () => ({ ok: true, synced: true })),
  goalPause: vi.fn(async () => ({ ok: true })),
  destroy: vi.fn(async () => ({ ok: true })),
}))
const usageMock = vi.hoisted(() => ({
  calcAndUpdateUsage: vi.fn(async () => ({ inputTokens: 0, outputTokens: 0 })),
  contextTokensWithCachedOverhead: vi.fn(),
  updateMessageContextTokenUsage: vi.fn(),
}))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => dbState.db,
  getStoragePath: () => dbState.appHome,
  isSqliteAvailable: () => Boolean(dbState.db),
  jsonDelete: vi.fn(),
  jsonGet: vi.fn(),
  jsonGetAll: vi.fn(() => ({})),
  jsonSet: vi.fn(),
}))

vi.mock('../../packages/server/src/config', () => ({
  config: { appHome: dbState.appHome, webuiRunBroker: false },
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/handle-bridge-run', () => ({
  handleBridgeRun: handleBridgeRunMock,
  resumeBridgeRun: vi.fn(async () => {}),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/handle-api-run', () => ({
  handleApiRun: vi.fn(async () => {}),
  loadSessionStateFromDb: vi.fn(async () => ({ messages: [], isWorking: false, events: [], queue: [] })),
  resolveRunSource: vi.fn((source?: string) => source || 'cli'),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/handle-coding-agent-run', () => ({
  handleCodingAgentRun: vi.fn(async () => {}),
}))

vi.mock('../../packages/server/src/services/hermes/agent-bridge', () => ({
  AgentBridgeClient: vi.fn(() => bridgeMock),
}))

vi.mock('../../packages/server/src/services/hermes/agent-bridge/manager', () => ({
  getAgentBridgeManager: vi.fn(() => ({
    ensureReady: vi.fn(async () => ({
      reachable: true,
      status: 'ready',
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
    })),
  })),
}))

vi.mock('../../packages/server/src/services/hermes/broker-controller', () => ({
  BrokerRunController: class {
    init() {}
    abandonSessionRun() { return false }
  },
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/compression', () => ({
  buildDbHistory: vi.fn(),
  estimateSnapshotAwareHistoryUsage: vi.fn(),
  forceCompressBridgeHistory: vi.fn(),
  getOrCreateSession: vi.fn((sessionMap: Map<string, any>, sessionId: string) => {
    let state = sessionMap.get(sessionId)
    if (!state) {
      state = { messages: [], isWorking: false, events: [], queue: [] }
      sessionMap.set(sessionId, state)
    }
    return state
  }),
  replaceState: vi.fn((sessionMap: Map<string, any>, sessionId: string, event: string, data: any) => {
    const state = sessionMap.get(sessionId)
    if (state) state.events.push({ event, data })
  }),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/usage', () => ({
  calcAndUpdateUsage: usageMock.calcAndUpdateUsage,
  contextTokensWithCachedOverhead: usageMock.contextTokensWithCachedOverhead,
  updateMessageContextTokenUsage: usageMock.updateMessageContextTokenUsage,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/bridge-message', () => ({
  flushBridgePendingToDb: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: vi.fn(() => 'default'),
  getProfileDir: vi.fn(() => '/tmp/hermes-default'),
  listProfileNamesFromDisk: vi.fn(() => ['default']),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/workspace', () => ({
  ensureHermesRunWorkspace: vi.fn(async () => ''),
}))

vi.mock('../../packages/server/src/lib/llm-prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))

vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  authenticateUserToken: vi.fn(),
  isAuthEnabled: vi.fn(async () => false),
}))

vi.mock('../../packages/server/src/db/hermes/users-store', () => ({
  userCanAccessProfile: vi.fn(() => true),
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function harness() {
  const handlers = new Map<string, Function>()
  const sockets = new Map<string, any>()
  const namespace = {
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
    sockets,
    to: vi.fn(() => ({ emit: namespaceEmit, except: vi.fn(() => ({ emit: namespaceEmit })) })),
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
    to: vi.fn(() => ({ emit: namespaceEmit })),
    on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)),
  }
  sockets.set(socket.id, socket)
  return { handlers, io, namespace, socket }
}

describe('bridge session command generation fence', () => {
  let root: string

  beforeEach(async () => {
    vi.clearAllMocks()
    namespaceEmit.mockReset()
    handleBridgeRunMock.mockReset().mockResolvedValue(undefined)
    bridgeMock.command.mockReset()
    bridgeMock.status.mockReset().mockResolvedValue({ exists: true, running: false, current_run_id: null })
    bridgeMock.statusIfLoaded.mockReset().mockResolvedValue({ ok: true, exists: false, running: false, loaded: false })
    bridgeMock.interrupt.mockReset().mockResolvedValue({ ok: true, synced: true })
    bridgeMock.goalPause.mockReset().mockResolvedValue({ ok: true })
    bridgeMock.destroy.mockReset().mockResolvedValue({ ok: true })
    usageMock.calcAndUpdateUsage.mockReset().mockResolvedValue({ inputTokens: 0, outputTokens: 0 })
    root = mkdtempSync(join(tmpdir(), 'hermes-session-command-fence-'))
    dbState.appHome = root
    dbState.db = new DatabaseSync(join(root, 'sessions.db'))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
    const { createSession } = await import('../../packages/server/src/db/hermes/session-store')
    createSession({ id: 'session-1', profile: 'default', source: 'cli' })
  })

  afterEach(() => {
    dbState.db?.close()
    dbState.db = null
    rmSync(root, { recursive: true, force: true })
  })

  it('waits to look up an active /plan until its queued item is dequeued', async () => {
    bridgeMock.command.mockResolvedValue({ handled: true, message: 'expanded plan' })
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, socket } = harness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    const state = {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [],
      source: 'cli',
      runId: 'active-run',
      activeRunMarker: 'active-marker',
      abortController: new AbortController(),
    }
    ;(server as any).sessionMap.set('session-1', state)

    await handlers.get('run')!({
      input: '/plan build it',
      session_id: 'session-1',
      queue_id: 'plan-command',
      source: 'cli',
    })

    expect(bridgeMock.command).not.toHaveBeenCalled()
    expect(state.queue).toEqual([expect.objectContaining({
      queue_id: 'plan-command',
      displayInput: '/plan build it',
      sessionCommand: expect.objectContaining({ name: 'plan', args: 'build it' }),
    })])

    state.isWorking = false
    state.runId = undefined
    state.activeRunMarker = undefined
    state.abortController = undefined
    ;(server as any).dequeueNextQueuedRun(socket, 'session-1', 'default')

    await vi.waitFor(() => expect(bridgeMock.command).toHaveBeenCalledWith('session-1', 'plan build it', 'default'))
    await vi.waitFor(() => expect(handleBridgeRunMock).toHaveBeenCalledTimes(1))
  })

  it('drops a /goal result when real SQLite deletion recreates the same session id during lookup', async () => {
    const command = deferred<any>()
    bridgeMock.command.mockReturnValue(command.promise)
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const {
      createSession,
      deleteSession,
      getSessionDetail,
      getSessionIncarnation,
      getSessionRowId,
    } = await import('../../packages/server/src/db/hermes/session-store')
    const { handlers, io, socket } = harness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)

    const receiving = handlers.get('run')!({
      input: '/goal fix it',
      session_id: 'session-1',
      queue_id: 'goal-command',
      source: 'cli',
    })
    await vi.waitFor(() => expect(bridgeMock.command).toHaveBeenCalledTimes(1))

    const oldRowId = getSessionRowId('session-1')
    const oldIncarnation = getSessionIncarnation('session-1')
    expect(deleteSession('session-1')).toBe(true)
    createSession({ id: 'session-1', profile: 'default', source: 'cli', title: 'replacement' })
    expect(getSessionRowId('session-1')).toBe(oldRowId)
    expect(getSessionIncarnation('session-1')).not.toBe(oldIncarnation)
    command.resolve({
      handled: true,
      action: 'set',
      type: 'goal',
      message: 'Goal set.',
      kickoff_prompt: 'hidden kickoff',
    })
    await receiving

    await vi.waitFor(() => expect((server as any).sessionMap.has('session-1')).toBe(false))
    expect(handleBridgeRunMock).not.toHaveBeenCalled()
    expect(namespaceEmit).not.toHaveBeenCalledWith('session.command', expect.anything())
    expect(getSessionDetail('session-1')?.messages).toEqual([])
  })

  it('cancels a reserved /plan immediately even when lookup never returns', async () => {
    const command = deferred<any>()
    bridgeMock.command.mockReturnValue(command.promise)
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, socket } = harness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)

    void handlers.get('run')!({
      input: '/plan stop before kickoff',
      session_id: 'session-1',
      queue_id: 'plan-abort',
      source: 'cli',
    })
    await vi.waitFor(() => expect(bridgeMock.command).toHaveBeenCalledTimes(1))

    await handlers.get('abort')!({ session_id: 'session-1' })
    const state = (server as any).sessionMap.get('session-1')
    expect(state).toMatchObject({ isWorking: false, isAborting: false })
    expect(state?.activeRunMarker).toBeUndefined()
    expect(state?.commandReservationMarker).toBeUndefined()
    expect(state?.abortController).toBeUndefined()
    expect(handleBridgeRunMock).not.toHaveBeenCalled()
    expect(namespaceEmit).toHaveBeenCalledWith('abort.completed', expect.objectContaining({
      event: 'abort.completed',
      run_id: expect.stringMatching(/^command_/),
      synced: true,
    }))
    expect(namespaceEmit).not.toHaveBeenCalledWith('session.command', expect.anything())
  })

  it('reserves and dequeues the next serialized command after aborting a lookup', async () => {
    const firstCommand = deferred<any>()
    const nextCommand = deferred<any>()
    bridgeMock.command
      .mockReturnValueOnce(firstCommand.promise)
      .mockReturnValueOnce(nextCommand.promise)
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, socket } = harness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)

    void handlers.get('run')!({
      input: '/plan first lookup',
      session_id: 'session-1',
      queue_id: 'plan-first',
      source: 'cli',
    })
    await vi.waitFor(() => expect(bridgeMock.command).toHaveBeenCalledTimes(1))

    await handlers.get('run')!({
      input: '/goal status',
      session_id: 'session-1',
      queue_id: 'goal-next',
      source: 'cli',
    })
    expect(bridgeMock.command).toHaveBeenCalledTimes(1)

    await handlers.get('abort')!({ session_id: 'session-1' })
    await vi.waitFor(() => expect(bridgeMock.command).toHaveBeenNthCalledWith(2, 'session-1', 'goal status', 'default'))
    const reservedNext = (server as any).sessionMap.get('session-1')
    expect(reservedNext).toMatchObject({
      isWorking: true,
      runId: expect.stringMatching(/^command_/),
      activeRunMarker: expect.stringMatching(/^command_/),
      commandReservationMarker: expect.stringMatching(/^command_/),
    })
    expect(reservedNext.runId).toBe(reservedNext.commandReservationMarker)

    nextCommand.resolve({
      handled: true,
      action: 'goal_status',
      type: 'goal',
      message: 'No active goal.',
    })
    await vi.waitFor(() => expect((server as any).sessionMap.get('session-1')).toMatchObject({
      isWorking: false,
      activeRunMarker: undefined,
      commandReservationMarker: undefined,
    }))
    expect(namespaceEmit).toHaveBeenCalledWith('abort.completed', expect.objectContaining({
      queue_length: 1,
      synced: true,
    }))
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      command: 'goal',
      action: 'goal_status',
      message: 'No active goal.\nRun: idle',
    }))
    expect(handleBridgeRunMock).not.toHaveBeenCalled()
  })

  it('does not let an aborted command callback abort the next reserved command', async () => {
    const firstCommand = deferred<any>()
    const nextCommand = deferred<any>()
    bridgeMock.command
      .mockReturnValueOnce(firstCommand.promise)
      .mockReturnValueOnce(nextCommand.promise)
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, socket } = harness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)

    void handlers.get('run')!({
      input: '/plan first lookup',
      session_id: 'session-1',
      queue_id: 'plan-first',
      source: 'cli',
    })
    await vi.waitFor(() => expect(bridgeMock.command).toHaveBeenCalledTimes(1))

    await handlers.get('run')!({
      input: '/goal status',
      session_id: 'session-1',
      queue_id: 'goal-next',
      source: 'cli',
    })
    await handlers.get('abort')!({ session_id: 'session-1' })
    await vi.waitFor(() => expect(bridgeMock.command).toHaveBeenCalledTimes(2))

    const reservedNext = (server as any).sessionMap.get('session-1')
    const nextMarker = reservedNext.commandReservationMarker
    const nextController = reservedNext.abortController as AbortController
    expect(nextController.signal.aborted).toBe(false)

    firstCommand.resolve({ handled: true, message: 'expanded stale plan' })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect((server as any).sessionMap.get('session-1')).toBe(reservedNext)
    expect(reservedNext.commandReservationMarker).toBe(nextMarker)
    expect(reservedNext.abortController).toBe(nextController)
    expect(nextController.signal.aborted).toBe(false)

    nextCommand.resolve({
      handled: true,
      action: 'goal_status',
      type: 'goal',
      message: 'No active goal.',
    })
    await vi.waitFor(() => expect(reservedNext).toMatchObject({
      isWorking: false,
      activeRunMarker: undefined,
      commandReservationMarker: undefined,
    }))
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      command: 'goal',
      action: 'goal_status',
      message: 'No active goal.\nRun: idle',
    }))
  })

  it('reserves a serialized command queued behind a non-bridge run after abort', async () => {
    bridgeMock.command.mockResolvedValue({
      handled: true,
      action: 'goal_status',
      type: 'goal',
      message: 'No active goal.',
    })
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { getSessionIncarnation, getSessionRowId } = await import('../../packages/server/src/db/hermes/session-store')
    const { handlers, io, socket } = harness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    const state = {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [],
      source: 'api_server',
      runId: 'response-run-1',
      abortController: new AbortController(),
      profile: 'default',
      sessionRowId: getSessionRowId('session-1'),
      sessionIncarnation: getSessionIncarnation('session-1'),
    }
    ;(server as any).sessionMap.set('session-1', state)

    await handlers.get('run')!({
      input: '/goal status',
      session_id: 'session-1',
      queue_id: 'goal-after-api',
      source: 'cli',
    })
    expect(bridgeMock.command).not.toHaveBeenCalled()
    expect(state.queue).toEqual([expect.objectContaining({
      queue_id: 'goal-after-api',
      sessionCommand: expect.objectContaining({ name: 'goal' }),
    })])

    handlers.get('abort')!({ session_id: 'session-1' })

    await vi.waitFor(() => expect(bridgeMock.command).toHaveBeenCalledWith('session-1', 'goal status', 'default'))
    await vi.waitFor(() => expect((server as any).sessionMap.get('session-1')).toMatchObject({
      isWorking: false,
      activeRunMarker: undefined,
      commandReservationMarker: undefined,
    }))
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      command: 'goal',
      action: 'goal_status',
    }))
  })

  it('releases a queued /goal reservation and continues FIFO when command persistence fails', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { getSessionIncarnation, getSessionRowId } = await import('../../packages/server/src/db/hermes/session-store')
    const { handlers, io, socket } = harness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    const state = {
      messages: [],
      isWorking: true,
      events: [],
      queue: [],
      runId: 'active-run',
      activeRunMarker: 'active-run',
      abortController: new AbortController(),
      sessionRowId: getSessionRowId('session-1'),
      sessionIncarnation: getSessionIncarnation('session-1'),
    }
    ;(server as any).sessionMap.set('session-1', state)
    dbState.db!.exec(`
      CREATE TRIGGER reject_goal_command_message
      BEFORE INSERT ON messages
      WHEN NEW.role = 'command' AND NEW.content = '/goal persistence-fails'
      BEGIN
        SELECT RAISE(ABORT, 'goal command persistence failed');
      END
    `)
    bridgeMock.command.mockResolvedValueOnce({ handled: true, message: 'expanded next plan' })

    await handlers.get('run')!({
      input: '/goal persistence-fails',
      session_id: 'session-1',
      queue_id: 'goal-fails',
      source: 'cli',
    })
    await handlers.get('run')!({
      input: '/plan next',
      session_id: 'session-1',
      queue_id: 'plan-next',
      source: 'cli',
    })

    state.isWorking = false
    state.runId = undefined
    state.activeRunMarker = undefined
    state.abortController = undefined
    ;(server as any).dequeueNextQueuedRun(socket, 'session-1', 'default')

    await vi.waitFor(() => expect(bridgeMock.command).toHaveBeenCalledWith('session-1', 'plan next', 'default'))
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      command: 'goal',
      ok: false,
      action: 'goal',
      message: expect.stringContaining('goal command persistence failed'),
    }))
    expect(state.commandReservationMarker).toBeUndefined()
  })

  it('releases a queued /plan reservation and continues FIFO when room emit throws', async () => {
    const firstCommand = deferred<any>()
    bridgeMock.command
      .mockReturnValueOnce(firstCommand.promise)
      .mockResolvedValueOnce({
        handled: true,
        action: 'goal_status',
        type: 'goal',
        message: 'No active goal.',
      })
    namespaceEmit.mockImplementation((event: string, payload: any) => {
      if (event === 'session.command' && payload.command === 'plan' && payload.started) {
        throw new Error('session command room emit failed')
      }
    })
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, socket } = harness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)

    void handlers.get('run')!({
      input: '/plan first',
      session_id: 'session-1',
      queue_id: 'plan-first',
      source: 'cli',
    })
    await vi.waitFor(() => expect(bridgeMock.command).toHaveBeenCalledTimes(1))
    await handlers.get('run')!({
      input: '/goal status',
      session_id: 'session-1',
      queue_id: 'goal-next',
      source: 'cli',
    })

    firstCommand.resolve({ handled: true, message: 'expanded first plan' })

    await vi.waitFor(() => expect(bridgeMock.command).toHaveBeenNthCalledWith(2, 'session-1', 'goal status', 'default'))
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      command: 'plan',
      ok: false,
      action: 'plan',
      message: expect.stringContaining('session command room emit failed'),
    }))
  })

  it('drops /status output after real SQLite delete and same-id recreate', async () => {
    const status = deferred<any>()
    bridgeMock.status.mockReturnValueOnce(status.promise)
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { createSession, deleteSession, getSessionDetail } = await import('../../packages/server/src/db/hermes/session-store')
    const { handlers, io, socket } = harness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)

    const receiving = handlers.get('run')!({
      input: '/status',
      session_id: 'session-1',
      queue_id: 'status-old',
      source: 'cli',
    })
    await vi.waitFor(() => expect(bridgeMock.status).toHaveBeenCalledTimes(1))
    expect(deleteSession('session-1')).toBe(true)
    createSession({ id: 'session-1', profile: 'default', source: 'cli', title: 'replacement' })
    status.resolve({ exists: true, running: false, current_run_id: null, message_count: 0 })
    await receiving

    expect(namespaceEmit).not.toHaveBeenCalledWith('session.command', expect.objectContaining({ command: 'status' }))
    expect(getSessionDetail('session-1')?.messages).toEqual([])
  })

  it('does not queue a stale /skill expansion after a same-generation run starts', async () => {
    const skill = deferred<any>()
    bridgeMock.command.mockReturnValueOnce(skill.promise)
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, socket } = harness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)

    const receiving = handlers.get('run')!({
      input: '/skill review it',
      session_id: 'session-1',
      queue_id: 'skill-old',
      source: 'cli',
    })
    await vi.waitFor(() => expect(bridgeMock.command).toHaveBeenCalledTimes(1))
    const state = (server as any).sessionMap.get('session-1')
    const replacementController = new AbortController()
    state.isWorking = true
    state.runId = 'replacement-run'
    state.activeRunMarker = 'replacement-run'
    state.abortController = replacementController
    skill.resolve({ handled: true, type: 'skill', message: 'stale expanded prompt' })
    await receiving

    expect(state.queue).toEqual([])
    expect(state).toMatchObject({ isWorking: true, runId: 'replacement-run', activeRunMarker: 'replacement-run' })
    expect(state.abortController).toBe(replacementController)
    expect(namespaceEmit).not.toHaveBeenCalledWith('session.command', expect.objectContaining({ command: 'skill' }))
  })

  it('does not persist stale /usage output after a same-generation run starts', async () => {
    const usage = deferred<{ inputTokens: number; outputTokens: number }>()
    usageMock.calcAndUpdateUsage.mockReturnValueOnce(usage.promise)
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { getSessionDetail } = await import('../../packages/server/src/db/hermes/session-store')
    const { handlers, io, socket } = harness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)

    const receiving = handlers.get('run')!({
      input: '/usage',
      session_id: 'session-1',
      queue_id: 'usage-old',
      source: 'cli',
    })
    await vi.waitFor(() => expect(usageMock.calcAndUpdateUsage).toHaveBeenCalledTimes(1))
    const state = (server as any).sessionMap.get('session-1')
    state.isWorking = true
    state.runId = 'replacement-run'
    state.activeRunMarker = 'replacement-run'
    state.abortController = new AbortController()
    usage.resolve({ inputTokens: 12, outputTokens: 3 })
    await receiving

    expect(namespaceEmit).not.toHaveBeenCalledWith('session.command', expect.objectContaining({ command: 'usage' }))
    expect(getSessionDetail('session-1')?.messages.map(message => message.content)).toEqual(['/usage'])
  })

  it('does not clear a same-generation replacement run when /destroy returns late', async () => {
    const destroy = deferred<any>()
    bridgeMock.destroy.mockReturnValueOnce(destroy.promise)
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { handlers, io, socket } = harness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)

    const receiving = handlers.get('run')!({
      input: '/destroy',
      session_id: 'session-1',
      queue_id: 'destroy-old',
      source: 'cli',
    })
    await vi.waitFor(() => expect(bridgeMock.destroy).toHaveBeenCalledTimes(1))
    const state = (server as any).sessionMap.get('session-1')
    const replacementController = new AbortController()
    state.isWorking = true
    state.runId = 'replacement-run'
    state.activeRunMarker = 'replacement-run'
    state.abortController = replacementController
    destroy.resolve({ ok: true })
    await receiving

    expect(state).toMatchObject({ isWorking: true, runId: 'replacement-run', activeRunMarker: 'replacement-run' })
    expect(state.abortController).toBe(replacementController)
    expect(namespaceEmit).not.toHaveBeenCalledWith('session.command', expect.objectContaining({ command: 'destroy' }))
  })
})
