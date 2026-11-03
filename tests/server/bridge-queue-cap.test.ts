import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Bridge mode (config.webuiRunBroker=false): the three bridge enqueue points must
// reject past MAX_SESSION_QUEUE like the broker controller does, and pushState must
// keep only the most recent 200 events like the external-run path.

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
const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

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
  AgentBridgeClient: vi.fn(function () { return bridgeMock }),
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

vi.mock('../../packages/server/src/services/hermes/run-chat/usage', () => ({
  calcAndUpdateUsage: vi.fn(async () => ({ inputTokens: 0, outputTokens: 0 })),
  contextTokensWithCachedOverhead: vi.fn(),
  estimateUsageTokensFromMessages: vi.fn(() => 0),
  updateMessageContextTokenUsage: vi.fn(),
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
  logger: loggerMock,
  bridgeLogger: loggerMock,
}))

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

async function workingServer() {
  const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
  const { getOrCreateGenerationBoundSessionState } = await import('../../packages/server/src/services/hermes/run-chat/session-generation')
  const h = harness()
  const server = new ChatRunSocket(h.io as any)
  ;(server as any).onConnection(h.socket)
  const state = getOrCreateGenerationBoundSessionState((server as any).sessionMap, 'session-1')
  Object.assign(state, {
    isWorking: true,
    isAborting: false,
    source: 'cli',
    runId: 'active-run',
    activeRunMarker: 'active-run',
    abortController: new AbortController(),
  })
  return { ...h, server, state }
}

function fillQueue(state: any, count: number) {
  for (let i = 0; i < count; i++) {
    state.queue.push({ queue_id: `prefill-${i}`, input: `prefill ${i}`, profile: 'default', source: 'cli' })
  }
}

function rejections(socket: any) {
  return socket.emit.mock.calls.filter((call: any[]) => call[0] === 'run.rejected').map((call: any[]) => call[1])
}

