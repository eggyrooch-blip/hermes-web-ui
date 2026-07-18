import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateSessionStatsMock = vi.fn()
const flushBridgePendingToDbMock = vi.fn()
const flushResponseRunToDbMock = vi.fn()
const replaceStateMock = vi.fn()
const calcAndUpdateUsageMock = vi.fn()
const getSessionRowIdMock = vi.fn(() => 1)
const getSessionIncarnationMock = vi.fn(() => 1)
const codingAgentRunManagerMock = vi.hoisted(() => ({
  hasSession: vi.fn(() => false),
  stop: vi.fn(() => false),
}))

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSessionIncarnation: getSessionIncarnationMock,
  getSessionRowId: getSessionRowIdMock,
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/bridge-message', () => ({
  flushBridgePendingToDb: flushBridgePendingToDbMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/response-stream', () => ({
  flushResponseRunToDb: flushResponseRunToDbMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/compression', () => ({
  replaceState: replaceStateMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/usage', () => ({
  calcAndUpdateUsage: calcAndUpdateUsageMock,
}))

vi.mock('../../packages/server/src/services/agent-runner/coding-agent-run-manager', () => ({
  codingAgentRunManager: codingAgentRunManagerMock,
}))

function makeHarness() {
  const emit = vi.fn()
  const nsp = {
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
    to: vi.fn(() => ({ emit })),
  }
  const socket = {
    connected: true,
    emit: vi.fn(),
  }
  return { emit, nsp, socket }
}

