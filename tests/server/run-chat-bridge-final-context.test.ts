import { mkdtempSync, readFileSync, rmSync } from 'fs'
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
  getProfileDir: (profile: string) => `/tmp/hermes-bridge-final-context/${profile || 'default'}`,
}))

vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  issueModelRunJwt: issueModelRunJwtMock,
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

describe('bridge run final context usage', () => {
  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-bridge-run-token-'))
    homes.push(home)
    process.env.HERMES_WEB_UI_HOME = home
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
  })

  it('refreshes full context tokens when a bridge run completes', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        fixed_context_tokens: 12327,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(bridge.contextEstimate).toHaveBeenCalledWith(
      'session-1',
      [],
      expect.not.stringContaining('[Current Hermes profile:'),
      'default',
      { model: 'gpt-test', provider: 'openai' },
    )
    expect(bridge.contextEstimate.mock.calls[0][2]).toContain('system prompt')
    expect(bridge.contextEstimate.mock.calls[0][2]).toContain('X-Hermes-Profile')
    expect(state.contextTokens).toBe(12345)
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 12345,
    }))
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 12345,
    }))
  })

  it('releases working state when the bridge stream ends without a terminal chunk', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        fixed_context_tokens: 12327,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          session_id: 'session-1',
          done: false,
          status: 'running',
          delta: 'partial reply',
          cursor: 1,
          output: 'partial reply',
          events: [],
          event_cursor: 0,
        }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(state.isWorking).toBe(false)
    expect(state.isAborting).toBe(false)
    expect(state.runId).toBeUndefined()
    expect(state.activeRunMarker).toBeUndefined()
    expect(emit).toHaveBeenCalledWith('message.delta', expect.objectContaining({
      delta: 'partial reply',
    }))
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      output: 'partial reply',
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 12345,
    }))
  })

  it('emits workspace diff summary for an explicit workspace before bridge completion', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    // Explicit, but inside the profile workspace — ensureHermesRunWorkspace now
    // contains every run path, so an out-of-tree value would be rewritten to the
    // profile default (see run-workspace-containment.test.ts).
    const workspace = '/tmp/hermes-bridge-final-context/default/workspace/explicit'
    completeWorkspaceRunCheckpointMock.mockReturnValue({
      change_id: 'change-1',
      session_id: 'session-1',
      run_id: 'run-1',
      source: 'run',
      workspace: 'hermes-explicit-workspace',
      workspace_kind: 'git',
      started_at: 1,
      finished_at: 2,
      files_changed: 1,
      additions: 2,
      deletions: 1,
      truncated: false,
      total_patch_bytes: 42,
      created_at: 2,
      files: [{
        id: 7,
        change_id: 'change-1',
        session_id: 'session-1',
        path: 'src/app.ts',
        old_path: null,
        change_type: 'modified',
        additions: 2,
        deletions: 1,
        size_before: 10,
        size_after: 12,
        patch_bytes: 42,
        truncated: false,
        binary: false,
        created_at: 2,
      }],
    })
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        fixed_context_tokens: 12327,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1', workspace },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(startWorkspaceRunCheckpointMock).toHaveBeenCalledWith({ sessionId: 'session-1', workspace })
    expect(completeWorkspaceRunCheckpointMock).toHaveBeenCalledWith({ sessionId: 'session-1', runId: 'run-1', workspace })
    const diffIndex = emit.mock.calls.findIndex(call => call[0] === 'workspace.diff.completed')
    const completedIndex = emit.mock.calls.findIndex(call => call[0] === 'run.completed')
    expect(diffIndex).toBeGreaterThanOrEqual(0)
    expect(diffIndex).toBeLessThan(completedIndex)
    expect(emit).toHaveBeenCalledWith('workspace.diff.completed', expect.objectContaining({
      event: 'workspace.diff.completed',
      change_id: 'change-1',
      files_changed: 1,
      files: [expect.not.objectContaining({ patch: expect.anything() })],
    }))
  })

  it('starts the bridge workspace diff checkpoint before bridge.chat returns', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    // Explicit, but inside the profile workspace — ensureHermesRunWorkspace now
    // contains every run path, so an out-of-tree value would be rewritten to the
    // profile default (see run-workspace-containment.test.ts).
    const workspace = '/tmp/hermes-bridge-final-context/default/workspace/explicit'
    const order: string[] = []
    startWorkspaceRunCheckpointMock.mockImplementation(() => {
      order.push('checkpoint-started')
    })
    const bridge = {
      chat: vi.fn(async () => {
        order.push('bridge-chat')
        return { run_id: 'run-1', status: 'started' }
      }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        fixed_context_tokens: 12327,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1', workspace },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(order.slice(0, 2)).toEqual(['checkpoint-started', 'bridge-chat'])
  })

  it('does not launch a bridge run after its session id is deleted and recreated during checkpoint startup', async () => {
    let resolveCheckpoint!: (value: { key: string }) => void
    startWorkspaceRunCheckpointMock.mockReturnValue(new Promise(resolve => {
      resolveCheckpoint = resolve
    }))
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn(),
      contextEstimate: vi.fn(),
      streamOutput: vi.fn(),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    const pending = handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1', workspace: '/tmp/hermes-bridge-final-context/default/workspace/explicit' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )
    await vi.waitFor(() => expect(startWorkspaceRunCheckpointMock).toHaveBeenCalled())
    const replacementState = makeState()
    replacementState.activeRunMarker = 'replacement-run'
    replacementState.isWorking = true
    sessionMap.set('session-1', replacementState)
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', model: '', provider: '' })
    getSessionRowIdMock.mockReturnValue(2)
    getSessionIncarnationMock.mockReturnValue(2)
    resolveCheckpoint({ key: 'deleted-session-checkpoint' })
    await pending

    expect(discardWorkspaceRunCheckpointMock).toHaveBeenCalledWith({
      sessionId: 'session-1',
      checkpoint: { key: 'deleted-session-checkpoint' },
    })
    expect(bridge.chat).not.toHaveBeenCalled()
    expect(sessionMap.get('session-1')).toBe(replacementState)
    expect(replacementState).toMatchObject({
      isWorking: true,
      activeRunMarker: 'replacement-run',
      messages: [],
    })
  })

  it('ignores a delayed old bridge chunk after same-id delete and recreate', async () => {
    let releaseChunk!: () => void
    const chunkReady = new Promise<void>(resolve => { releaseChunk = resolve })
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const oldState = makeState()
    const sessionMap = new Map([['session-1', oldState]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-old', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({ token_count: 10, message_count: 1, tool_count: 0, system_prompt_chars: 1 }),
      streamOutput: vi.fn(async function* () {
        await chunkReady
        yield {
          run_id: 'run-old',
          done: true,
          status: 'completed',
          delta: 'stale output',
          output: 'stale output',
          events: [],
        }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    const pending = handleBridgeRun(
      nsp,
      socket,
      { input: 'old request', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )
    await vi.waitFor(() => expect(bridge.streamOutput).toHaveBeenCalledWith('run-old'))

    const replacementState = makeState()
    replacementState.activeRunMarker = 'replacement-run'
    replacementState.runId = 'run-new'
    replacementState.isWorking = true
    sessionMap.set('session-1', replacementState)
    getSessionRowIdMock.mockReturnValue(2)
    getSessionIncarnationMock.mockReturnValue(2)
    emit.mockClear()

    releaseChunk()
    await pending

    expect(sessionMap.get('session-1')).toBe(replacementState)
    expect(replacementState).toMatchObject({
      isWorking: true,
      activeRunMarker: 'replacement-run',
      runId: 'run-new',
      messages: [],
    })
    expect(emit.mock.calls.map(call => call[0])).not.toContain('message.delta')
    expect(emit.mock.calls.map(call => call[0])).not.toContain('run.completed')
    expect(updateSessionStatsMock).not.toHaveBeenCalled()
  })

  it('does not emit workspace diff for default no-workspace bridge runs', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({ token_count: 12345, message_count: 2, tool_count: 4, system_prompt_chars: 13 }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(startWorkspaceRunCheckpointMock).not.toHaveBeenCalled()
    expect(completeWorkspaceRunCheckpointMock).not.toHaveBeenCalled()
    expect(emit.mock.calls.map(call => call[0])).not.toContain('workspace.diff.completed')
  })

  it('does not emit workspace diff when only the stored bridge session workspace exists', async () => {
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      model: '',
      provider: '',
      workspace: '/tmp/hermes-stored-workspace',
    })
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({ token_count: 12345, message_count: 2, tool_count: 4, system_prompt_chars: 13 }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(startWorkspaceRunCheckpointMock).not.toHaveBeenCalled()
    expect(completeWorkspaceRunCheckpointMock).not.toHaveBeenCalled()
    expect(emit.mock.calls.map(call => call[0])).not.toContain('workspace.diff.completed')
  })

  it('completes bridge workspace diff cleanup on stream failure', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const flushedRunIds: Array<string | undefined> = []
    flushBridgePendingToDbMock.mockImplementation((targetState: any) => {
      flushedRunIds.push(targetState.runId)
    })
    const sessionMap = new Map([['session-1', state]])
    // Explicit, but inside the profile workspace — ensureHermesRunWorkspace now
    // contains every run path, so an out-of-tree value would be rewritten to the
    // profile default (see run-workspace-containment.test.ts).
    const workspace = '/tmp/hermes-bridge-final-context/default/workspace/explicit'
    const change = {
      change_id: 'change-failed',
      session_id: 'session-1',
      run_id: 'run-1',
      source: 'run',
      workspace: 'hermes-explicit-workspace',
      workspace_kind: 'filesystem',
      started_at: 1,
      finished_at: 2,
      files_changed: 1,
      additions: 1,
      deletions: 0,
      truncated: false,
      total_patch_bytes: 12,
      created_at: 2,
      files: [],
    }
    let resolveDiff!: (value: typeof change) => void
    const delayedDiff = new Promise<typeof change>(resolve => { resolveDiff = resolve })
    completeWorkspaceRunCheckpointMock.mockReturnValue(delayedDiff)
    updateSessionStatsMock.mockImplementationOnce(() => { throw new Error('stats failed') })
    const dequeueNextQueuedRun = vi.fn()
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        fixed_context_tokens: 12327,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        throw new Error('stream failed')
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    const pending = handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1', workspace },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      dequeueNextQueuedRun,
    )

    await vi.waitFor(() => expect(completeWorkspaceRunCheckpointMock).toHaveBeenCalled())
    expect(state).toMatchObject({ isWorking: true, activeRunMarker: expect.any(String) })
    expect(emit.mock.calls.map(call => call[0])).not.toContain('run.failed')
    state.queue.push({ queue_id: 'during-diff', input: 'follow-up', profile: 'default' })
    resolveDiff(change)
    await pending

    expect(completeWorkspaceRunCheckpointMock).toHaveBeenCalledWith({ sessionId: 'session-1', runId: 'run-1', workspace })
    const diffIndex = emit.mock.calls.findIndex(call => call[0] === 'workspace.diff.completed')
    const failedIndex = emit.mock.calls.findIndex(call => call[0] === 'run.failed')
    expect(diffIndex).toBeGreaterThanOrEqual(0)
    expect(diffIndex).toBeLessThan(failedIndex)
    expect(flushedRunIds).toContain('run-1')
    expect(emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({
      error: 'stream failed; finalization failed: stats failed',
      queue_remaining: 1,
    }))
    expect(dequeueNextQueuedRun).toHaveBeenCalledTimes(1)
    expect(dequeueNextQueuedRun).toHaveBeenCalledWith(socket, 'session-1')
    expect(state).toMatchObject({ isWorking: false, activeRunMarker: undefined })
  })

  it('waits for the delayed workspace diff before the sole abort finalizer dequeues work', async () => {
    let releaseTerminal!: () => void
    const terminalGate = new Promise<void>(resolve => { releaseTerminal = resolve })
    let resolveDiff!: (value: null) => void
    const diffGate = new Promise<null>(resolve => { resolveDiff = resolve })
    completeWorkspaceRunCheckpointMock.mockReturnValue(diffGate)
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    state.queue.push({ queue_id: 'queued-user', input: 'next', profile: 'default', source: 'cli' })
    const sessionMap = new Map([['session-1', state]])
    const dequeueNextQueuedRun = vi.fn()
    const abortRunQueuedItem = vi.fn()
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({ token_count: 10, message_count: 1, tool_count: 0, system_prompt_chars: 1 }),
      interrupt: vi.fn().mockResolvedValue({ ok: true, synced: true }),
      goalPause: vi.fn().mockResolvedValue({ handled: true, status: 'paused' }),
      streamOutput: vi.fn(async function* () {
        await terminalGate
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'stopped' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    const { handleAbort } = await import('../../packages/server/src/services/hermes/run-chat/abort')
    const pending = handleBridgeRun(
      nsp,
      socket,
      {
        input: 'hello',
        session_id: 'session-1',
        workspace: '/tmp/hermes-bridge-final-context/default/workspace/explicit',
      },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      dequeueNextQueuedRun,
    )
    await vi.waitFor(() => expect(state.runId).toBe('run-1'))

    await handleAbort(nsp, socket, 'session-1', sessionMap, bridge, abortRunQueuedItem)
    expect(state.isAborting).toBe(true)
    expect(abortRunQueuedItem).not.toHaveBeenCalled()
    expect(dequeueNextQueuedRun).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalledWith('abort.completed', expect.anything())

    releaseTerminal()
    await vi.waitFor(() => expect(completeWorkspaceRunCheckpointMock).toHaveBeenCalled())
    expect(abortRunQueuedItem).not.toHaveBeenCalled()
    expect(dequeueNextQueuedRun).not.toHaveBeenCalled()

    resolveDiff(null)
    await pending

    expect(abortRunQueuedItem).not.toHaveBeenCalled()
    expect(dequeueNextQueuedRun).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls.findIndex(call => call[0] === 'abort.completed')).toBeGreaterThanOrEqual(0)
    expect(state.isAborting).toBe(false)
  })

  it('stores a super admin model-run token for the profile without adding it to bridge instructions', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    socket.data.user = { id: 1, username: 'admin', role: 'super_admin' }
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        fixed_context_tokens: 12327,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    const instructions = bridge.contextEstimate.mock.calls[0][2]
    expect(issueModelRunJwtMock).toHaveBeenCalledWith({ id: 1, username: 'admin', role: 'super_admin' })
    expect(readFileSync(join(process.env.HERMES_WEB_UI_HOME || '', 'profiles', 'default', '.model-run-token'), 'utf-8').trim()).toBe('model-run-token')
    expect(instructions).not.toContain('[Current Hermes profile:')
    expect(instructions).not.toContain('pass the current Hermes profile as the profile argument')
    expect(instructions).not.toContain('model-run-token')
    expect(instructions).not.toContain('Current Hermes Web UI model run token')
    expect(instructions).not.toContain('token argument')
    expect(instructions).not.toContain('list_mcp_resources')
    expect(instructions).not.toContain('mcp__hermes-studio__')
  })

  it('creates global-agent bridge sessions with source global_agent', async () => {
    getSessionMock.mockReturnValue(undefined)
    addMessageMock.mockReturnValue(42)
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 42,
        message_count: 1,
        tool_count: 0,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1', source: 'global_agent' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'session-1',
      source: 'global_agent',
    }))
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', {
      workspace: '/tmp/hermes-bridge-final-context/default/workspace',
    })
    expect(state.source).toBe('global_agent')
  })

  it('evaluates active goals after a successful bridge run and queues continuation prompts', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const dequeueNextQueuedRun = vi.fn(() => {
      expect(state.isWorking).toBe(false)
      expect(state.activeRunMarker).toBeUndefined()
      return true
    })
    addMessageMock.mockReturnValue(42)
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      goalEvaluate: vi.fn().mockResolvedValue({
        handled: true,
        should_continue: true,
        continuation_prompt: '[Continuing toward your standing goal]\nGoal: fix tests',
        message: '↻ Continuing toward goal (1/20): tests still fail',
        verdict: 'continue',
      }),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          done: true,
          status: 'completed',
          output: 'not finished',
          result: { final_response: 'not finished' },
        }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      {
        input: 'hello',
        session_id: 'session-1',
        model_groups: [{ provider: 'openai', models: ['gpt-test'] }],
      },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      dequeueNextQueuedRun,
    )

    expect(bridge.goalEvaluate).toHaveBeenCalledWith('session-1', 'not finished', 'default')
    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 'session-1',
      role: 'command',
      content: '↻ Continuing toward goal (1/20): tests still fail',
    }))
    expect(emit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      command: 'goal',
      action: 'continue',
      message: '↻ Continuing toward goal (1/20): tests still fail',
    }))
    expect(state.queue).toEqual([expect.objectContaining({
      input: '[Continuing toward your standing goal]\nGoal: fix tests',
      displayInput: null,
      storageMessage: '[Continuing toward your standing goal]\nGoal: fix tests',
      model: 'gpt-test',
      provider: 'openai',
      model_groups: [{ provider: 'openai', models: ['gpt-test'] }],
      goalContinuation: true,
    })])
    expect(dequeueNextQueuedRun).toHaveBeenCalledWith(socket, 'session-1')
  })

  it('releases bridge ownership before unified dequeue reserves a queued command', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    state.queue.push({
      queue_id: 'queued-goal-command',
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
    })
    const sessionMap = new Map([['session-1', state]])
    const { reserveQueuedSessionCommand } = await import('../../packages/server/src/services/hermes/run-chat/session-command-queue')
    const dequeueNextQueuedRun = vi.fn((_socket: any, sessionId: string) => {
      const exactState = sessionMap.get(sessionId)!
      expect(exactState.isWorking).toBe(false)
      expect(exactState.activeRunMarker).toBeUndefined()
      const next = exactState.queue.shift()!
      expect(reserveQueuedSessionCommand(sessionId, exactState, next)).toBeTruthy()
    })
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 100,
        message_count: 1,
        tool_count: 0,
        system_prompt_chars: 1,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: '' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      dequeueNextQueuedRun,
    )

    expect(dequeueNextQueuedRun).toHaveBeenCalledWith(socket, 'session-1')
    expect(state.commandReservationMarker).toBeTruthy()
  })

  it('finishes a clean abort without waiting for a hung goal evaluation', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const dequeueNextQueuedRun = vi.fn()
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 100,
        message_count: 1,
        tool_count: 0,
        system_prompt_chars: 1,
      }),
      goalEvaluate: vi.fn(() => new Promise(() => {})),
      interrupt: vi.fn().mockResolvedValue({ synced: true }),
      goalPause: vi.fn().mockResolvedValue({ handled: true }),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          done: true,
          status: 'completed',
          output: 'evaluate this',
          result: { final_response: 'evaluate this' },
        }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    const { handleAbort } = await import('../../packages/server/src/services/hermes/run-chat/abort')
    const running = handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      dequeueNextQueuedRun,
    )
    await vi.waitFor(() => expect(bridge.goalEvaluate).toHaveBeenCalledTimes(1))
    expect(state.goalEvaluationAbortController).toBeTruthy()

    await Promise.all([
      running,
      handleAbort(
        nsp,
        socket,
        'session-1',
        sessionMap,
        bridge,
        vi.fn(),
        dequeueNextQueuedRun,
      ),
    ])

    expect(bridge.interrupt).toHaveBeenCalledWith('session-1', 'Aborted by user', 'default')
    expect(emit).toHaveBeenCalledWith('abort.completed', expect.objectContaining({
      event: 'abort.completed',
      session_id: 'session-1',
      synced: true,
    }))
    expect(state).toMatchObject({
      isWorking: false,
      isAborting: false,
      activeRunMarker: undefined,
      goalEvaluationAbortController: undefined,
    })
  })

  it('skips hidden goal continuation runs without pausing when the judge is unavailable', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const dequeueNextQueuedRun = vi.fn()
    addMessageMock.mockReturnValue(43)
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      command: vi.fn(),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      goalEvaluate: vi.fn().mockResolvedValue({
        handled: true,
        should_continue: true,
        continuation_prompt: '[Continuing toward your standing goal]\nGoal: fix tests',
        message: '↻ Continuing toward goal (1/20): no auxiliary client configured',
        verdict: 'continue',
        reason: 'no auxiliary client configured',
      }),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          done: true,
          status: 'completed',
          output: 'done',
          result: { final_response: 'done' },
        }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      dequeueNextQueuedRun,
    )

    expect(bridge.command).not.toHaveBeenCalled()
    expect(state.queue).toEqual([])
    expect(dequeueNextQueuedRun).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      command: 'goal',
      action: 'judge_unavailable',
      message: 'Goal judge is not configured; automatic goal continuation was skipped. The goal remains active, but Hermes cannot mark it done automatically.',
    }))
  })

  it('uses cached fixed context instead of bridge estimate when available', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn(),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          done: false,
          status: 'running',
          events: [{
            event: 'bridge.context.ready',
            fixed_context_tokens: 20_000,
            system_prompt_tokens: 3_000,
            tool_tokens: 17_000,
          }],
        }
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(bridge.contextEstimate).not.toHaveBeenCalled()
    expect(updateMessageContextTokenUsageMock).toHaveBeenCalledWith(
      'session-1',
      state,
      expect.any(Function),
      18,
      { inputTokens: 11, outputTokens: 7 },
    )
    expect(state.contextTokens).toBe(20_018)
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      contextTokens: 20_018,
    }))
  })

  it('keeps bridge context ready updates on the snapshot-aware token baseline', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 28_000, outputTokens: 0 })
    buildDbHistoryMock.mockResolvedValue([
      { role: 'user', content: 'very large old context' },
      { role: 'assistant', content: 'large old response' },
      { role: 'user', content: 'hello' },
    ])
    buildSnapshotAwareHistoryMock.mockResolvedValue([
      { role: 'user', content: '[Previous context summary]\n\nsmall summary' },
      { role: 'user', content: 'hello' },
    ])
    estimateUsageTokensFromMessagesMock.mockImplementation((messages: any[]) => {
      if (messages?.[0]?.content?.includes('small summary')) {
        return { inputTokens: 9_000, outputTokens: 0 }
      }
      return { inputTokens: 28_000, outputTokens: 0 }
    })
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn(),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          done: false,
          status: 'running',
          events: [{
            event: 'bridge.context.ready',
            fixed_context_tokens: 10_000,
            system_prompt_tokens: 2_000,
            tool_tokens: 8_000,
          }],
        }
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(updateMessageContextTokenUsageMock).toHaveBeenCalledWith(
      'session-1',
      state,
      expect.any(Function),
      9_000,
      { inputTokens: 28_000, outputTokens: 0 },
    )
    expect(updateMessageContextTokenUsageMock).not.toHaveBeenCalledWith(
      'session-1',
      state,
      expect.any(Function),
      28_000,
      { inputTokens: 28_000, outputTokens: 0 },
    )
    expect(state.contextTokens).toBe(19_000)
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      contextTokens: 19_000,
    }))
  })

  it('persists pending tool marker text before a bridge run completes', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const persistedContent: string[] = []
    flushBridgePendingToDbMock.mockImplementation((targetState: any) => {
      persistedContent.push(targetState.bridgePendingAssistantContent || '')
      targetState.bridgePendingAssistantContent = ''
    })
    ensureOpenBridgeAssistantMessageMock.mockImplementation((targetState: any, sessionId: string, runMarker: string) => {
      let message = [...targetState.messages].reverse().find((m: any) => m.runMarker === runMarker && m.role === 'assistant' && m.finish_reason == null)
      if (!message) {
        message = {
          id: targetState.messages.length + 1,
          session_id: sessionId,
          runMarker,
          role: 'assistant',
          content: '',
          timestamp: Math.floor(Date.now() / 1000),
        }
        targetState.messages.push(message)
      }
      return message
    })
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: false, status: 'running', delta: 'Text [Call', events: [] }
        yield { run_id: 'run-1', done: true, status: 'completed', output: '', events: [] }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(persistedContent).toContain('Text [Call')
    expect(state.messages.find((message: any) => message.role === 'assistant')).toEqual(expect.objectContaining({
      run_id: 'run-1',
    }))
    expect(emit).toHaveBeenCalledWith('message.delta', expect.objectContaining({
      delta: 'Text ',
      output: 'Text ',
    }))
    expect(emit).toHaveBeenCalledWith('message.delta', expect.objectContaining({
      delta: '[Call',
      output: 'Text [Call',
    }))
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      output: 'Text [Call',
    }))
  })

  it('persists the visible plan command instead of the expanded skill prompt', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'planned' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      {
        input: '[IMPORTANT: expanded plan skill prompt]',
        display_input: '/plan build the feature',
        display_role: 'command',
        storage_message: '/plan build the feature',
        session_id: 'session-1',
      },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(state.messages.find((message: any) => message.role === 'command')).toEqual(expect.objectContaining({
      role: 'command',
      content: '/plan build the feature',
    }))
    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      role: 'command',
      content: '/plan build the feature',
    }))
    expect(addMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({
      role: 'user',
      content: '[IMPORTANT: expanded plan skill prompt]',
    }))
    expect(bridge.chat).toHaveBeenCalledWith(
      'session-1',
      '[IMPORTANT: expanded plan skill prompt]',
      expect.any(Array),
      expect.any(String),
      'default',
      expect.objectContaining({ storage_message: '/plan build the feature' }),
    )
  })

  it('persists expanded skill prompts as user history with visible command display fields', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      {
        input: '[IMPORTANT: expanded skill prompt]',
        display_input: '/skill github-pr-review check PR 123',
        display_role: 'command',
        storage_message: '[IMPORTANT: expanded skill prompt]',
        session_id: 'session-1',
      },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(state.messages.find((message: any) => message.content === '[IMPORTANT: expanded skill prompt]')).toEqual(expect.objectContaining({
      role: 'user',
      display_role: 'command',
      display_content: '/skill github-pr-review check PR 123',
    }))
    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      role: 'user',
      content: '[IMPORTANT: expanded skill prompt]',
      display_role: 'command',
      display_content: '/skill github-pr-review check PR 123',
    }))
    expect(bridge.chat).toHaveBeenCalledWith(
      'session-1',
      '[IMPORTANT: expanded skill prompt]',
      expect.any(Array),
      expect.any(String),
      'default',
      expect.objectContaining({ storage_message: '[IMPORTANT: expanded skill prompt]' }),
    )
  })

  it('refreshes full context tokens when a bridge run fails', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockRejectedValue(new Error('bridge timeout')),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 54321,
        fixed_context_tokens: 54303,
        message_count: 1,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(state.contextTokens).toBe(54321)
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 54321,
    }))
    expect(emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({
      error: 'bridge timeout',
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 54321,
    }))
  })

  it('emits bridge lifecycle status events so retries are visible', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          done: false,
          status: 'running',
          events: [
            { event: 'status', kind: 'lifecycle', text: 'Retrying in 3.0s (attempt 1/3)...' },
          ],
        }
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/services/hermes/run-chat/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(replaceStateMock).toHaveBeenCalledWith(sessionMap, 'session-1', 'agent.event', expect.objectContaining({
      event: 'agent.event',
      kind: 'lifecycle',
      text: 'Retrying in 3.0s (attempt 1/3)...',
    }))
    expect(emit).toHaveBeenCalledWith('agent.event', expect.objectContaining({
      event: 'agent.event',
      kind: 'lifecycle',
      text: 'Retrying in 3.0s (attempt 1/3)...',
    }))
  })
})