describe('bridge session queue cap', () => {
  let root: string

  beforeEach(async () => {
    vi.clearAllMocks()
    namespaceEmit.mockReset()
    handleBridgeRunMock.mockReset().mockResolvedValue(undefined)
    bridgeMock.command.mockReset()
    root = mkdtempSync(join(tmpdir(), 'hermes-bridge-queue-cap-'))
    dbState.appHome = root
    dbState.db = new DatabaseSync(join(root, 'sessions.db'))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
    const { createSession } = await import('../../packages/server/src/db/hermes/session-store')
    createSession({ id: 'session-1', profile: 'default', source: 'cli' })
  }, 120_000)

  afterEach(() => {
    dbState.db?.close()
    dbState.db = null
    rmSync(root, { recursive: true, force: true })
  }, 120_000)

  it('exports the broker-aligned cap of 20', async () => {
    const { MAX_SESSION_QUEUE } = await import('../../packages/server/src/services/hermes/run-chat/session-command-queue')
    expect(MAX_SESSION_QUEUE).toBe(20)
  })

  it('socket run: queues the first 20 runs and rejects the next 5 with queue_full', async () => {
    const { handlers, socket, state } = await workingServer()

    for (let i = 0; i < 25; i++) {
      await handlers.get('run')!({ input: `message ${i}`, session_id: 'session-1', queue_id: `q-${i}`, source: 'cli' })
    }

    expect(state.queue.length).toBe(20)
    expect(state.queue.map((item: any) => item.queue_id)).toEqual(Array.from({ length: 20 }, (_, i) => `q-${i}`))

    const queuedEmits = namespaceEmit.mock.calls.filter(call => call[0] === 'run.queued').map(call => call[1])
    expect(queuedEmits.length).toBe(20)
    for (const payload of queuedEmits) {
      expect(payload.queue_length).toBeLessThanOrEqual(20)
      expect(payload.queued_messages.length).toBeLessThanOrEqual(20)
    }

    const rejected = rejections(socket)
    expect(rejected).toEqual(Array.from({ length: 5 }, (_, i) => ({
      event: 'run.rejected',
      session_id: 'session-1',
      queue_id: `q-${20 + i}`,
      error: 'Session queue is full',
      reason: 'queue_full',
    })))
    expect(namespaceEmit).not.toHaveBeenCalledWith('run.rejected', expect.anything())
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('queue full'), 'session-1', 20)
    expect(handleBridgeRunMock).not.toHaveBeenCalled()
  })

  it('socket run: a non-working session still starts immediately (regression guard)', async () => {
    const { handlers, state } = await workingServer()
    Object.assign(state, { isWorking: false, runId: undefined, activeRunMarker: undefined, abortController: undefined })

    await handlers.get('run')!({ input: 'hello', session_id: 'session-1', queue_id: 'q-idle', source: 'cli' })

    await vi.waitFor(() => expect(handleBridgeRunMock).toHaveBeenCalledTimes(1))
    expect(state.queue.length).toBe(0)
  })

  it('session-command-queue: /plan is rejected when the queue already holds 20 items', async () => {
    const { handlers, socket, state } = await workingServer()
    fillQueue(state, 19)

    await handlers.get('run')!({ input: '/plan first', session_id: 'session-1', queue_id: 'plan-20', source: 'cli' })
    expect(state.queue.length).toBe(20)
    expect(state.queue[19]).toMatchObject({ queue_id: 'plan-20', sessionCommand: expect.objectContaining({ name: 'plan' }) })
    expect(rejections(socket)).toEqual([])

    await handlers.get('run')!({ input: '/plan second', session_id: 'session-1', queue_id: 'plan-21', source: 'cli' })
    expect(state.queue.length).toBe(20)
    expect(state.queue.some((item: any) => item.queue_id === 'plan-21')).toBe(false)
    expect(rejections(socket)).toEqual([{
      event: 'run.rejected',
      session_id: 'session-1',
      queue_id: 'plan-21',
      error: 'Session queue is full',
      reason: 'queue_full',
    }])
    expect(bridgeMock.command).not.toHaveBeenCalled()
    for (const call of namespaceEmit.mock.calls.filter(c => c[0] === 'run.queued')) {
      expect(call[1].queued_messages.length).toBeLessThanOrEqual(20)
    }
  })

  it('enqueueSerializedSessionCommand reports rejection without pushing when full', async () => {
    const { enqueueSerializedSessionCommand } = await import('../../packages/server/src/services/hermes/run-chat/session-command-queue')
    const { server, state } = await workingServer()
    fillQueue(state, 20)

    const result = enqueueSerializedSessionCommand({
      sessionId: 'session-1',
      command: { name: 'goal', rawName: 'goal', args: 'x' },
      state,
      sessionMap: (server as any).sessionMap,
      queueId: 'goal-21',
      profile: 'default',
    } as any)

    expect(result.queued).toBeNull()
    expect(result.canStart).toBe(false)
    expect(result.rejected).toBe('queue_full')
    expect(state.queue.length).toBe(20)
  })

  it('session-command /skill: expanded prompt is rejected when the queue already holds 20 items', async () => {
    bridgeMock.command.mockResolvedValue({ handled: true, type: 'skill', message: 'expanded skill prompt' })
    const { handlers, socket, state } = await workingServer()
    fillQueue(state, 19)

    await handlers.get('run')!({ input: '/skill review it', session_id: 'session-1', queue_id: 'skill-20', source: 'cli' })
    expect(state.queue.length).toBe(20)
    expect(state.queue[19]).toMatchObject({ queue_id: 'skill-20', input: 'expanded skill prompt' })
    expect(rejections(socket)).toEqual([])

    await handlers.get('run')!({ input: '/skill review again', session_id: 'session-1', queue_id: 'skill-21', source: 'cli' })
    expect(bridgeMock.command).toHaveBeenCalledTimes(2)
    expect(state.queue.length).toBe(20)
    expect(state.queue.some((item: any) => item.queue_id === 'skill-21')).toBe(false)
    expect(rejections(socket)).toEqual([{
      event: 'run.rejected',
      session_id: 'session-1',
      queue_id: 'skill-21',
      error: 'Session queue is full',
      reason: 'queue_full',
    }])
    for (const call of namespaceEmit.mock.calls.filter(c => c[0] === 'run.queued')) {
      expect(call[1].queued_messages.length).toBeLessThanOrEqual(20)
    }
  })
  it('session-command /queue: 25 messages on a working session queue 20 and reject the last 5', async () => {
    const { handlers, socket, state } = await workingServer()

    for (let i = 0; i < 25; i++) {
      await handlers.get('run')!({ input: `/queue follow-up ${i}`, session_id: 'session-1', queue_id: `qc-${i}`, source: 'cli' })
    }

    expect(state.queue.length).toBe(20)
    expect(state.queue.map((item: any) => item.input)).toEqual(Array.from({ length: 20 }, (_, i) => `follow-up ${i}`))
    expect(rejections(socket)).toEqual(Array.from({ length: 5 }, (_, i) => ({
      event: 'run.rejected',
      session_id: 'session-1',
      queue_id: `qc-${20 + i}`,
      error: 'Session queue is full',
      reason: 'queue_full',
    })))
    const queuedEmits = namespaceEmit.mock.calls.filter(call => call[0] === 'run.queued').map(call => call[1])
    expect(queuedEmits.length).toBe(20)
    for (const payload of queuedEmits) expect(payload.queued_messages.length).toBeLessThanOrEqual(20)
    expect(handleBridgeRunMock).not.toHaveBeenCalled()
  })
})

describe('bridge pushState events cap', () => {
  it('keeps only the most recent 200 events after 1000 pushes', async () => {
    const { pushState } = await import('../../packages/server/src/services/hermes/run-chat/compression')
    const sessionMap = new Map<string, any>()
    for (let i = 0; i < 1000; i++) pushState(sessionMap, 'session-x', 'tool.completed', { i })

    const events = sessionMap.get('session-x').events
    expect(events.length).toBe(200)
    expect(events[0]).toEqual({ event: 'tool.completed', data: { i: 800 } })
    expect(events[199]).toEqual({ event: 'tool.completed', data: { i: 999 } })
    expect(events.map((e: any) => e.data.i)).toEqual(Array.from({ length: 200 }, (_, k) => 800 + k))
  })
})
