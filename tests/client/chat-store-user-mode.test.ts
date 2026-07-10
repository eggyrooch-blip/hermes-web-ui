// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'

const isUserModeMock = vi.hoisted(() => vi.fn(() => false))
const switchModelMock = vi.hoisted(() => vi.fn())
const setSessionModelMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)))
const startRunViaSocketMock = vi.hoisted(() => vi.fn(() => ({ abort: vi.fn() })))
const respondClarifyMock = vi.hoisted(() => vi.fn())
const fetchSessionMock = vi.hoisted(() => vi.fn())
const fetchSessionMessagesPageMock = vi.hoisted(() => vi.fn())
const fetchWorkspaceRunChangesMock = vi.hoisted(() => vi.fn(() => Promise.resolve([])))
const fetchSessionsMock = vi.hoisted(() => vi.fn(() => Promise.resolve([])))
const setSessionArchivedMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)))
const resumeSessionMock = vi.hoisted(() => vi.fn((_sessionId: string, onResumed: (data: any) => void) => {
  onResumed({ messages: [], isWorking: false, events: [] })
  return { disconnect: vi.fn() }
}))
// Real setActiveExpertId(null) does localStorage.removeItem — spy on it so we can
// prove the store persists the sticky-clear, not just the in-memory ref.
const setActiveExpertIdMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  getApiKey: vi.fn(() => ''),
  isUserMode: isUserModeMock,
  getActiveProfileName: () => 'default',
  getActiveExpertId: () => null,
  setActiveExpertId: setActiveExpertIdMock,
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({
    selectedModel: 'default-model',
    selectedProvider: 'default-provider',
    waitForModelsForRun: vi.fn(() => Promise.resolve()),
    switchModel: switchModelMock,
    // Upstream rebaseline: sendMessage now reads these to build the run's
    // model_groups payload. Empty groups keep model/provider resolution
    // falling back to selectedModel/selectedProvider.
    modelGroups: [],
    profileModelGroups: [],
  }),
}))

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: startRunViaSocketMock,
  resumeSession: resumeSessionMock,
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => null),
  respondToolApproval: vi.fn(),
  respondClarify: respondClarifyMock,
  // Upstream rebaseline added module-level handler registrations the store
  // wires up at setup time; each returns an unsubscribe fn.
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/hermes/sessions', () => ({
  deleteSession: vi.fn(),
  fetchSession: fetchSessionMock,
  fetchWorkspaceRunChanges: fetchWorkspaceRunChangesMock,
  // Upstream rebaseline: refreshActiveSession now pulls via the paginated
  // messages endpoint instead of fetchSession.
  fetchSessionMessagesPage: fetchSessionMessagesPageMock,
  fetchSessions: fetchSessionsMock,
  setSessionArchived: setSessionArchivedMock,
  setSessionModel: setSessionModelMock,
}))

import { useChatStore } from '@/stores/hermes/chat'

