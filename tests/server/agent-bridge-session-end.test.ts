import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getSystemPromptMock = vi.fn()
const getSessionMock = vi.fn()
const getSessionRowIdMock = vi.fn()
const getSessionIncarnationMock = vi.fn()
const createSessionMock = vi.fn()
const addMessageMock = vi.fn()
const updateSessionMock = vi.fn()
const updateSessionStatsMock = vi.fn()
const updateUsageMock = vi.fn()
const buildCompressedHistoryMock = vi.fn()
const buildDbHistoryMock = vi.fn()
const buildSnapshotAwareHistoryMock = vi.fn(async (_sessionId: string, _profile: string, history: any[]) => history)
const pushStateMock = vi.fn()
const replaceStateMock = vi.fn()
const forceCompressBridgeHistoryMock = vi.fn()
const calcAndUpdateUsageMock = vi.fn()
const estimateUsageTokensFromMessagesMock = vi.fn()
const updateContextTokenUsageMock = vi.fn((sid: string, state: any, emit: any, contextTokens: number, usage?: { inputTokens: number; outputTokens: number }) => {
  state.contextTokens = contextTokens
  emit('usage.updated', {
    event: 'usage.updated',
    session_id: sid,
    inputTokens: usage?.inputTokens ?? state.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? state.outputTokens ?? 0,
    contextTokens,
  })
  return contextTokens
})
const getCachedBridgeContextOverheadMock = vi.fn(() => undefined)
const contextTokensWithCachedOverheadMock = vi.fn((_state: any, messageTokens: number) => messageTokens)
const updateMessageContextTokenUsageMock = vi.fn((sid: string, state: any, emit: any, messageTokens: number, usage?: { inputTokens: number; outputTokens: number }) => updateContextTokenUsageMock(sid, state, emit, messageTokens, usage))
const flushBridgePendingToDbMock = vi.fn()
const ensureOpenBridgeAssistantMessageMock = vi.fn()
const syncBridgeReasoningToMessageMock = vi.fn()
const recordBridgeToolStartedMock = vi.fn()
const recordBridgeToolCompletedMock = vi.fn()
const resolveBridgeRunModelConfigMock = vi.fn()
const issueModelRunJwtMock = vi.fn(async () => 'model-run-token')
const startWorkspaceRunCheckpointMock = vi.fn()
const completeWorkspaceRunCheckpointMock = vi.fn()
const discardWorkspaceRunCheckpointMock = vi.fn()
const homes: string[] = []

vi.mock('../../packages/server/src/lib/llm-prompt', () => ({
  getSystemPrompt: getSystemPromptMock,
}))

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSession: getSessionMock,
  getSessionRowId: getSessionRowIdMock,
  getSessionIncarnation: getSessionIncarnationMock,
  createSession: createSessionMock,
  addMessage: addMessageMock,
  updateSession: updateSessionMock,
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({
  updateUsage: updateUsageMock,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/compression', () => ({
  getOrCreateSession: getOrCreateSessionMock,
  buildCompressedHistory: buildCompressedHistoryMock,
  buildDbHistory: buildDbHistoryMock,
  buildSnapshotAwareHistory: buildSnapshotAwareHistoryMock,
  pushState: pushStateMock,
  replaceState: replaceStateMock,
  forceCompressBridgeHistory: forceCompressBridgeHistoryMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/usage', () => ({
  calcAndUpdateUsage: calcAndUpdateUsageMock,
  estimateUsageTokensFromMessages: estimateUsageTokensFromMessagesMock,
  getCachedBridgeContextOverhead: getCachedBridgeContextOverheadMock,
  contextTokensWithCachedOverhead: contextTokensWithCachedOverheadMock,
  updateContextTokenUsage: updateContextTokenUsageMock,
  updateMessageContextTokenUsage: updateMessageContextTokenUsageMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/bridge-message', () => ({
  flushBridgePendingToDb: flushBridgePendingToDbMock,
  ensureOpenBridgeAssistantMessage: ensureOpenBridgeAssistantMessageMock,
  syncBridgeReasoningToMessage: syncBridgeReasoningToMessageMock,
  recordBridgeToolStarted: recordBridgeToolStartedMock,
  recordBridgeToolCompleted: recordBridgeToolCompletedMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/model-config', () => ({
  resolveBridgeRunModelConfig: resolveBridgeRunModelConfigMock,
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker', () => ({
  startWorkspaceRunCheckpoint: startWorkspaceRunCheckpointMock,
  completeWorkspaceRunCheckpoint: completeWorkspaceRunCheckpointMock,
  discardWorkspaceRunCheckpoint: discardWorkspaceRunCheckpointMock,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: (profile: string) => `/tmp/hermes-bridge-session-end/${profile || 'default'}`,
}))

vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  issueModelRunJwt: issueModelRunJwtMock,
}))

const runIdForSessionMock = vi.fn(() => 'agent-run-1')
const isSessionLaunchCompatibleMock = vi.fn(() => true)
const isSessionProcessingMock = vi.fn(() => false)
const stopCodingAgentMock = vi.fn()
const sendCodingAgentRunInputMock = vi.fn(async () => undefined)
const startCodingAgentRunMock = vi.fn(async () => ({ agentSessionId: 'agent-run-1' }))
const getOrCreateSessionMock = vi.fn()

vi.mock('../../packages/server/src/services/agent-runner/coding-agent-run-manager', () => ({
  codingAgentRunManager: {
    runIdForSession: runIdForSessionMock,
    isSessionLaunchCompatible: isSessionLaunchCompatibleMock,
    isSessionProcessing: isSessionProcessingMock,
    stop: stopCodingAgentMock,
    hasSession: vi.fn(() => false),
  },
}))

vi.mock('../../packages/server/src/services/coding-agents', () => ({
  sendCodingAgentRunInput: sendCodingAgentRunInputMock,
  startCodingAgentRun: startCodingAgentRunMock,
}))

function makeSocket() {
  return {
    connected: true,
    emit: vi.fn(),
    join: vi.fn(),
    to: vi.fn(() => ({ emit: vi.fn() })),
    data: {},
  } as any
}

function makeNamespace(emit: ReturnType<typeof vi.fn>) {
  const room = new Set(['socket-1'])
  return {
    adapter: { rooms: new Map([['session:session-1', room]]) },
    to: vi.fn(() => ({ emit })),
  } as any
}

function makeState() {
  return {
    messages: [],
    isWorking: false,
    events: [],
    queue: [],
  } as any
}