describe('run chat abort goal handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    codingAgentRunManagerMock.hasSession.mockReturnValue(false)
    codingAgentRunManagerMock.stop.mockReturnValue(false)
    getSessionRowIdMock.mockReturnValue(1)
    getSessionIncarnationMock.mockReturnValue(1)
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 0, outputTokens: 0 })
  })

  it('signals a CLI bridge abort without dequeuing before the stream finalizer', async () => {
    const { handleAbort } = await import('../../packages/server/src/services/hermes/run-chat/abort')
    const { emit, nsp, socket } = makeHarness()
    const state = {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [
        { queue_id: 'goal-1', input: 'continue goal', profile: 'default', goalContinuation: true },
        { queue_id: 'user-1', input: 'normal follow-up', profile: 'default', source: 'cli' },
      ],
      runId: 'run-1',
      activeRunMarker: 'bridge-run-1',
      profile: 'default',
      source: 'cli',
    } as any
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      interrupt: vi.fn().mockResolvedValue({ ok: true }),
      goalPause: vi.fn().mockResolvedValue({ handled: true, status: 'paused', reason: 'user-interrupted' }),
    }
    const runQueuedItem = vi.fn()

    await handleAbort(nsp as any, socket as any, 'session-1', sessionMap, bridge, runQueuedItem)

    expect(bridge.interrupt).toHaveBeenCalledWith('session-1', 'Aborted by user', 'default')
    expect(bridge.goalPause).toHaveBeenCalledWith('session-1', 'user-interrupted', 'default')
    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(state.queue).toEqual([expect.objectContaining({ queue_id: 'user-1' })])
    expect(state.isWorking).toBe(true)
    expect(state.isAborting).toBe(true)
    expect(emit).not.toHaveBeenCalledWith('abort.completed', expect.anything())
  })

  it('releases local working state when a CLI interrupt does not sync before timeout', async () => {
    const { handleAbort } = await import('../../packages/server/src/services/hermes/run-chat/abort')
    const { emit, nsp, socket } = makeHarness()
    const state = {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [
        { queue_id: 'goal-1', input: 'continue goal', profile: 'default', goalContinuation: true },
      ],
      runId: 'run-1',
      activeRunMarker: 'bridge-run-1',
      profile: 'default',
      source: 'cli',
    } as any
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      interrupt: vi.fn().mockResolvedValue({ ok: true, synced: false }),
      goalPause: vi.fn().mockResolvedValue({ handled: true, status: 'paused', reason: 'user-interrupted' }),
      destroy: vi.fn().mockResolvedValue({ destroyed: true }),
    }
    const runQueuedItem = vi.fn()

    await handleAbort(nsp as any, socket as any, 'session-1', sessionMap, bridge, runQueuedItem)

    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(bridge.destroy).toHaveBeenCalledWith('session-1', 'default')
    expect(calcAndUpdateUsageMock).toHaveBeenCalled()
    expect(state.isWorking).toBe(false)
    expect(state.isAborting).toBe(false)
    expect(state.runId).toBeUndefined()
    expect(state.activeRunMarker).toBeUndefined()
    expect(state.queue).toEqual([])
    expect(emit).toHaveBeenCalledWith('abort.timeout', expect.objectContaining({
      session_id: 'session-1',
      run_id: 'run-1',
      synced: false,
    }))
    expect(emit).toHaveBeenCalledWith('abort.completed', expect.objectContaining({
      session_id: 'session-1',
      run_id: 'run-1',
      synced: false,
    }))
  })

  it('stops a coding-agent run even when chat-run state was not marked working', async () => {
    const { handleAbort } = await import('../../packages/server/src/services/hermes/run-chat/abort')
    const { emit, nsp, socket } = makeHarness()
    const sessionMap = new Map()
    codingAgentRunManagerMock.hasSession.mockReturnValue(true)
    codingAgentRunManagerMock.stop.mockReturnValue(true)
    const runQueuedItem = vi.fn()

    await handleAbort(nsp as any, socket as any, 'session-1', sessionMap as any, {}, runQueuedItem)

    expect(codingAgentRunManagerMock.stop).toHaveBeenCalledWith('session-1', { reportClosed: false })
    expect(sessionMap.get('session-1')).toEqual(expect.objectContaining({
      isWorking: false,
      isAborting: false,
      source: 'coding_agent',
    }))
    expect(flushResponseRunToDbMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'coding_agent',
    }), 'session-1')
    expect(emit).toHaveBeenCalledWith('abort.completed', expect.objectContaining({
      session_id: 'session-1',
      synced: true,
    }))
  })

  it('releases and reports an abort when finalization persistence fails', async () => {
    updateSessionStatsMock.mockImplementationOnce(() => { throw new Error('stats failed') })
    const { handleAbort } = await import('../../packages/server/src/services/hermes/run-chat/abort')
    const { emit, nsp, socket } = makeHarness()
    const state = {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [{ queue_id: 'next-1', input: 'next', profile: 'default', source: 'cli' }],
      runId: 'response-run-1',
      abortController: new AbortController(),
      profile: 'default',
      source: 'api_server',
    } as any
    const sessionMap = new Map([['session-1', state]])
    const runQueuedItem = vi.fn()
    const dequeueNextQueuedRun = vi.fn(() => true)

    await handleAbort(
      nsp as any,
      socket as any,
      'session-1',
      sessionMap,
      {},
      runQueuedItem,
      dequeueNextQueuedRun,
    )

    expect(state).toMatchObject({
      isWorking: false,
      isAborting: false,
      runId: undefined,
      activeRunMarker: undefined,
    })
    expect(emit).toHaveBeenCalledWith('abort.completed', expect.objectContaining({
      session_id: 'session-1',
      run_id: 'response-run-1',
      failure_pending: true,
      resume_event_id: expect.any(String),
    }))
    expect(emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({
      session_id: 'session-1',
      error: 'Run finalization failed: stats failed',
      queue_remaining: 1,
      resume_event_id: expect.any(String),
    }))
    expect(state.pendingTerminalEvents).toEqual([
      expect.objectContaining({ id: expect.any(String), event: 'abort.completed' }),
      expect.objectContaining({ id: expect.any(String), event: 'run.failed' }),
    ])
    expect(state.pendingTerminalEvents[0].id).toBe(
      emit.mock.calls.find(call => call[0] === 'abort.completed')?.[1]?.resume_event_id,
    )
    expect(state.pendingTerminalEvents[1].id).toBe(
      emit.mock.calls.find(call => call[0] === 'run.failed')?.[1]?.resume_event_id,
    )
    const events = emit.mock.calls.map(call => call[0])
    expect(events.indexOf('abort.completed')).toBeLessThan(events.indexOf('run.failed'))
    expect(dequeueNextQueuedRun).toHaveBeenCalledWith(socket, 'session-1', 'default')
    expect(runQueuedItem).not.toHaveBeenCalled()
  })

  it('does not let an old API abort finalizer emit into a same-id replacement session', async () => {
    let resolveUsage!: (value: { inputTokens: number; outputTokens: number }) => void
    calcAndUpdateUsageMock.mockReturnValueOnce(new Promise(resolve => { resolveUsage = resolve }))
    const { handleAbort } = await import('../../packages/server/src/services/hermes/run-chat/abort')
    const { emit, nsp, socket } = makeHarness()
    const oldState = {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [],
      runId: 'response-run-old',
      activeRunMarker: 'response-marker-old',
      abortController: new AbortController(),
      profile: 'default',
      source: 'api_server',
      sessionRowId: 1,
      sessionIncarnation: 1,
    } as any
    const sessionMap = new Map([['session-1', oldState]])
    const dequeueNextQueuedRun = vi.fn(() => true)

    const pending = handleAbort(
      nsp as any,
      socket as any,
      'session-1',
      sessionMap,
      {},
      vi.fn(),
      dequeueNextQueuedRun,
    )
    await vi.waitFor(() => expect(calcAndUpdateUsageMock).toHaveBeenCalledTimes(1))

    const replacementState = {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [{ event: 'replacement.started', data: { event: 'replacement.started' } }],
      queue: [],
      runId: 'response-run-replacement',
      activeRunMarker: 'response-marker-replacement',
      profile: 'default',
      source: 'api_server',
      sessionRowId: 1,
      sessionIncarnation: 2,
    } as any
    getSessionIncarnationMock.mockReturnValue(2)
    sessionMap.set('session-1', replacementState)
    emit.mockClear()
    resolveUsage({ inputTokens: 0, outputTokens: 0 })
    await pending

    expect(emit).not.toHaveBeenCalledWith('abort.completed', expect.anything())
    expect(emit).not.toHaveBeenCalledWith('run.failed', expect.anything())
    expect(dequeueNextQueuedRun).not.toHaveBeenCalled()
    expect(sessionMap.get('session-1')).toBe(replacementState)
    expect(replacementState).toEqual(expect.objectContaining({
      isWorking: true,
      isAborting: false,
      runId: 'response-run-replacement',
      activeRunMarker: 'response-marker-replacement',
      events: [{ event: 'replacement.started', data: { event: 'replacement.started' } }],
    }))
  })
})