function setActiveTestSession(store: ReturnType<typeof useChatStore>) {
  store.activeSession = {
    id: 'session-1',
    title: '',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('chat store user-mode model selection', () => {
  let pinia: Pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    vi.clearAllMocks()
    isUserModeMock.mockReturnValue(false)
    fetchSessionsMock.mockResolvedValue([])
    fetchSessionMock.mockResolvedValue(null)
    fetchWorkspaceRunChangesMock.mockResolvedValue([])
    setSessionArchivedMock.mockResolvedValue(true)
    resumeSessionMock.mockImplementation((_sessionId: string, onResumed: (data: any) => void) => {
      onResumed({ messages: [], isWorking: false, events: [] })
      return { disconnect: vi.fn() }
    })
  })

  afterEach(() => {
    disposePinia(pinia)
  })

  it('removes background sync listeners and timers when the store is disposed', () => {
    vi.useFakeTimers()
    try {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      })
      const store = useChatStore()
      const session = store.newChat({ profile: 'tester' })
      store.activeSessionId = session.id
      store.activeSession = session
      resumeSessionMock.mockClear()
      fetchSessionsMock.mockClear()

      store.$dispose()
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(12_000)

      expect(resumeSessionMock).not.toHaveBeenCalled()
      expect(fetchSessionsMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  // NOTE: The three "user-mode model selection" cases that used to live here
  // (does-not-stamp-new-chats, keeps-updating-default-model, uses-current-
  // default-model-in-payloads) were removed during the upstream rebaseline.
  // They exercised the fork-only "user mode / chat plane" model-override
  // suppression — a feature the upstream EKKOLearnAI client does not have.
  // Upstream's newChat() always stamps the session with appStore.selectedModel,
  // switchSessionModel() no longer touches the app-level default, and
  // sendMessage() sends the session's own model rather than forcing the
  // default. With the feature gone these assertions test nonexistent behavior,
  // so the cases are deleted rather than rewritten. The isUserModeMock setup
  // is retained only because other suites import the same mock shape.

  it('respects an explicit cli source even when ambient runtime mode is global agent', () => {
    const store = useChatStore()
    try {
      store.setRuntimeMode('global_agent')

      const session = store.newChat({ source: 'cli', profile: 'user_a' })

      expect(session.source).toBe('cli')
      expect(session.profile).toBe('user_a')
    } finally {
      store.setRuntimeMode('default')
    }
  })

  it('stores tool completed output on the visible tool message', async () => {
    const store = useChatStore()
    store.newChat()

    await store.sendMessage('run a terminal command')

    const onEvent = startRunViaSocketMock.mock.calls[0][1]
    onEvent({
      event: 'tool.started',
      session_id: store.activeSession!.id,
      tool: 'terminal',
      preview: 'pip install matplotlib numpy Pillow -q',
    })
    onEvent({
      event: 'tool.completed',
      session_id: store.activeSession!.id,
      output: 'TypeError: FigureCanvasAgg.print_jpg() got an unexpected keyword argument',
      duration: 3.9,
    })

    const toolMessage = store.activeSession!.messages.find(m => m.role === 'tool')
    expect(toolMessage).toMatchObject({
      toolName: 'terminal',
      toolStatus: 'done',
      toolResult: 'TypeError: FigureCanvasAgg.print_jpg() got an unexpected keyword argument',
      toolDuration: 3.9,
    })
  })

  it('does not update an older tool card when broker tool ids repeat across runs', async () => {
    const store = useChatStore()
    store.newChat()
    const sid = store.activeSession!.id
    store.activeSession!.messages = [
      {
        id: 'old-user',
        role: 'user',
        content: 'old command',
        timestamp: Date.now() - 10_000,
      },
      {
        id: 'old-tool',
        role: 'tool',
        content: '',
        timestamp: Date.now() - 9_000,
        toolCallId: 'broker_tool_reused_terminal',
        toolName: 'terminal',
        toolPreview: 'printf OLD',
        toolStatus: 'done',
      },
      {
        id: 'old-assistant',
        role: 'assistant',
        content: 'old done',
        timestamp: Date.now() - 8_000,
      },
    ]

    await store.sendMessage('run a new terminal command')

    const onEvent = startRunViaSocketMock.mock.calls[0][1]
    onEvent({
      event: 'tool.started',
      session_id: sid,
      tool_call_id: 'broker_tool_reused_terminal',
      tool: 'terminal',
      preview: 'printf NEW',
    })
    onEvent({
      event: 'tool.completed',
      session_id: sid,
      tool_call_id: 'broker_tool_reused_terminal',
      output: 'NEW',
      duration: 1.2,
    })

    const oldTool = store.activeSession!.messages.find(m => m.id === 'old-tool')
    const newTool = store.activeSession!.messages.find(m => m.role === 'tool' && m.id !== 'old-tool')

    expect(oldTool).toMatchObject({
      toolPreview: 'printf OLD',
    })
    expect(oldTool?.toolResult).toBeUndefined()
    expect(newTool).toMatchObject({
      toolPreview: 'printf NEW',
      toolResult: 'NEW',
      toolStatus: 'done',
    })
    expect(store.activeSession!.messages.map(m => m.role)).toEqual([
      'user',
      'tool',
      'assistant',
      'user',
      'tool',
    ])
  })

  it('surfaces empty final output after tool activity as an error', async () => {
    const store = useChatStore()
    store.newChat()

    await store.sendMessage('use a tool and then fail')

    const onEvent = startRunViaSocketMock.mock.calls[0][1]
    onEvent({
      event: 'tool.started',
      session_id: store.activeSession!.id,
      tool: 'execute_code',
      preview: 'install dependencies',
    })
    onEvent({
      event: 'tool.completed',
      session_id: store.activeSession!.id,
      output: 'Deps installed',
      duration: 3.2,
    })
    onEvent({
      event: 'run.completed',
      session_id: store.activeSession!.id,
      output: '',
    })

    const systemMessage = store.activeSession!.messages.find(m => m.role === 'system')
    expect(systemMessage?.content).toContain('no final output after tool activity')
  })

  it('restores historical tool calls from empty assistant envelopes after refresh', async () => {
    const store = useChatStore()
    store.newChat()
    const sessionId = store.activeSession!.id
    // Upstream rebaseline: refreshActiveSession reads the paginated messages
    // endpoint (fetchSessionMessagesPage), which wraps the messages in a
    // { session, messages, total, hasMore } envelope.
    const restoredMessages = [
      {
        id: 1,
        role: 'user',
        content: 'create a doc',
        timestamp: 1,
      },
      {
        id: 2,
        role: 'assistant',
        content: '',
        timestamp: 2,
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: {
            name: 'lark_cli',
            arguments: '{"cmd":"docx create"}',
          },
        }],
      },
      {
        id: 3,
        role: 'tool',
        content: 'created doc',
        timestamp: 3,
        tool_call_id: 'call-1',
        tool_name: 'lark_cli',
      },
      {
        id: 4,
        role: 'assistant',
        content: 'Done.',
        timestamp: 4,
      },
    ]
    fetchSessionMessagesPageMock.mockResolvedValue({
      session: { id: sessionId, title: 'tool session' },
      messages: restoredMessages,
      total: restoredMessages.length,
      offset: 0,
      limit: 150,
      hasMore: false,
    })

    await store.refreshActiveSession()

    const toolMessage = store.activeSession!.messages.find(m => m.role === 'tool')
    expect(toolMessage).toMatchObject({
      toolName: 'lark_cli',
      toolCallId: 'call-1',
      toolArgs: '{"cmd":"docx create"}',
      toolResult: 'created doc',
      toolStatus: 'done',
    })
    expect(store.activeSession!.messages.some(m => m.role === 'assistant' && m.content === 'Done.')).toBe(true)
  })

  it('does not treat reasoning-only streaming as a final assistant reply', async () => {
    const store = useChatStore()
    store.newChat()

    await store.sendMessage('think but do not answer')

    const onEvent = startRunViaSocketMock.mock.calls[0][1]
    onEvent({
      event: 'reasoning.delta',
      session_id: store.activeSession!.id,
      delta: 'checking context',
    })
    onEvent({
      event: 'run.completed',
      session_id: store.activeSession!.id,
      output: '',
    })

    const systemMessage = store.activeSession!.messages.find(m => m.role === 'system')
    expect(systemMessage?.content).toContain('Agent returned no output')
  })

  it('clears stale compression status when a new run starts', async () => {
    const store = useChatStore()
    store.newChat()

    await store.sendMessage('compress then answer')

    const onEvent = startRunViaSocketMock.mock.calls[0][1]
    onEvent({
      event: 'compression.completed',
      session_id: store.activeSession!.id,
      totalMessages: 12,
      beforeTokens: 24000,
      afterTokens: 6000,
      compressed: true,
    })
    expect(store.compressionState?.compressed).toBe(true)

    onEvent({
      event: 'run.started',
      session_id: store.activeSession!.id,
      run_id: 'next-run',
    })
    expect(store.compressionState).toBeNull()
  })

  it('stores workspace diff files from live events without adding a chat message', async () => {
    const store = useChatStore()
    store.newChat()

    await store.sendMessage('change files')

    const onEvent = startRunViaSocketMock.mock.calls[0][1]
    const event = {
      event: 'workspace.diff.completed',
      session_id: store.activeSession!.id,
      change_id: 'change-1',
      run_id: 'run-1',
      source: 'run',
      workspace: 'project',
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
        session_id: store.activeSession!.id,
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
        patch: 'diff --git a/src/app.ts b/src/app.ts',
        patch_body: 'secret patch',
        diff: 'secret diff',
        content: 'secret content',
      }],
    }

    onEvent(event)
    onEvent(event)

    expect(store.activeSession!.messages.some(m => m.commandAction === 'workspace.diff')).toBe(false)
    expect(store.workspaceDiffFilesForRun(store.activeSession!.id, 'run-1')).toEqual([
      expect.objectContaining({
        id: 7,
        path: 'src/app.ts',
        change_id: 'change-1',
        session_id: store.activeSession!.id,
        additions: 2,
        deletions: 1,
      }),
    ])
  })

  it('restores workspace diff files after refreshing a session without adding chat messages', async () => {
    const store = useChatStore()
    store.newChat()
    const sessionId = store.activeSession!.id
    const restoredMessages = [{ id: 1, role: 'user', content: 'hello', timestamp: 1 }]
    fetchSessionMessagesPageMock.mockResolvedValue({
      session: { id: sessionId, title: 'workspace session' },
      messages: restoredMessages,
      total: restoredMessages.length,
      offset: 0,
      limit: 150,
      hasMore: false,
    })
    fetchWorkspaceRunChangesMock.mockResolvedValue([{
      change_id: 'change-restore',
      session_id: sessionId,
      run_id: 'run-1',
      source: 'run',
      workspace: 'project',
      workspace_kind: 'filesystem',
      started_at: 1,
      finished_at: 2,
      files_changed: 2,
      additions: 3,
      deletions: 1,
      truncated: false,
      total_patch_bytes: 64,
      created_at: 2,
      files: [
        { id: 8, change_id: 'change-restore', session_id: sessionId, path: 'src/a.ts', old_path: null, change_type: 'modified', additions: 2, deletions: 1, size_before: 10, size_after: 11, patch_bytes: 32, truncated: false, binary: false, created_at: 2 },
        { id: 9, change_id: 'change-restore', session_id: sessionId, path: 'src/b.ts', old_path: null, change_type: 'added', additions: 1, deletions: 0, size_before: null, size_after: 5, patch_bytes: 32, truncated: false, binary: false, created_at: 2 },
      ],
    }])

    await store.refreshActiveSession()
    await store.refreshActiveSession()

    expect(fetchWorkspaceRunChangesMock).toHaveBeenCalledWith(sessionId, 'default')
    expect(store.activeSession!.messages.some(m => m.commandAction === 'workspace.diff')).toBe(false)
    expect(store.activeSession!.messages.map(m => m.id)).toEqual(['1'])
    expect(store.workspaceDiffFilesForRun(sessionId, 'run-1')).toEqual([
      expect.objectContaining({ id: 8, path: 'src/a.ts', change_id: 'change-restore' }),
      expect.objectContaining({ id: 9, path: 'src/b.ts', change_id: 'change-restore' }),
    ])
  })

  it('keeps a tool run as one thinking message, tool card, then one streamed result message', async () => {
    const store = useChatStore()
    store.newChat()

    await store.sendMessage('run terminal and answer')

    const onEvent = startRunViaSocketMock.mock.calls[0][1]
    onEvent({
      event: 'reasoning.delta',
      session_id: store.activeSession!.id,
      delta: 'I should call the terminal.',
    })
    onEvent({
      event: 'tool.started',
      session_id: store.activeSession!.id,
      tool_call_id: 'call-terminal-1',
      tool: 'terminal',
      preview: 'printf STREAM_FIXED_OK',
    })
    onEvent({
      event: 'tool.completed',
      session_id: store.activeSession!.id,
      tool_call_id: 'call-terminal-1',
      output: 'STREAM_FIXED_OK',
      duration: 0.5,
    })
    onEvent({
      event: 'message.delta',
      session_id: store.activeSession!.id,
      delta: 'STREAM_',
    })
    onEvent({
      event: 'message.delta',
      session_id: store.activeSession!.id,
      delta: 'FIXED_OK',
    })
    onEvent({
      event: 'run.completed',
      session_id: store.activeSession!.id,
      output: 'STREAM_FIXED_OK',
    })

    const messages = store.activeSession!.messages
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: '',
      reasoning: 'I should call the terminal.',
      isStreaming: false,
    })
    expect(messages[2]).toMatchObject({
      role: 'tool',
      toolName: 'terminal',
      toolStatus: 'done',
      toolResult: 'STREAM_FIXED_OK',
    })
    expect(messages[3]).toMatchObject({
      role: 'assistant',
      content: 'STREAM_FIXED_OK',
      isStreaming: false,
    })
    expect(messages[3].reasoning).toBeUndefined()
  })

  it('does not remove queued messages when a plain queue-length update arrives', async () => {
    const store = useChatStore()
    store.newChat()

    await store.sendMessage('first running request')
    await store.sendMessage('queued request one')
    await store.sendMessage('queued request two')

    const sid = store.activeSession!.id
    const firstRunEvent = startRunViaSocketMock.mock.calls[0][1]

    expect(store.queuedUserMessages.get(sid)?.map(m => m.content)).toEqual([
      'queued request one',
      'queued request two',
    ])

    firstRunEvent({
      event: 'run.queued',
      session_id: sid,
      queue_length: 1,
    })

    expect(store.queuedUserMessages.get(sid)?.map(m => m.content)).toEqual([
      'queued request one',
      'queued request two',
    ])
    expect(store.activeSession!.messages.map(m => m.content)).toEqual([
      'first running request',
    ])
    expect(store.queueLengths.get(sid)).toBe(1)
  })

  it('removes a queued message from the queue panel when the server dequeues it', async () => {
    const store = useChatStore()
    store.newChat()

    await store.sendMessage('first running request')
    await store.sendMessage('queued request one')
    await store.sendMessage('queued request two')

    const sid = store.activeSession!.id
    const firstRunEvent = startRunViaSocketMock.mock.calls[0][1]
    const dequeuedId = store.queuedUserMessages.get(sid)![0].id

    firstRunEvent({
      event: 'run.queued',
      session_id: sid,
      queue_length: 1,
      dequeued_queue_id: dequeuedId,
    })

    expect(store.queuedUserMessages.get(sid)?.map(m => m.content)).toEqual([
      'queued request two',
    ])
    expect(store.activeSession!.messages.map(m => m.content)).toEqual([
      'first running request',
      'queued request one',
    ])
    expect(store.queueLengths.get(sid)).toBe(1)

    firstRunEvent({
      event: 'run.started',
      session_id: sid,
      run_id: 'queued-run-1',
      queue_length: 1,
    })

    expect(store.queuedUserMessages.get(sid)?.map(m => m.content)).toEqual([
      'queued request two',
    ])
    expect(store.activeSession!.messages.map(m => m.content)).toEqual([
      'first running request',
      'queued request one',
    ])
  })

  it('keeps streamed run failure errors visible after the socket error callback', async () => {
    const store = useChatStore()
    store.newChat()

    await store.sendMessage('generate a video')
    fetchSessionMock.mockResolvedValue({
      id: store.activeSession!.id,
      title: 'generate a video',
      messages: [{ role: 'user', content: 'generate a video' }],
    })

    const onEvent = startRunViaSocketMock.mock.calls[0][1]
    const onError = startRunViaSocketMock.mock.calls[0][3]
    onEvent({
      event: 'run.failed',
      session_id: store.activeSession!.id,
      error: 'HTTP 429: The service may be temporarily overloaded',
    })
    onError(new Error('HTTP 429: The service may be temporarily overloaded'))
    await new Promise(resolve => setTimeout(resolve, 0))

    // Upstream rebaseline renders agent/stream errors as an assistant message
    // tagged systemType:'error' (instead of role:'system'). The guarantee under
    // test — the failure stays visible after the socket error callback — holds.
    const errorMessage = store.activeSession!.messages.find(m => m.systemType === 'error')
    expect(errorMessage?.content).toContain('HTTP 429')
  })

  it('does not let a stale resume response overwrite the currently active session', async () => {
    const callbacks = new Map<string, (data: any) => void>()
    resumeSessionMock.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      callbacks.set(sessionId, onResumed)
      return { disconnect: vi.fn() }
    })

    const store = useChatStore()
    store.newChat()
    const firstId = store.activeSession!.id
    store.newChat()
    const secondId = store.activeSession!.id

    callbacks.get(firstId)!({
      session_id: firstId,
      isWorking: false,
      events: [],
      messages: [{
        id: 1,
        session_id: firstId,
        role: 'assistant',
        content: 'stale first-session reply',
        timestamp: Date.now() / 1000,
      }],
    })

    // Upstream rebaseline tightened the resume guard: a resume payload whose
    // session is no longer the active one is dropped entirely (it does not even
    // populate the inactive session's buffer). The anti-clobber guarantee under
    // test is therefore stronger — neither the active nor the stale session is
    // mutated by a stale resume response.
    expect(store.activeSessionId).toBe(secondId)
    expect(store.sessions.find(s => s.id === secondId)?.messages).toEqual([])
    expect(store.sessions.find(s => s.id === firstId)?.messages).toEqual([])
  })

  it('loads the route-selected session from the requested profile', async () => {
    fetchSessionsMock.mockResolvedValue([
      {
        id: 'session-1',
        source: 'api_server',
        model: 'm',
        title: 'first',
        started_at: 100,
        ended_at: null,
        last_active: 100,
        message_count: 0,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        profile: 'tester',
      },
      {
        id: 'session-2',
        source: 'api_server',
        model: 'm',
        title: 'second',
        started_at: 101,
        ended_at: null,
        last_active: 101,
        message_count: 0,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        profile: 'tester',
      },
    ])
    const store = useChatStore()

    await store.loadSessions('tester', 'session-2')

    expect(fetchSessionsMock).toHaveBeenCalledWith(undefined, undefined, 'tester')
    expect(store.activeSessionId).toBe('session-2')
    expect(store.activeSession?.profile).toBe('tester')
    // Upstream rebaseline added a transport arg ('chat-run') to resumeSession.
    expect(resumeSessionMock).toHaveBeenCalledWith('session-2', expect.any(Function), 'tester', 'chat-run')
  })

  it('falls back to paginated messages when socket resume and summary totals are stale zero', async () => {
    fetchSessionsMock.mockResolvedValue([
      {
        id: 'session-1',
        source: 'api_server',
        model: 'm',
        title: 'first',
        started_at: 100,
        ended_at: null,
        last_active: 100,
        message_count: 0,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        profile: 'tester',
      },
    ])
    resumeSessionMock.mockImplementation((_sessionId: string, onResumed: (data: any) => void) => {
      onResumed({
        session_id: 'session-1',
        isWorking: false,
        events: [],
        messages: [],
        messageTotal: 0,
        messageLoadedCount: 0,
        hasMoreBefore: false,
      })
      return { disconnect: vi.fn() }
    })
    fetchSessionMessagesPageMock.mockResolvedValue({
      session: { id: 'session-1', title: 'first' },
      messages: [
        {
          id: 1,
          session_id: 'session-1',
          role: 'user',
          content: 'hello',
          timestamp: 100,
        },
        {
          id: 2,
          session_id: 'session-1',
          role: 'assistant',
          content: 'world',
          timestamp: 101,
          run_id: 'run-1',
        },
      ],
      total: 2,
      offset: 0,
      limit: 150,
      hasMore: false,
    })

    const store = useChatStore()

    await store.loadSessions('tester', 'session-1')

    expect(fetchSessionMessagesPageMock).toHaveBeenCalledWith('session-1', 0, 150, 'tester')
    expect(store.activeSession?.messages.map(message => message.content)).toEqual(['hello', 'world'])
    expect(store.activeSession?.messages[1]?.runId).toBe('run-1')
  })

  it('falls back to paginated messages when socket resume times out', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      fetchSessionsMock.mockResolvedValue([
        {
          id: 'session-1',
          source: 'api_server',
          model: 'm',
          title: 'first',
          started_at: 100,
          ended_at: null,
          last_active: 100,
          message_count: 1,
          tool_call_count: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          billing_provider: null,
          estimated_cost_usd: 0,
          actual_cost_usd: null,
          cost_status: '',
          profile: 'tester',
        },
      ])
      resumeSessionMock.mockImplementation(() => ({ disconnect: vi.fn() }))
      fetchSessionMessagesPageMock.mockResolvedValue({
        session: { id: 'session-1', title: 'first' },
        messages: [
          {
            id: 1,
            session_id: 'session-1',
            role: 'assistant',
            content: 'loaded after timeout',
            timestamp: 100,
          },
        ],
        total: 1,
        offset: 0,
        limit: 150,
        hasMore: false,
      })

      const store = useChatStore()
      const loading = store.loadSessions('tester', 'session-1')
      await vi.advanceTimersByTimeAsync(15_000)
      await loading

      expect(fetchSessionMessagesPageMock).toHaveBeenCalledWith('session-1', 0, 150, 'tester')
      expect(store.activeSession?.messages.map(message => message.content)).toEqual(['loaded after timeout'])
      expect(errorSpy).toHaveBeenCalledWith('Failed to load session messages via resume:', expect.any(Error))
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('does not let slow fallback hydration reactivate a stale session', async () => {
    fetchSessionsMock.mockResolvedValue([
      {
        id: 'session-1',
        source: 'api_server',
        model: 'm',
        title: 'first',
        started_at: 100,
        ended_at: null,
        last_active: 100,
        message_count: 2,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        profile: 'tester',
      },
      {
        id: 'session-2',
        source: 'api_server',
        model: 'm',
        title: 'second',
        started_at: 101,
        ended_at: null,
        last_active: 101,
        message_count: 0,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        profile: 'tester',
      },
    ])
    resumeSessionMock.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({
        session_id: sessionId,
        isWorking: false,
        events: [],
        messages: [],
        messageTotal: sessionId === 'session-1' ? 2 : 0,
        messageLoadedCount: 0,
        hasMoreBefore: false,
      })
      return { disconnect: vi.fn() }
    })
    let resolveSessionOnePage!: (value: any) => void
    fetchSessionMessagesPageMock.mockImplementation((sessionId: string) => {
      if (sessionId !== 'session-1') return Promise.resolve(null)
      return new Promise(resolve => {
        resolveSessionOnePage = resolve
      })
    })

    const store = useChatStore()
    const initialLoad = store.loadSessions('tester', 'session-1')
    for (let i = 0; i < 10 && !resolveSessionOnePage; i += 1) {
      await Promise.resolve()
    }
    expect(store.activeSessionId).toBe('session-1')

    await store.switchSession('session-2')

    resolveSessionOnePage({
      session: { id: 'session-1', title: 'first' },
      messages: [
        {
          id: 1,
          session_id: 'session-1',
          role: 'user',
          content: 'late hello',
          timestamp: 100,
        },
      ],
      total: 1,
      offset: 0,
      limit: 150,
      hasMore: false,
    })
    await initialLoad

    expect(store.activeSessionId).toBe('session-2')
    expect(store.activeSession?.id).toBe('session-2')
  })

  it('does not let slow fallback hydration erase a message sent after the request started', async () => {
    fetchSessionsMock.mockResolvedValue([
      {
        id: 'session-1',
        source: 'api_server',
        model: 'm',
        title: 'first',
        started_at: 100,
        ended_at: null,
        last_active: 100,
        message_count: 2,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        profile: 'tester',
      },
    ])
    resumeSessionMock.mockImplementation((_sessionId: string, onResumed: (data: any) => void) => {
      onResumed({
        session_id: 'session-1',
        isWorking: false,
        events: [],
        messages: [],
        messageTotal: 2,
        messageLoadedCount: 0,
        hasMoreBefore: false,
      })
      return { disconnect: vi.fn() }
    })
    let resolvePage!: (value: any) => void
    fetchSessionMessagesPageMock.mockImplementation(() => new Promise(resolve => {
      resolvePage = resolve
    }))

    const store = useChatStore()
    const initialLoad = store.loadSessions('tester', 'session-1')
    for (let i = 0; i < 10 && !resolvePage; i += 1) await Promise.resolve()

    await store.sendMessage('new prompt while history loads')
    resolvePage({
      session: { id: 'session-1', title: 'first' },
      messages: [
        {
          id: 1,
          session_id: 'session-1',
          role: 'user',
          content: 'older prompt',
          timestamp: 100,
        },
        {
          id: 2,
          session_id: 'session-1',
          role: 'assistant',
          content: 'older answer',
          timestamp: 101,
        },
      ],
      total: 2,
      offset: 0,
      limit: 150,
      hasMore: false,
    })
    await initialLoad

    expect(store.activeSession?.messages.map(message => message.content)).toEqual([
      'older prompt',
      'older answer',
      'new prompt while history loads',
    ])
  })

  it('does not let a delayed non-empty resume erase a message sent after switching started', async () => {
    fetchSessionsMock.mockResolvedValue([
      {
        id: 'session-1',
        source: 'api_server',
        model: 'm',
        title: 'first',
        started_at: 100,
        ended_at: null,
        last_active: 100,
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        profile: 'tester',
      },
    ])
    let onResumed!: (data: any) => void
    resumeSessionMock.mockImplementation((_sessionId: string, callback: (data: any) => void) => {
      onResumed = callback
      return { disconnect: vi.fn() }
    })

    const store = useChatStore()
    const loading = store.loadSessions('tester', 'session-1')
    for (let i = 0; i < 10 && !onResumed; i += 1) await Promise.resolve()

    await store.sendMessage('new prompt while resume loads')
    onResumed({
      session_id: 'session-1',
      isWorking: true,
      events: [],
      messages: [{
        id: 1,
        session_id: 'session-1',
        role: 'assistant',
        content: 'older answer',
        timestamp: 100,
      }],
      messageTotal: 1,
      messageLoadedCount: 1,
      hasMoreBefore: false,
    })
    await loading

    expect(store.activeSession?.messages.map(message => message.content)).toEqual([
      'older answer',
      'new prompt while resume loads',
    ])
  })

  it('preserves an unchanged local row omitted from a partial resume snapshot', async () => {
    const store = useChatStore()
    const session = store.newChat({ profile: 'tester' })
    session.messages.push({ id: 'local-old', role: 'user', content: 'keep omitted row', timestamp: 100_000 })

    let onResumed!: (data: any) => void
    resumeSessionMock.mockImplementation((_sessionId: string, callback: (data: any) => void) => {
      onResumed = callback
      return { disconnect: vi.fn() }
    })
    const switching = store.switchSession(session.id)
    for (let i = 0; i < 10 && !onResumed; i += 1) await Promise.resolve()
    onResumed({
      session_id: session.id,
      isWorking: false,
      events: [],
      messages: [{ id: 42, session_id: session.id, role: 'assistant', content: 'partial server row', timestamp: 101 }],
      messageTotal: 2,
      messageLoadedCount: 1,
      hasMoreBefore: true,
    })
    await switching

    expect(session.messages.map(message => message.content)).toEqual(['keep omitted row', 'partial server row'])
  })

  it('preserves authoritative server order when message timestamps are skewed', async () => {
    const store = useChatStore()
    const session = store.newChat({ profile: 'tester' })

    let onResumed!: (data: any) => void
    resumeSessionMock.mockImplementation((_sessionId: string, callback: (data: any) => void) => {
      onResumed = callback
      return { disconnect: vi.fn() }
    })
    const switching = store.switchSession(session.id)
    for (let i = 0; i < 10 && !onResumed; i += 1) await Promise.resolve()
    onResumed({
      session_id: session.id,
      isWorking: false,
      events: [],
      messages: [
        { id: 1, session_id: session.id, role: 'user', content: 'server first', timestamp: 200 },
        { id: 2, session_id: session.id, role: 'assistant', content: 'server second', timestamp: 100 },
      ],
      messageTotal: 2,
      messageLoadedCount: 2,
      hasMoreBefore: false,
    })
    await switching

    expect(session.messages.map(message => message.content)).toEqual(['server first', 'server second'])
  })

  it('reconciles a persisted server echo of an optimistic prompt with a different id', async () => {
    const store = useChatStore()
    const session = store.newChat({ profile: 'tester' })

    await store.sendMessage('prompt persisted during reconnect')
    const optimisticPrompt = session.messages.find(message => message.role === 'user')
    expect(optimisticPrompt).toBeDefined()

    const reconnectOptions = startRunViaSocketMock.mock.calls[0][5] as {
      onReconnectResume: (data: any) => void | Promise<void>
    }
    await reconnectOptions.onReconnectResume({
      session_id: session.id,
      isWorking: true,
      events: [],
      messages: [{
        id: 42,
        client_id: optimisticPrompt!.id,
        session_id: session.id,
        role: 'user',
        content: 'prompt persisted during reconnect',
        timestamp: (optimisticPrompt!.timestamp - 86_400_000) / 1000,
      }],
      messageTotal: 1,
      messageLoadedCount: 1,
      hasMoreBefore: false,
    })

    expect(session.messages.filter(message => message.role === 'user')).toEqual([
      expect.objectContaining({
        id: optimisticPrompt!.id,
        content: 'prompt persisted during reconnect',
      }),
    ])
  })

  it('does not reconcile a repeated optimistic prompt against an already loaded server row', async () => {
    const store = useChatStore()
    const session = store.newChat({ profile: 'tester' })
    const previousTimestamp = Date.now() - 500
    session.messages.push({
      id: '41',
      role: 'user',
      content: 'repeat this prompt',
      timestamp: previousTimestamp,
    })

    await store.sendMessage('repeat this prompt')
    const optimisticPrompt = session.messages.find(message => message.id !== '41' && message.role === 'user')
    expect(optimisticPrompt).toBeDefined()

    const reconnectOptions = startRunViaSocketMock.mock.calls[0][5] as {
      onReconnectResume: (data: any) => void | Promise<void>
    }
    await reconnectOptions.onReconnectResume({
      session_id: session.id,
      isWorking: true,
      events: [],
      messages: [{
        id: 41,
        session_id: session.id,
        role: 'user',
        content: 'repeat this prompt',
        timestamp: previousTimestamp / 1000,
      }],
      messageTotal: 1,
      messageLoadedCount: 1,
      hasMoreBefore: false,
    })

    expect(session.messages.filter(message => message.role === 'user')).toHaveLength(2)
    expect(session.messages.map(message => message.id)).toEqual(expect.arrayContaining(['41', optimisticPrompt!.id]))
  })

  it('does not let an unchanged hydration snapshot consume a repeated optimistic prompt', async () => {
    const store = useChatStore()
    const session = store.newChat({ profile: 'tester' })
    const previousTimestamp = Date.now() - 500
    session.messages.push({
      id: '41',
      role: 'user',
      content: 'repeat during hydration',
      timestamp: previousTimestamp,
    })

    let onResumed!: (data: any) => void
    resumeSessionMock.mockImplementation((_sessionId: string, callback: (data: any) => void) => {
      onResumed = callback
      return { disconnect: vi.fn() }
    })
    const switching = store.switchSession(session.id)
    for (let i = 0; i < 10 && !onResumed; i += 1) await Promise.resolve()

    await store.sendMessage('repeat during hydration')
    const optimisticPrompt = session.messages.find(message => message.id !== '41' && message.role === 'user')
    expect(optimisticPrompt).toBeDefined()

    onResumed({
      session_id: session.id,
      isWorking: true,
      events: [],
      messages: [{
        id: 41,
        session_id: session.id,
        role: 'user',
        content: 'repeat during hydration',
        timestamp: previousTimestamp / 1000,
      }],
      messageTotal: 1,
      messageLoadedCount: 1,
      hasMoreBefore: false,
    })
    await switching

    expect(session.messages.filter(message => message.role === 'user')).toHaveLength(2)
    expect(session.messages.map(message => message.id)).toEqual(expect.arrayContaining(['41', optimisticPrompt!.id]))
  })

  it('accepts an older successful hydration when a newer same-session request fails', async () => {
    const session = {
      id: 'session-1',
      title: 'first',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      profile: 'tester',
    }
    const resolvers: Array<(value: any) => void> = []
    fetchSessionMessagesPageMock.mockImplementation(() => new Promise(resolve => {
      resolvers.push(resolve)
    }))
    const store = useChatStore()
    store.sessions = [session as any]
    store.activeSessionId = session.id
    store.activeSession = session as any

    const firstRefresh = store.refreshActiveSession()
    const secondRefresh = store.refreshActiveSession()
    for (let i = 0; i < 10 && resolvers.length < 2; i += 1) await Promise.resolve()

    resolvers[1](null)
    await secondRefresh
    resolvers[0]({
      session: { id: session.id, title: 'first' },
      messages: [{
        id: 1,
        session_id: session.id,
        role: 'assistant',
        content: 'older successful page',
        timestamp: 100,
      }],
      total: 1,
      offset: 0,
      limit: 150,
      hasMore: false,
    })
    await firstRefresh

    expect(session.messages.map(message => message.content)).toEqual(['older successful page'])
  })

  it('preserves an in-place streaming update that occurs during hydration', async () => {
    const session = {
      id: 'session-1',
      title: 'first',
      messages: [{
        id: 'assistant-1',
        role: 'assistant',
        content: 'partial',
        timestamp: 100_000,
        isStreaming: true,
      }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      profile: 'tester',
    }
    let resolvePage!: (value: any) => void
    fetchSessionMessagesPageMock.mockImplementation(() => new Promise(resolve => {
      resolvePage = resolve
    }))
    const store = useChatStore()
    store.sessions = [session as any]
    store.activeSessionId = session.id
    store.activeSession = session as any

    const refresh = store.refreshActiveSession()
    for (let i = 0; i < 10 && !resolvePage; i += 1) await Promise.resolve()
    session.messages[0].content = 'partial continued locally'
    resolvePage({
      session: { id: session.id, title: 'first' },
      messages: [{
        id: 'assistant-1',
        session_id: session.id,
        role: 'assistant',
        content: 'partial',
        timestamp: 100,
      }],
      total: 1,
      offset: 0,
      limit: 150,
      hasMore: false,
    })
    await refresh

    expect(session.messages[0]).toEqual(expect.objectContaining({
      content: 'partial continued locally',
      isStreaming: true,
    }))
  })

  it('does not replace visible messages with a raw page that maps to no visible rows', async () => {
    const session = {
      id: 'session-1',
      title: 'first',
      messages: [{
        id: 'assistant-visible',
        role: 'assistant',
        content: 'keep visible answer',
        timestamp: 100_000,
      }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      profile: 'tester',
    }
    fetchSessionMessagesPageMock.mockResolvedValue({
      session: { id: session.id, title: 'first' },
      messages: [{
        id: 'assistant-empty',
        session_id: session.id,
        role: 'assistant',
        content: '   ',
        timestamp: 101,
      }],
      total: 1,
      offset: 0,
      limit: 150,
      hasMore: false,
    })
    const store = useChatStore()
    store.sessions = [session as any]
    store.activeSessionId = session.id
    store.activeSession = session as any

    const hydrated = await store.refreshActiveSession()

    expect(hydrated).toBe(false)
    expect(session.messages.map(message => message.content)).toEqual(['keep visible answer'])
  })

  it('does not clear the current transcript when reconnect resume returns an empty message array', async () => {
    const store = useChatStore()
    const session = store.newChat({ profile: 'tester' })
    session.messages.push({
      id: 'older-assistant',
      role: 'assistant',
      content: 'existing answer',
      timestamp: Date.now() - 1_000,
    })

    await store.sendMessage('keep this prompt')

    const reconnectOptions = startRunViaSocketMock.mock.calls[0][5] as {
      onReconnectResume: (data: any) => void | Promise<void>
    }
    await reconnectOptions.onReconnectResume({
      session_id: session.id,
      messages: [],
      messageTotal: 0,
      messageLoadedCount: 0,
      isWorking: true,
      events: [],
    })

    expect(session.messages.map(message => message.content)).toEqual([
      'existing answer',
      'keep this prompt',
    ])
  })

  it('does not let non-empty reconnect resume overwrite newer local run state', async () => {
    const store = useChatStore()
    const session = store.newChat({ profile: 'tester' })
    session.messages.push({
      id: 'assistant-live',
      role: 'assistant',
      content: 'newer streamed answer',
      timestamp: Date.now() - 1_000,
      isStreaming: true,
    })

    await store.sendMessage('keep this newer prompt')

    const reconnectOptions = startRunViaSocketMock.mock.calls[0][5] as {
      onReconnectResume: (data: any) => void | Promise<void>
    }
    await reconnectOptions.onReconnectResume({
      session_id: session.id,
      messages: [
        {
          id: 'server-old',
          session_id: session.id,
          role: 'assistant',
          content: 'older server answer',
          timestamp: (Date.now() - 2_000) / 1000,
        },
        {
          id: 'assistant-live',
          session_id: session.id,
          role: 'assistant',
          content: 'stale streamed answer',
          timestamp: (Date.now() - 1_000) / 1000,
        },
      ],
      messageTotal: 2,
      messageLoadedCount: 2,
      isWorking: true,
      events: [],
    })

    expect(session.messages.map(message => message.content)).toEqual(expect.arrayContaining([
      'older server answer',
      'newer streamed answer',
      'keep this newer prompt',
    ]))
    expect(session.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'stale streamed answer' }),
    ]))
  })

  it('uses authoritative final rows when reconnect reports the run completed', async () => {
    const store = useChatStore()
    const session = store.newChat({ profile: 'tester' })
    session.messages.push({
      id: 'assistant-final',
      role: 'assistant',
      content: 'local partial answer',
      timestamp: Date.now() - 1_000,
      isStreaming: true,
    })

    await store.sendMessage('finish while disconnected')

    const reconnectOptions = startRunViaSocketMock.mock.calls[0][5] as {
      onReconnectResume: (data: any) => void | Promise<void>
    }
    await reconnectOptions.onReconnectResume({
      session_id: session.id,
      messages: [{
        id: 'assistant-final',
        session_id: session.id,
        role: 'assistant',
        content: 'authoritative final answer',
        timestamp: Date.now() / 1000,
        finish_reason: 'stop',
      }],
      messageTotal: 1,
      messageLoadedCount: 1,
      isWorking: false,
      events: [],
    })

    const finalMessage = session.messages.find(message => message.id === 'assistant-final')
    expect(finalMessage).toEqual(expect.objectContaining({ content: 'authoritative final answer' }))
    expect(finalMessage?.isStreaming).not.toBe(true)
  })

  it('does not append a new run delta to an old null-finish assistant', async () => {
    const store = useChatStore()
    const session = store.newChat({ profile: 'tester' })
    session.messages.push({
      id: 'assistant-old',
      role: 'assistant',
      content: 'previous turn answer',
      timestamp: Date.now() + 86_400_000,
      finishReason: null,
    })

    await store.sendMessage('new turn prompt')
    const onEvent = startRunViaSocketMock.mock.calls[0][1] as (data: any) => void
    const reconnectOptions = startRunViaSocketMock.mock.calls[0][5] as {
      onReconnectResume: (data: any) => void | Promise<void>
    }
    await reconnectOptions.onReconnectResume({
      session_id: session.id,
      messages: [
        {
          id: 'assistant-old',
          session_id: session.id,
          role: 'assistant',
          content: 'previous turn answer',
          timestamp: (Date.now() + 86_400_000) / 1000,
          finish_reason: null,
        },
      ],
      messageTotal: 1,
      messageLoadedCount: 1,
      isWorking: true,
      events: [],
    })

    onEvent({
      event: 'message.delta',
      session_id: session.id,
      delta: 'new run answer',
      run_id: 'run-new',
    })

    expect(session.messages.find(message => message.id === 'assistant-old')?.content).toBe('previous turn answer')
    expect(session.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual([
      'previous turn answer',
      'new run answer',
    ])
  })

  it('falls back to paginated messages when foreground resume returns empty for a non-empty active session', async () => {
    const session = {
      id: 'session-1',
      title: 'first',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 2,
      messageTotal: 2,
      profile: 'tester',
    }
    resumeSessionMock.mockImplementation((_sessionId: string, onResumed: (data: any) => void) => {
      onResumed({
        session_id: 'session-1',
        isWorking: false,
        events: [],
        messages: [],
        messageTotal: 2,
        messageLoadedCount: 0,
        hasMoreBefore: false,
      })
      return { disconnect: vi.fn() }
    })
    fetchSessionMessagesPageMock.mockResolvedValue({
      session: { id: 'session-1', title: 'first' },
      messages: [
        {
          id: 1,
          session_id: 'session-1',
          role: 'assistant',
          content: 'foreground fallback',
          timestamp: 100,
        },
      ],
      total: 1,
      offset: 0,
      limit: 150,
      hasMore: false,
    })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })

    const store = useChatStore()
    store.sessions = [session as any]
    store.activeSessionId = 'session-1'
    store.activeSession = session as any

    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    await Promise.resolve()

    expect(fetchSessionMessagesPageMock).toHaveBeenCalledWith('session-1', 0, 150, 'tester')
    expect(store.activeSession?.messages.map(message => message.content)).toEqual(['foreground fallback'])
  })

  it('preserves local messages omitted from a partial foreground resume snapshot', async () => {
    const session = {
      id: 'session-1',
      title: 'first',
      messages: [
        {
          id: 'local-kept',
          role: 'user',
          content: 'keep visible row',
          timestamp: 100_000,
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 2,
      messageTotal: 2,
      profile: 'tester',
    }
    resumeSessionMock.mockImplementation((_sessionId: string, onResumed: (data: any) => void) => {
      onResumed({
        session_id: 'session-1',
        isWorking: false,
        events: [],
        messages: [
          {
            id: 2,
            session_id: 'session-1',
            role: 'assistant',
            content: 'foreground partial',
            timestamp: 101,
          },
        ],
        messageTotal: 2,
        messageLoadedCount: 1,
        hasMoreBefore: true,
      })
      return { disconnect: vi.fn() }
    })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })

    const store = useChatStore()
    store.sessions = [session as any]
    store.activeSessionId = 'session-1'
    store.activeSession = session as any

    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    await Promise.resolve()

    expect(store.activeSession?.messages.map(message => message.content)).toEqual([
      'keep visible row',
      'foreground partial',
    ])
  })

  it('accepts a changed server row when foreground resume finds the local row unchanged', async () => {
    const session = {
      id: 'session-1',
      title: 'first',
      messages: [
        {
          id: '2',
          role: 'assistant',
          content: 'stale local content',
          timestamp: 100_000,
          isStreaming: true,
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 1,
      messageTotal: 1,
      profile: 'tester',
    }
    resumeSessionMock.mockImplementation((_sessionId: string, onResumed: (data: any) => void) => {
      onResumed({
        session_id: 'session-1',
        isWorking: false,
        events: [],
        messages: [
          {
            id: 2,
            session_id: 'session-1',
            role: 'assistant',
            content: 'authoritative final content',
            timestamp: 101,
            finish_reason: 'stop',
            run_id: 'run-final',
          },
        ],
        messageTotal: 1,
        messageLoadedCount: 1,
        hasMoreBefore: false,
      })
      return { disconnect: vi.fn() }
    })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })

    const store = useChatStore()
    store.sessions = [session as any]
    store.activeSessionId = 'session-1'
    store.activeSession = session as any

    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    await Promise.resolve()

    expect(store.activeSession?.messages[0]).toMatchObject({
      content: 'authoritative final content',
      finishReason: 'stop',
      runId: 'run-final',
    })
    expect(store.activeSession?.messages[0]?.isStreaming).not.toBe(true)
  })

  it('archives a session and removes it from the normal session list', async () => {
    fetchSessionsMock.mockResolvedValue([
      {
        id: 'session-1',
        source: 'api_server',
        model: 'm',
        title: 'first',
        started_at: 100,
        ended_at: null,
        last_active: 100,
        message_count: 0,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        profile: 'tester',
      },
      {
        id: 'session-2',
        source: 'api_server',
        model: 'm',
        title: 'second',
        started_at: 101,
        ended_at: null,
        last_active: 101,
        message_count: 0,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        profile: 'tester',
      },
    ])
    const store = useChatStore()
    await store.loadSessions('tester', 'session-1')

    await expect(store.archiveSession('session-1')).resolves.toBe(true)

    expect(setSessionArchivedMock).toHaveBeenCalledWith('session-1', true, 'tester')
    expect(store.sessions.map(session => session.id)).toEqual(['session-2'])
    expect(store.activeSessionId).toBe('session-2')
  })

  it('maps persisted expert metadata from session summaries', async () => {
    const expertAvatar = '/api/hermes/plugin-assets/keep-resource-delivery/expert.png'
    fetchSessionsMock.mockResolvedValue([
      {
        id: 'expert-session',
        source: 'api_server',
        model: 'm',
        title: 'expert',
        started_at: 100,
        ended_at: null,
        last_active: 100,
        message_count: 0,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        profile: 'tester',
        expert_id: 'keep-resource-delivery',
        expert_label: '资源投放专家',
        expert_avatar: expertAvatar,
      },
    ])
    const store = useChatStore()

    await store.loadSessions('tester', 'expert-session')

    expect(store.activeSession).toMatchObject({
      id: 'expert-session',
      expertId: 'keep-resource-delivery',
      expertLabel: '资源投放专家',
      expertAvatar,
    })
  })

  it('does not reuse a selected expert after switching to an ordinary Hermes session', async () => {
    const expertAvatar = '/api/hermes/plugin-assets/keep-resource-delivery/expert.png'
    fetchSessionsMock.mockResolvedValue([
      {
        id: 'expert-session',
        source: 'api_server',
        model: 'm',
        title: 'expert',
        started_at: 100,
        ended_at: null,
        last_active: 100,
        message_count: 0,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        profile: 'tester',
        expert_id: 'keep-resource-delivery',
        expert_label: '资源投放专家',
        expert_avatar: expertAvatar,
      },
      {
        id: 'ordinary-session',
        source: 'api_server',
        model: 'm',
        title: 'ordinary',
        started_at: 101,
        ended_at: null,
        last_active: 101,
        message_count: 0,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        profile: 'tester',
      },
    ])
    const store = useChatStore()

    await store.loadSessions('tester', 'expert-session')
    store.setActiveExpert('keep-resource-delivery', {
      avatar: expertAvatar,
      label: '资源投放专家',
    })
    await store.switchSession('ordinary-session')

    expect(store.activeExpertId).toBeNull()
    await store.sendMessage('ordinary hello')

    const runPayload = startRunViaSocketMock.mock.calls[0][0]
    expect(runPayload.session_id).toBe('ordinary-session')
    expect(runPayload.expert_id).toBeUndefined()
    expect(runPayload.expert_label).toBeUndefined()
    expect(runPayload.expert_avatar).toBeUndefined()
  })

  it('does not carry the active expert into a brand-new chat (+新对话)', async () => {
    // Repro of the sunke-profile prod bug: an expert was active (activated in
    // 专家广场 or promoted by browsing an old expert chat), then "+新对话"
    // force-selected that expert on the fresh chat the user never chose it for.
    const expertAvatar = '/api/hermes/plugin-assets/keep-resource-delivery/expert.png'
    const store = useChatStore()

    // setActiveExpert is exactly what syncActiveExpertFromSession() calls when
    // you merely view an old expert session, so this faithfully simulates the
    // "browsed an expert chat → it became the sticky global default" state.
    store.setActiveExpert('keep-resource-delivery', {
      avatar: expertAvatar,
      label: '资源投放专家',
    })
    expect(store.activeExpertId).toBe('keep-resource-delivery')

    setActiveExpertIdMock.mockClear()
    const session = store.newChat()
    // Fresh chat must be clean: no expert stamped, composer chip cleared, and
    // the sticky default persisted-cleared (setActiveExpertId(null) → the real
    // api/client does localStorage.removeItem) — not just the in-memory ref.
    expect(session.expertId).toBeUndefined()
    expect(store.activeExpertId).toBeNull()
    expect(setActiveExpertIdMock).toHaveBeenLastCalledWith(null)

    await store.sendMessage('你是谁')
    const runPayload = startRunViaSocketMock.mock.calls[0][0]
    expect(runPayload.session_id).toBe(session.id)
    expect(runPayload.expert_id).toBeUndefined()
    expect(runPayload.expert_label).toBeUndefined()
    expect(runPayload.expert_avatar).toBeUndefined()
  })

  it('renders subagent run events as a delegate_task tool card', async () => {
    const store = useChatStore()
    store.newChat()

    await store.sendMessage('delegate this')

    const onEvent = startRunViaSocketMock.mock.calls[0][1]
    onEvent({
      event: 'subagent.start',
      session_id: store.activeSession!.id,
      run_id: 'run-1',
      subagent_id: 'a',
      task_index: 0,
      task_count: 2,
      goal: 'inspect files',
    })
    onEvent({
      event: 'subagent.complete',
      session_id: store.activeSession!.id,
      run_id: 'run-1',
      subagent_id: 'a',
      task_index: 0,
      task_count: 2,
      status: 'completed',
      summary: 'found the file',
    })

    const toolMessage = store.activeSession!.messages.find(m => m.role === 'tool' && m.toolName === 'delegate_task')
    expect(toolMessage).toMatchObject({
      toolCallId: 'subagent:run-1:a',
      toolStatus: 'done',
    })
    expect(toolMessage?.toolPreview).toContain('subagent 1/2 completed')
    expect(toolMessage?.toolResult).toContain('found the file')
  })

  it('tracks and responds to clarify prompts for the active session', async () => {
    const store = useChatStore()
    store.newChat()

    await store.sendMessage('make a report')

    const onEvent = startRunViaSocketMock.mock.calls[0][1]
    onEvent({
      event: 'clarify.requested',
      session_id: store.activeSession!.id,
      run_id: 'run-1',
      clarify_id: 'clarify-1',
      question: 'Which report style?',
      choices: ['brief', 'detailed'],
    })

    expect(store.activePendingClarify).toMatchObject({
      clarifyId: 'clarify-1',
      question: 'Which report style?',
      choices: ['brief', 'detailed'],
    })

    // Upstream rebaseline renamed the store action to respondToClarify and it
    // now derives sessionId/clarifyId from the active pending-clarify state
    // (single `response` arg) and passes the runtime transport ('chat-run').
    store.respondToClarify('brief')

    expect(respondClarifyMock).toHaveBeenCalledWith(
      store.activeSession!.id,
      'clarify-1',
      'brief',
      'chat-run',
    )
    expect(store.activePendingClarify).toBeNull()
  })
})