describe('bridge run session end markers', () => {
  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-bridge-session-end-'))
    homes.push(home)
    process.env.HERMES_WEB_UI_HOME = home
    rmSync('/tmp/hermes-bridge-session-end', { recursive: true, force: true })
    mkdirSync('/tmp/hermes-bridge-session-end/default/workspace/explicit', { recursive: true })
    mkdirSync('/tmp/hermes-bridge-session-end/default/workspace/stored', { recursive: true })
    vi.clearAllMocks()
    getSystemPromptMock.mockReturnValue('system prompt')
    issueModelRunJwtMock.mockResolvedValue('model-run-token')
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', model: '', provider: '' })
    getSessionRowIdMock.mockReturnValue(1)
    getSessionIncarnationMock.mockReturnValue(1)
    resolveBridgeRunModelConfigMock.mockResolvedValue({ model: 'gpt-test', provider: 'openai' })
    buildCompressedHistoryMock.mockResolvedValue([{ role: 'user', content: 'previous' }])
    buildDbHistoryMock.mockResolvedValue([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'done' },
    ])
    buildSnapshotAwareHistoryMock.mockImplementation(async (_sessionId: string, _profile: string, history: any[]) => history)
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 11, outputTokens: 7 })
    estimateUsageTokensFromMessagesMock.mockReturnValue({ inputTokens: 11, outputTokens: 7 })
    startWorkspaceRunCheckpointMock.mockReset()
    completeWorkspaceRunCheckpointMock.mockReset()
    completeWorkspaceRunCheckpointMock.mockReturnValue(null)
    discardWorkspaceRunCheckpointMock.mockReset()
    getCachedBridgeContextOverheadMock.mockImplementation((state: any) => {
      const fixed = state?.bridgeContext?.fixedContextTokens
      return typeof fixed === 'number' ? fixed : undefined
    })
    contextTokensWithCachedOverheadMock.mockImplementation((state: any, messageTokens: number) => {
      const fixed = state?.bridgeContext?.fixedContextTokens
      return typeof fixed === 'number' ? fixed + messageTokens : messageTokens
    })
    updateMessageContextTokenUsageMock.mockImplementation((sid: string, state: any, emit: any, messageTokens: number, usage?: { inputTokens: number; outputTokens: number }) => {
      const contextTokens = contextTokensWithCachedOverheadMock(state, messageTokens)
      return updateContextTokenUsageMock(sid, state, emit, contextTokens, usage)
    })
  })

  afterEach(() => {
    delete process.env.HERMES_WEB_UI_HOME
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
    rmSync('/tmp/hermes-bridge-session-end', { recursive: true, force: true })
  })


  function makeBridge(streamOutput: any) {
    return {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 100,
        fixed_context_tokens: 90,
        message_count: 2,
        tool_count: 0,
        system_prompt_chars: 13,
      }),
      streamOutput,
    } as any
  }

  async function runBridge(
    bridge: any,
    state: any,
    emit: ReturnType<typeof vi.fn>,
    options: { user?: any; loadSessionStateFromDb?: any; emptySessionMap?: boolean } = {},
  ) {
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    if (options.user) socket.data.user = options.user
    const sessionMap = options.emptySessionMap
      ? new Map<string, any>()
      : new Map([['session-1', state]])
    const loadSessionStateFromDb = options.loadSessionStateFromDb
      ?? vi.fn(async () => state)
    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      loadSessionStateFromDb,
      vi.fn(),
    )
  }

  function endMarkerCalls() {
    return updateSessionMock.mock.calls.filter(([sessionId, data]: any[]) => (
      sessionId === 'session-1' && typeof data?.ended_at === 'number'
    ))
  }

  function reopenCalls() {
    return updateSessionMock.mock.calls.filter(([sessionId, data]: any[]) => (
      sessionId === 'session-1' && data?.ended_at === null && data?.end_reason === null
    ))
  }

  it('reopens an ended session before the run and closes it as complete afterwards', async () => {
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      model: 'gpt-test',
      provider: 'openai',
      ended_at: 1_770_000_000,
      end_reason: 'complete',
    })
    const emit = vi.fn()
    const state = makeState()
    await runBridge(makeBridge(vi.fn(async function* () {
      yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
    })), state, emit)

    const reopenIndex = updateSessionMock.mock.calls.findIndex(([sessionId, data]: any[]) => (
      sessionId === 'session-1' && data?.ended_at === null && data?.end_reason === null && typeof data?.last_active === 'number'
    ))
    const endedIndex = updateSessionMock.mock.calls.findIndex(([sessionId, data]: any[]) => (
      sessionId === 'session-1' && typeof data?.ended_at === 'number' && data?.end_reason === 'complete'
    ))

    expect(reopenIndex).toBeGreaterThanOrEqual(0)
    expect(endedIndex).toBeGreaterThanOrEqual(0)
    expect(reopenIndex).toBeLessThan(endedIndex)
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({ output: 'done' }))
  })

  it('writes end_reason error when the terminal chunk reports a failure', async () => {
    const emit = vi.fn()
    const state = makeState()
    await runBridge(makeBridge(vi.fn(async function* () {
      yield {
        run_id: 'run-1',
        done: true,
        status: 'error',
        error: 'bridge crashed',
        output: '',
      }
    })), state, emit)

    expect(endMarkerCalls()).toEqual([
      ['session-1', expect.objectContaining({ end_reason: 'error' })],
    ])
    expect(emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({ error: 'bridge crashed' }))
  })

  it('writes end_reason error when the bridge stream throws and nothing is queued', async () => {
    const emit = vi.fn()
    const state = makeState()
    await runBridge(makeBridge(vi.fn(async function* () {
      throw new Error('stream exploded')
    })), state, emit)

    expect(endMarkerCalls()).toEqual([
      ['session-1', expect.objectContaining({ end_reason: 'error' })],
    ])
    expect(emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({ error: 'stream exploded' }))
  })

  it('leaves the session open when a queued run will continue it', async () => {
    const emit = vi.fn()
    const state = makeState()
    state.queue = [{ input: 'next', session_id: 'session-1' }]
    await runBridge(makeBridge(vi.fn(async function* () {
      throw new Error('stream exploded')
    })), state, emit)

    expect(endMarkerCalls()).toEqual([])
    expect(reopenCalls().length).toBeGreaterThan(0)
  })

  it('reopens an ended coding-agent session when a new run starts', async () => {
    const state = makeState()
    getOrCreateSessionMock.mockReturnValue(state)
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', model: '', provider: '', ended_at: 1_770_000_000, end_reason: 'complete' })

    const { handleCodingAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-coding-agent-run')
    await handleCodingAgentRun(
      makeNamespace(vi.fn()),
      makeSocket(),
      { input: 'hello', session_id: 'session-1' },
      'default',
      new Map([['session-1', state]]),
    )

    expect(reopenCalls()).toEqual([
      ['session-1', expect.objectContaining({ ended_at: null, end_reason: null, last_active: expect.any(Number) })],
    ])
    expect(endMarkerCalls()).toEqual([])
  })

  it('writes end_reason error when a coding-agent send fails and nothing is processing', async () => {
    const state = makeState()
    getOrCreateSessionMock.mockReturnValue(state)
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', model: '', provider: '' })
    sendCodingAgentRunInputMock.mockRejectedValueOnce(new Error('send failed'))
    isSessionProcessingMock.mockReturnValue(false)

    const { handleCodingAgentRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-coding-agent-run')
    await expect(handleCodingAgentRun(
      makeNamespace(vi.fn()),
      makeSocket(),
      { input: 'hello', session_id: 'session-1' },
      'default',
      new Map([['session-1', state]]),
    )).rejects.toThrow('send failed')

    expect(endMarkerCalls()).toEqual([
      ['session-1', expect.objectContaining({ end_reason: 'error' })],
    ])
  })

  it('closes the session when the run-token write fails during preflight', async () => {
    const emit = vi.fn()
    const state = makeState()
    issueModelRunJwtMock.mockRejectedValueOnce(new Error('EACCES: run token write failed'))

    await expect(runBridge(
      makeBridge(vi.fn(async function* () { yield { run_id: 'run-1', done: true, status: 'completed' } })),
      state,
      emit,
      { user: { id: 1, openid: 'ou_test', role: 'super_admin' } },
    )).rejects.toThrow('EACCES: run token write failed')

    expect(reopenCalls().length).toBe(1)
    expect(endMarkerCalls()).toEqual([
      ['session-1', expect.objectContaining({ end_reason: 'error' })],
    ])
  })

  it('closes the session when loading session history fails during preflight', async () => {
    const emit = vi.fn()
    const state = makeState()

    // An empty session map makes the admission ask for a DB state load, which is
    // the first preflight step after the session is reopened.
    await expect(runBridge(
      makeBridge(vi.fn(async function* () { yield { run_id: 'run-1', done: true, status: 'completed' } })),
      state,
      emit,
      {
        emptySessionMap: true,
        loadSessionStateFromDb: vi.fn(async () => { throw new Error('history load failed') }),
      },
    )).rejects.toThrow('history load failed')

    expect(reopenCalls().length).toBe(1)
    expect(endMarkerCalls()).toEqual([
      ['session-1', expect.objectContaining({ end_reason: 'error' })],
    ])
  })

  it('leaves the session open on a preflight failure when a queued run will continue it', async () => {
    const emit = vi.fn()
    const state = makeState()
    state.queue = [{ input: 'next', session_id: 'session-1' }]
    issueModelRunJwtMock.mockRejectedValueOnce(new Error('EACCES: run token write failed'))

    await expect(runBridge(
      makeBridge(vi.fn(async function* () { yield { run_id: 'run-1', done: true, status: 'completed' } })),
      state,
      emit,
      { user: { id: 1, openid: 'ou_test', role: 'super_admin' } },
    )).rejects.toThrow('EACCES: run token write failed')

    expect(reopenCalls().length).toBe(1)
    expect(endMarkerCalls()).toEqual([])
  })
})
