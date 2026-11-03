import { beforeEach, describe, expect, it, vi } from 'vitest'

const addMessageMock = vi.fn()
const updateSessionStatsMock = vi.fn()
const updateUsageMock = vi.fn()
const calcAndUpdateUsageMock = vi.fn()
const buildDbHistoryMock = vi.fn()
const buildSnapshotAwareHistoryMock = vi.fn()
const estimateUsageTokensFromMessagesMock = vi.fn()

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  addMessage: addMessageMock,
  createSession: vi.fn(),
  getSession: vi.fn(() => ({ id: 'session-resume', profile: 'default', model: 'gpt-test', provider: 'openai' })),
  getSessionIncarnation: vi.fn(() => 1),
  getSessionRowId: vi.fn(() => 1),
  updateSession: vi.fn(),
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({
  updateUsage: updateUsageMock,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/lib/llm-prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))

vi.mock('../../packages/server/src/lib/context-compressor', () => ({
  countTokens: vi.fn(() => 1),
  SUMMARY_PREFIX: '[Summary] ',
}))

vi.mock('../../packages/server/src/db/hermes/compression-snapshot', () => ({
  getCompressionSnapshot: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/compression', async () => {
  const actual = await vi.importActual<any>('../../packages/server/src/services/hermes/run-chat/compression')
  return {
    ...actual,
    buildDbHistory: buildDbHistoryMock,
    buildSnapshotAwareHistory: buildSnapshotAwareHistoryMock,
    buildCompressedHistory: vi.fn(),
    forceCompressBridgeHistory: vi.fn(),
  }
})

vi.mock('../../packages/server/src/services/hermes/run-chat/usage', () => ({
  calcAndUpdateUsage: calcAndUpdateUsageMock,
  contextTokensWithCachedOverhead: vi.fn((_state, tokens) => tokens),
  estimateUsageTokensFromMessages: estimateUsageTokensFromMessagesMock,
  getCachedBridgeContextOverhead: vi.fn(() => undefined),
  updateMessageContextTokenUsage: vi.fn((_sid, state, _emit, tokens) => {
    state.contextTokens = tokens
    return tokens
  }),
}))

function createNamespace() {
  const emitted: Array<{ event: string; payload: any }> = []
  return {
    emitted,
    nsp: {
      adapter: { rooms: { get: vi.fn(() => new Set(['socket-1'])) } },
      to: vi.fn(() => ({
        emit: vi.fn((event: string, payload: any) => emitted.push({ event, payload })),
      })),
    },
  }
}

describe('resumeBridgeRun', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    addMessageMock.mockReturnValue(42)
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 3, outputTokens: 2 })
    buildDbHistoryMock.mockResolvedValue([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hello world' },
    ])
    buildSnapshotAwareHistoryMock.mockResolvedValue([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hello world' },
    ])
    estimateUsageTokensFromMessagesMock.mockReturnValue({ inputTokens: 3, outputTokens: 2 })
  })

  it('continues polling an existing bridge run after web server state is recreated', async () => {
    const { resumeBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    const { nsp, emitted } = createNamespace()
    const socket = { id: 'socket-1', connected: true, emit: vi.fn() }
    const sessionMap = new Map<string, any>()
    sessionMap.set('session-resume', {
      messages: [
        { id: 1, session_id: 'session-resume', role: 'user', content: 'hello', timestamp: 1 },
        { id: 2, session_id: 'session-resume', role: 'assistant', content: 'Hello', timestamp: 2 },
      ],
      isWorking: true,
      events: [],
      queue: [],
    })

    const bridge = {
      getResult: vi.fn(async () => ({
        ok: true,
        run_id: 'run-resume',
        session_id: 'session-resume',
        status: 'running',
        output: 'Hello',
        deltas: ['Hello'],
        events: [],
      })),
      getOutput: vi.fn(async () => ({
        ok: true,
        run_id: 'run-resume',
        session_id: 'session-resume',
        status: 'complete',
        delta: ' world',
        cursor: 2,
        output: 'Hello world',
        done: true,
        result: { final_response: 'Hello world' },
        error: null,
        events: [],
        event_cursor: 0,
      })),
      contextEstimate: vi.fn(async () => ({
        ok: true,
        session_id: 'session-resume',
        fixed_context_tokens: 0,
        system_prompt_tokens: 0,
        tool_tokens: 0,
        message_count: 0,
        tool_count: 0,
        system_prompt_chars: 0,
      })),
      goalEvaluate: vi.fn(async () => ({
        ok: true,
        session_id: 'session-resume',
        handled: true,
        should_continue: false,
      })),
    }

    await resumeBridgeRun(
      nsp as any,
      socket as any,
      {
        sessionId: 'session-resume',
        runId: 'run-resume',
        profile: 'default',
        instructions: 'system prompt',
        model: 'gpt-test',
        provider: 'openai',
      },
      sessionMap,
      bridge as any,
      vi.fn(),
    )

    expect(bridge.getResult).toHaveBeenCalledWith('run-resume')
    expect(bridge.getOutput).toHaveBeenCalledWith('run-resume', 1, 0)
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'message.delta',
        payload: expect.objectContaining({ delta: ' world', session_id: 'session-resume' }),
      }),
      expect.objectContaining({
        event: 'run.completed',
        payload: expect.objectContaining({ output: 'Hello world', session_id: 'session-resume' }),
      }),
    ]))
    expect(sessionMap.get('session-resume').isWorking).toBe(false)
  })

  it('completes a timed-out abort when the resumed bridge run reaches a terminal state', async () => {
    const { resumeBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    const { nsp, emitted } = createNamespace()
    const socket = { id: 'socket-1', connected: true, emit: vi.fn() }
    const sessionMap = new Map<string, any>()
    sessionMap.set('session-resume', {
      messages: [
        { id: 1, session_id: 'session-resume', role: 'user', content: 'hello', timestamp: 1 },
        { id: 2, session_id: 'session-resume', role: 'assistant', content: 'Hello', timestamp: 2, isStreaming: true },
      ],
      isWorking: true,
      isAborting: true,
      runId: 'run-resume',
      profile: 'default',
      source: 'cli',
      events: [],
      queue: [],
    })

    const bridge = {
      getResult: vi.fn(async () => ({
        ok: true,
        run_id: 'run-resume',
        session_id: 'session-resume',
        status: 'running',
        output: 'Hello',
        deltas: ['Hello'],
        events: [],
      })),
      getOutput: vi.fn(async () => ({
        ok: true,
        run_id: 'run-resume',
        session_id: 'session-resume',
        status: 'interrupted',
        delta: '',
        cursor: 1,
        output: 'Hello',
        done: true,
        result: { interrupted: true, completed: false, final_response: 'Operation interrupted' },
        error: null,
        events: [],
        event_cursor: 0,
      })),
    }

    await resumeBridgeRun(
      nsp as any,
      socket as any,
      {
        sessionId: 'session-resume',
        runId: 'run-resume',
        profile: 'default',
        instructions: 'system prompt',
        model: 'gpt-test',
        provider: 'openai',
      },
      sessionMap,
      bridge as any,
      vi.fn(),
    )

    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'abort.completed',
        payload: expect.objectContaining({ session_id: 'session-resume', run_id: 'run-resume', synced: true }),
      }),
    ]))
    expect(emitted.some(item => item.event === 'run.failed')).toBe(false)
    expect(sessionMap.get('session-resume')).toEqual(expect.objectContaining({
      isWorking: false,
      isAborting: false,
      runId: undefined,
    }))
  })

  it('dequeues a normal queued run after resumed bridge polling fails', async () => {
    const { resumeBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    const { nsp, emitted } = createNamespace()
    const socket = { id: 'socket-1', connected: true, emit: vi.fn() }
    const state = {
      messages: [],
      isWorking: true,
      events: [],
      queue: [{ queue_id: 'queued-normal', input: 'next', profile: 'other', source: 'cli' }],
    }
    const sessionMap = new Map<string, any>([['session-resume', state]])
    const bridge = {
      getResult: vi.fn(async () => ({ output: '', deltas: [], events: [] })),
      getOutput: vi.fn(async () => { throw new Error('resume polling failed') }),
    }
    const dequeueNextQueuedRun = vi.fn()

    await resumeBridgeRun(
      nsp as any,
      socket as any,
      {
        sessionId: 'session-resume',
        runId: 'run-resume',
        profile: 'default',
        instructions: 'system prompt',
      },
      sessionMap,
      bridge as any,
      dequeueNextQueuedRun,
    )

    expect(emitted).toContainEqual(expect.objectContaining({
      event: 'run.failed',
      payload: expect.objectContaining({
        run_id: 'run-resume',
        error: 'resume polling failed',
        queue_remaining: 1,
      }),
    }))
    expect(state).toMatchObject({
      isWorking: false,
      isAborting: false,
      runId: undefined,
      activeRunMarker: undefined,
    })
    expect(dequeueNextQueuedRun).toHaveBeenCalledWith(socket, 'session-resume', 'default')
  })

  it('lets unified dequeue reserve a session command after resumed bridge polling fails', async () => {
    const { resumeBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    const { reserveQueuedSessionCommand } = await import('../../packages/server/src/services/hermes/run-chat/session-command-queue')
    const { nsp } = createNamespace()
    const socket = { id: 'socket-1', connected: true, emit: vi.fn() }
    const queuedCommand: any = {
      queue_id: 'queued-command',
      input: '/goal status',
      profile: 'default',
      source: 'cli',
      sessionCommand: {
        name: 'goal',
        rawName: 'goal',
        args: 'status',
        sessionRowId: 1,
        sessionIncarnation: 1,
      },
    }
    const state: any = {
      messages: [],
      isWorking: true,
      events: [],
      queue: [queuedCommand],
    }
    const sessionMap = new Map<string, any>([['session-resume', state]])
    const bridge = {
      getResult: vi.fn(async () => ({ output: '', deltas: [], events: [] })),
      getOutput: vi.fn(async () => { throw new Error('resume polling failed') }),
    }
    const dequeueNextQueuedRun = vi.fn((_socket: any, sessionId: string) => {
      const exactState = sessionMap.get(sessionId)
      const next = exactState.queue.shift()
      const reservation = reserveQueuedSessionCommand(sessionId, exactState, next)
      expect(reservation).not.toBeNull()
    })

    await resumeBridgeRun(
      nsp as any,
      socket as any,
      {
        sessionId: 'session-resume',
        runId: 'run-resume',
        profile: 'default',
        instructions: 'system prompt',
      },
      sessionMap,
      bridge as any,
      dequeueNextQueuedRun,
    )

    expect(dequeueNextQueuedRun).toHaveBeenCalledWith(socket, 'session-resume', 'default')
    expect(queuedCommand.commandReservation).toEqual(expect.objectContaining({
      marker: expect.stringMatching(/^command_/),
      sessionRowId: 1,
      sessionIncarnation: 1,
    }))
    expect(state).toMatchObject({
      isWorking: true,
      isAborting: false,
      runId: expect.stringMatching(/^command_/),
      activeRunMarker: expect.stringMatching(/^command_/),
      commandReservationMarker: expect.stringMatching(/^command_/),
    })
    expect(state.runId).toBe(state.commandReservationMarker)
  })
})
