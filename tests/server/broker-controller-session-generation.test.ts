import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dbState = vi.hoisted(() => ({ db: null as DatabaseSync | null, appHome: '' }))
const tracker = vi.hoisted(() => ({ start: vi.fn(), complete: vi.fn(), discard: vi.fn() }))
const remoteDelete = vi.hoisted(() => ({ inspect: vi.fn(), remove: vi.fn() }))
const chatRun = vi.hoisted(() => ({ server: undefined as any }))
const workspace = vi.hoisted(() => ({ ensure: vi.fn() }))

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
  config: {
    appHome: dbState.appHome,
    authMode: 'token',
    uploadDir: '/tmp/uploads',
    webuiRunBroker: true,
    runBrokerUrl: 'http://broker.test',
    runBrokerKey: 'secret',
  },
}))
vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  getSessionDetailFromDb: vi.fn(async () => null),
  getSessionDetailFromDbWithProfile: vi.fn(async () => null),
  getExactSessionDetailFromDbWithProfile: remoteDelete.inspect,
}))
vi.mock('../../packages/server/src/db/hermes/compression-snapshot', () => ({ getCompressionSnapshot: vi.fn(() => null) }))
vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({
  deleteUsage: vi.fn(),
  getUsage: vi.fn(),
  getUsageBatch: vi.fn(),
  updateUsage: vi.fn(),
}))
vi.mock('../../packages/server/src/lib/context-compressor', () => ({
  ChatContextCompressor: vi.fn(),
  DEFAULT_COMPRESSION_CONFIG: {},
  SUMMARY_PREFIX: '[Previous context summary]',
  countTokens: vi.fn(() => 0),
}))
vi.mock('../../packages/server/src/lib/llm-prompt', () => ({ getSystemPrompt: vi.fn(() => '') }))
vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../packages/server/src/services/feishu-oauth', () => ({
  extractFeishuSessionFromCookieHeader: vi.fn(),
  getFeishuSessionSecret: vi.fn(() => 'secret'),
  parseFeishuSessionCookie: vi.fn(),
}))
vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: vi.fn(() => 'research'),
  getProfileDir: vi.fn(() => '/tmp/profile'),
  listProfileNamesFromDisk: vi.fn(() => ['research']),
}))
vi.mock('../../packages/server/src/services/hermes/agent-ownership', () => ({
  ownerOwnsProfile: vi.fn(() => false),
  resolveOwnedProfileAgentId: vi.fn(),
}))
vi.mock('../../packages/server/src/services/compat-user', () => ({ ensureWebUserForFeishu: vi.fn(() => ({ id: 1 })) }))
vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  authenticateUserToken: vi.fn(),
  isAuthEnabled: vi.fn(async () => false),
}))
vi.mock('../../packages/server/src/db/hermes/users-store', () => ({
  listUserProfiles: vi.fn(() => []),
  userCanAccessProfile: vi.fn(() => true),
}))
vi.mock('../../packages/server/src/services/hermes/model-context', () => ({ getModelContextLength: vi.fn(() => 200000) }))
vi.mock('../../packages/server/src/services/hermes/run-chat/workspace', () => ({
  ensureHermesRunWorkspace: workspace.ensure,
}))
vi.mock('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker', () => ({
  startWorkspaceRunCheckpoint: tracker.start,
  completeWorkspaceRunCheckpoint: tracker.complete,
  discardWorkspaceRunCheckpoint: tracker.discard,
}))
vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  deleteSessionForProfile: remoteDelete.remove,
}))
vi.mock('../../packages/server/src/routes/hermes/chat-run', () => ({
  getChatRunServer: () => chatRun.server,
}))
vi.mock('../../packages/server/src/routes/hermes/group-chat', () => ({
  getGroupChatServer: vi.fn(() => undefined),
}))
vi.mock('../../packages/server/src/services/agent-runner/coding-agent-run-manager', () => ({
  codingAgentRunManager: { stop: vi.fn() },
}))
vi.mock('../../packages/server/src/services/hermes/agent-bridge', () => ({
  AgentBridgeClient: vi.fn(),
  getAgentBridgeManager: vi.fn(() => ({
    ensureReady: vi.fn(async () => ({ reachable: true, status: 'ready' })),
    getRuntimeState: () => ({ ready: false, running: false }),
  })),
}))
vi.mock('../../packages/server/src/services/hermes/agent-bridge/manager', () => ({
  getAgentBridgeManager: vi.fn(() => ({
    ensureReady: vi.fn(async () => ({ reachable: true, status: 'ready' })),
    getRuntimeState: () => ({ ready: false, running: false }),
  })),
}))

import { initAllHermesTables } from '../../packages/server/src/db/hermes/schemas'
import {
  createSession,
  deleteSession,
  getSession,
  getSessionDetail,
  getSessionIncarnation,
  getSessionRowId,
} from '../../packages/server/src/db/hermes/session-store'
import { saveWorkspaceRunChange, listWorkspaceRunChangesForSession } from '../../packages/server/src/db/hermes/workspace-run-changes-store'
import { MESSAGES_TABLE, WORKSPACE_RUN_CHANGES_TABLE, WORKSPACE_RUN_CHANGE_FILES_TABLE } from '../../packages/server/src/db/hermes/schemas'
import { BrokerRunController } from '../../packages/server/src/services/hermes/broker-controller'
import { ChatRunSocket } from '../../packages/server/src/services/hermes/run-chat'
import { handleBridgeRun } from '../../packages/server/src/services/hermes/run-chat/handle-bridge-run'
import { batchRemove, remove } from '../../packages/server/src/controllers/hermes/sessions'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function sseDone(runId: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(`event: done\ndata: ${JSON.stringify({ kind: 'done', run_id: runId })}\n\n`)
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

function harness() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const emitted: Array<{ event: string; payload: any }> = []
  const socket = {
    id: 'socket-generation',
    connected: true,
    data: { profile: 'research', user: { openid: 'ou_test' } },
    handshake: { query: { profile: 'research' }, auth: {}, headers: {} },
    join: vi.fn(),
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
  }
  const controller = new BrokerRunController()
  ;(controller as any).nsp = {
    adapter: { rooms: new Map() },
    to: vi.fn(() => ({ emit: (event: string, payload: any) => emitted.push({ event, payload }) })),
  }
  ;(controller as any).onConnection(socket)
  return { controller, emitted, handlers, socket }
}

function bridgeHarness() {
  const emitted: Array<{ event: string; payload: any }> = []
  const handlers = new Map<string, (...args: any[]) => any>()
  const room = new Set(['socket-bridge-generation'])
  const nsp = {
    adapter: { rooms: new Map([['session:same-id', room]]) },
    sockets: new Map(),
    to: vi.fn(() => ({
      emit: (event: string, payload: any) => emitted.push({ event, payload }),
    })),
  }
  const socket = {
    id: 'socket-bridge-generation',
    connected: true,
    data: {},
    handshake: { query: { profile: 'research' }, auth: {}, headers: {} },
    join: vi.fn(),
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
    to: vi.fn(() => ({
      emit: (event: string, payload: any) => emitted.push({ event, payload }),
    })),
  }
  nsp.sockets.set(socket.id, socket)
  const server = new ChatRunSocket({ of: vi.fn(() => nsp) } as any)
  const state = { messages: [], isWorking: false, events: [], queue: [] }
  ;(server as any).sessionMap.set('same-id', state)
  chatRun.server = server
  return {
    emitted,
    handlers,
    nsp: nsp as any,
    server,
    sessionMap: (server as any).sessionMap as Map<string, any>,
    socket: socket as any,
    state,
  }
}

function parkCredentialRun(controller: BrokerRunController, runId = 'parked-run') {
  const state = (controller as any).getOrCreateSession('same-id', 'research')
  state.parkedCredentialRuns ||= new Map()
  state.parkedCredentialRuns.set(runId, {
    rowId: getSessionRowId('same-id'),
    incarnation: getSessionIncarnation('same-id'),
    resumeEvent: {
      id: `credential-${runId}`,
      event: 'auth.required',
      data: { event: 'auth.required', session_id: 'same-id', run_id: runId },
    },
  })
  return state
}

function seedWorkspaceChange(sessionId = 'same-id') {
  saveWorkspaceRunChange({
    change_id: `change-${sessionId}`,
    session_id: sessionId,
    session_rowid: getSessionRowId(sessionId)!,
    session_incarnation: getSessionIncarnation(sessionId)!,
    run_id: `run-${sessionId}`,
    workspace: 'workspace',
    workspace_kind: 'filesystem',
    started_at: 1,
    finished_at: 2,
    files: [{
      path: 'changed.txt',
      change_type: 'modified',
      additions: 1,
      deletions: 0,
      patch: '+changed',
      patch_bytes: 8,
    }],
  })
}

function expectSessionPurged(sessionId = 'same-id') {
  expect(getSession(sessionId)).toBeNull()
  expect(getSessionDetail(sessionId)).toBeNull()
  expect(listWorkspaceRunChangesForSession(sessionId)).toEqual([])
  for (const table of [MESSAGES_TABLE, WORKSPACE_RUN_CHANGES_TABLE, WORKSPACE_RUN_CHANGE_FILES_TABLE]) {
    expect(dbState.db!.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`).get(sessionId)).toEqual({ count: 0 })
  }
}

describe('BrokerRunController session generation integration', () => {
  let root: string

  beforeEach(() => {
    vi.clearAllMocks()
    chatRun.server = undefined
    root = mkdtempSync(join(tmpdir(), 'hermes-broker-generation-'))
    dbState.appHome = root
    dbState.db = new DatabaseSync(join(root, 'sessions.db'))
    initAllHermesTables()
    createSession({ id: 'same-id', profile: 'research', workspace: '/tmp/workspace' })
    workspace.ensure.mockResolvedValue('/tmp/workspace')
    tracker.start.mockResolvedValue({ key: 'checkpoint' })
    tracker.complete.mockResolvedValue(null)
  })

  afterEach(() => {
    dbState.db?.close()
    dbState.db = null
    rmSync(root, { recursive: true, force: true })
  })

  it('starts a same-id recreated session instead of queueing it on the deleted generation', async () => {
    const oldCheckpoint = deferred<any>()
    const newResponse = deferred<any>()
    tracker.start.mockReturnValueOnce(oldCheckpoint.promise)
    const fetchMock = vi.fn().mockReturnValueOnce(newResponse.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { controller, handlers } = harness()

    const oldRowId = getSessionRowId('same-id')
    const oldIncarnation = getSessionIncarnation('same-id')
    const oldRun = handlers.get('run')!({ input: 'old generation', session_id: 'same-id', queue_id: 'old' })
    await vi.waitFor(() => expect(tracker.start).toHaveBeenCalledTimes(1))
    const oldState = (controller as any).getSessionState('same-id', 'research')

    expect(deleteSession('same-id')).toBe(true)
    createSession({ id: 'same-id', profile: 'research', workspace: '/tmp/workspace' })
    expect(getSessionIncarnation('same-id')).not.toBe(oldIncarnation)

    const newRun = handlers.get('run')!({ input: 'new generation', session_id: 'same-id', queue_id: 'new' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const newState = (controller as any).getSessionState('same-id', 'research')
    expect(newState).not.toBe(oldState)
    expect(newState).toMatchObject({
      isWorking: true,
      queue: [],
      sessionRowId: getSessionRowId('same-id'),
      sessionIncarnation: getSessionIncarnation('same-id'),
    })
    expect(newState.sessionRowId).toBe(oldRowId)

    oldCheckpoint.resolve({ key: 'old-checkpoint' })
    await oldRun
    expect(oldState).toMatchObject({ isWorking: false, queue: [], activeRunMarker: undefined })
    expect((controller as any).getSessionState('same-id', 'research')).toBe(newState)
    expect(newState.isWorking).toBe(true)

    newResponse.resolve({ ok: true, status: 200, body: sseDone('new-run') })
    await newRun
    expect(newState.isWorking).toBe(false)
  })

  it('starts a public bridge run instead of queueing it on a deleted same-id generation', async () => {
    const { handlers, server, sessionMap, socket, state: oldState } = bridgeHarness()
    const oldAbort = new AbortController()
    Object.assign(oldState, {
      isWorking: true,
      activeRunMarker: 'deleted-generation-run',
      abortController: oldAbort,
      sessionRowId: getSessionRowId('same-id'),
      sessionIncarnation: getSessionIncarnation('same-id'),
    })
    oldState.queue.push({
      queue_id: 'deleted-generation-queue',
      input: 'must be discarded',
      source: 'cli',
      profile: 'research',
    })

    expect(deleteSession('same-id')).toBe(true)
    createSession({
      id: 'same-id',
      profile: 'research',
      workspace: '/tmp/workspace',
      title: 'public replacement',
    })

    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'replacement-bridge-run', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 10,
        fixed_context_tokens: 5,
        message_count: 1,
        tool_count: 0,
        system_prompt_chars: 1,
      }),
      streamOutput: vi.fn(async function* () {}),
    } as any
    ;(server as any).bridge = bridge
    ;(server as any).onConnection(socket)

    await handlers.get('run')!({
      input: 'replacement request',
      session_id: 'same-id',
      source: 'cli',
      workspace: '/tmp/workspace',
      model: 'test-model',
      provider: 'test-provider',
      queue_id: 'replacement-request',
    })

    expect(bridge.chat).toHaveBeenCalledTimes(1)
    expect(oldAbort.signal.aborted).toBe(true)
    expect(oldState.queue).toEqual([])
    expect(oldState).toMatchObject({
      isWorking: false,
      activeRunMarker: undefined,
    })
    const replacementState = sessionMap.get('same-id')!
    expect(replacementState).not.toBe(oldState)
    expect(replacementState).toMatchObject({
      sessionRowId: getSessionRowId('same-id'),
      sessionIncarnation: getSessionIncarnation('same-id'),
      queue: [],
    })
  })

  it('does not delete a newer same-generation run when an old checkpoint setup resolves late', async () => {
    const checkpoint = deferred<any>()
    tracker.start.mockReturnValueOnce(checkpoint.promise)
    const { nsp, server, sessionMap, socket } = bridgeHarness()
    const bridge = {
      chat: vi.fn(),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 10,
        fixed_context_tokens: 5,
        message_count: 1,
        tool_count: 0,
        system_prompt_chars: 1,
      }),
      streamOutput: vi.fn(async function* () {}),
    } as any

    const oldRun = handleBridgeRun(
      nsp,
      socket,
      {
        input: 'old checkpoint request',
        session_id: 'same-id',
        workspace: '/tmp/workspace',
        model: 'test-model',
        provider: 'test-provider',
      },
      'research',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )
    await vi.waitFor(() => expect(tracker.start).toHaveBeenCalledTimes(1))

    const state = sessionMap.get('same-id')!
    state.isWorking = true
    state.activeRunMarker = 'newer-same-generation-run'
    state.runId = 'newer-run-id'
    checkpoint.resolve({ key: 'old-checkpoint' })
    await oldRun

    expect(bridge.chat).not.toHaveBeenCalled()
    expect(tracker.discard).toHaveBeenCalledWith({
      sessionId: 'same-id',
      checkpoint: { key: 'old-checkpoint' },
    })
    expect(sessionMap.get('same-id')).toBe(state)
    expect(state).toMatchObject({
      isWorking: true,
      activeRunMarker: 'newer-same-generation-run',
      runId: 'newer-run-id',
    })
  })

  it('keeps an HTTP-recreated bridge session when the deleted generation checkpoint resolves late', async () => {
    const checkpoint = deferred<any>()
    const remote = deferred<boolean>()
    tracker.start.mockReturnValueOnce(checkpoint.promise)
    remoteDelete.inspect.mockResolvedValue({ id: 'same-id', messages: [] })
    remoteDelete.remove.mockReturnValue(remote.promise)
    const { emitted, nsp, server, sessionMap, socket } = bridgeHarness()
    const bridge = {
      chat: vi.fn(),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 10,
        fixed_context_tokens: 5,
        message_count: 1,
        tool_count: 0,
        system_prompt_chars: 1,
      }),
      streamOutput: vi.fn(),
    } as any

    const oldRun = handleBridgeRun(
      nsp,
      socket,
      {
        input: 'old request',
        session_id: 'same-id',
        workspace: '/tmp/workspace',
        model: 'test-model',
        provider: 'test-provider',
      },
      'research',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )
    await vi.waitFor(() => expect(tracker.start).toHaveBeenCalledTimes(1))

    const ctx: any = {
      params: { id: 'same-id' },
      state: { user: { id: 1, role: 'super_admin' } },
      body: null,
    }
    const deleting = remove(ctx)
    await vi.waitFor(() => expect(remoteDelete.remove).toHaveBeenCalledWith('same-id', 'research'))
    expect(getSession('same-id')).toBeNull()

    createSession({
      id: 'same-id',
      profile: 'research',
      workspace: '/tmp/workspace',
      title: 'checkpoint replacement',
    })
    const replacementState = {
      messages: [],
      isWorking: true,
      events: [{ event: 'replacement.started', data: { event: 'replacement.started' } }],
      queue: [],
      runId: 'replacement-run',
      activeRunMarker: 'replacement-marker',
      sessionRowId: getSessionRowId('same-id'),
      sessionIncarnation: getSessionIncarnation('same-id'),
      profile: 'research',
    }
    sessionMap.set('same-id', replacementState)
    emitted.length = 0
    socket.emit.mockClear()
    tracker.complete.mockClear()

    checkpoint.resolve({ key: 'deleted-generation-checkpoint' })
    await oldRun

    expect(bridge.chat).not.toHaveBeenCalled()
    expect(tracker.discard).toHaveBeenCalledWith({
      sessionId: 'same-id',
      checkpoint: { key: 'deleted-generation-checkpoint' },
    })
    expect(tracker.complete).not.toHaveBeenCalled()
    expect((server as any).sessionMap.get('same-id')).toBe(replacementState)
    expect(getSession('same-id')).toMatchObject({
      title: 'checkpoint replacement',
      message_count: 0,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
    })
    expect(getSessionDetail('same-id')?.messages).toEqual([])
    expect(replacementState.events).toEqual([
      { event: 'replacement.started', data: { event: 'replacement.started' } },
    ])
    expect(emitted).toEqual([])
    expect(socket.emit).not.toHaveBeenCalled()

    remote.resolve(true)
    await deleting
    expect((server as any).sessionMap.get('same-id')).toBe(replacementState)
    expect(getSession('same-id')?.title).toBe('checkpoint replacement')
  })

  it('does not start or mutate a same-id replacement while bridge workspace setup resolves late', async () => {
    const workspaceSetup = deferred<string>()
    const remote = deferred<boolean>()
    expect(deleteSession('same-id')).toBe(true)
    workspace.ensure.mockReturnValueOnce(workspaceSetup.promise)
    remoteDelete.inspect.mockResolvedValue({ id: 'same-id', messages: [] })
    remoteDelete.remove.mockReturnValue(remote.promise)
    const { emitted, nsp, server, sessionMap, socket, state } = bridgeHarness()
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'stale-bridge-run', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 10,
        fixed_context_tokens: 5,
        message_count: 1,
        tool_count: 0,
        system_prompt_chars: 1,
      }),
      streamOutput: vi.fn(async function* () {}),
    } as any
    ;(server as any).bridge = bridge

    const oldRun = (server as any).handleRun(
      socket,
      {
        input: 'old setup request',
        session_id: 'same-id',
        workspace: '/tmp/workspace',
        model: 'test-model',
        provider: 'test-provider',
        source: 'cli',
      },
      'research',
    )
    await vi.waitFor(() => expect(workspace.ensure).toHaveBeenCalledTimes(1))
    expect(getSession('same-id')).not.toBeNull()
    expect(state).toMatchObject({
      sessionRowId: getSessionRowId('same-id'),
      sessionIncarnation: getSessionIncarnation('same-id'),
    })

    const ctx: any = {
      params: { id: 'same-id' },
      state: { user: { id: 1, role: 'super_admin' } },
      body: null,
    }
    const deleting = remove(ctx)
    await vi.waitFor(() => expect(remoteDelete.remove).toHaveBeenCalledWith('same-id', 'research'))
    expect(getSession('same-id')).toBeNull()

    createSession({
      id: 'same-id',
      profile: 'research',
      workspace: '/tmp/workspace',
      title: 'setup replacement',
    })
    const replacementState = {
      messages: [],
      isWorking: true,
      events: [{ event: 'replacement.started', data: { event: 'replacement.started' } }],
      queue: [],
      runId: 'replacement-run',
      activeRunMarker: 'replacement-marker',
      sessionRowId: getSessionRowId('same-id'),
      sessionIncarnation: getSessionIncarnation('same-id'),
      profile: 'research',
    }
    sessionMap.set('same-id', replacementState)
    emitted.length = 0
    socket.emit.mockClear()

    workspaceSetup.resolve('/tmp/workspace')
    await oldRun

    expect(bridge.chat).not.toHaveBeenCalled()
    expect(workspace.ensure).toHaveBeenCalledTimes(1)
    expect((server as any).sessionMap.get('same-id')).toBe(replacementState)
    expect(getSession('same-id')).toMatchObject({
      title: 'setup replacement',
      message_count: 0,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
    })
    expect(getSessionDetail('same-id')?.messages).toEqual([])
    expect(replacementState.events).toEqual([
      { event: 'replacement.started', data: { event: 'replacement.started' } },
    ])
    expect(emitted).toEqual([])
    expect(socket.emit).not.toHaveBeenCalled()
    expect(state.messages).toEqual([])

    remote.resolve(true)
    await deleting
    expect((server as any).sessionMap.get('same-id')).toBe(replacementState)
    expect(getSession('same-id')?.title).toBe('setup replacement')
  })

  it('keeps a public bridge run state when delayed resume hydration returns', async () => {
    const hydration = deferred<any>()
    const workspaceSetup = deferred<string>()
    workspace.ensure.mockReturnValueOnce(workspaceSetup.promise)
    const handleApiRunModule = await import('../../packages/server/src/services/hermes/run-chat/handle-api-run')
    const loadSpy = vi.spyOn(handleApiRunModule, 'loadSessionStateFromDb').mockReturnValueOnce(hydration.promise)
    const { handlers, server, sessionMap, socket } = bridgeHarness()
    sessionMap.clear()
    const bridge = {
      statusIfLoaded: vi.fn().mockResolvedValue({ ok: true, exists: false, running: false, loaded: false }),
      chat: vi.fn().mockResolvedValue({ run_id: 'live-run', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 10,
        fixed_context_tokens: 5,
        message_count: 1,
        tool_count: 0,
        system_prompt_chars: 1,
      }),
      streamOutput: vi.fn(async function* () {}),
    } as any
    ;(server as any).bridge = bridge
    ;(server as any).onConnection(socket)

    const resuming = handlers.get('resume')!({ session_id: 'same-id' })
    await vi.waitFor(() => expect(loadSpy).toHaveBeenCalledTimes(1))

    const running = handlers.get('run')!({
      input: 'live request',
      session_id: 'same-id',
      source: 'cli',
      workspace: '/tmp/workspace',
      model: 'test-model',
      provider: 'test-provider',
    })
    await vi.waitFor(() => expect(workspace.ensure).toHaveBeenCalledTimes(1))
    const runState = sessionMap.get('same-id')!
    expect(runState.activeRunMarker).toBeTruthy()

    hydration.resolve({
      messages: [{ id: 99, session_id: 'same-id', role: 'user', content: 'stale hydration', timestamp: 1 }],
      isWorking: false,
      events: [],
      queue: [],
    })
    await resuming

    expect(sessionMap.get('same-id')).toBe(runState)
    expect(runState.messages).toEqual([])
    expect(runState.activeRunMarker).toBeTruthy()
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'same-id',
      messages: [],
      isWorking: true,
    }))

    workspaceSetup.resolve('/tmp/workspace')
    await running
  })

  it('does not emit a delayed bridge reattach failure into a same-id replacement', async () => {
    const status = deferred<any>()
    const remote = deferred<boolean>()
    remoteDelete.inspect.mockResolvedValue({ id: 'same-id', messages: [] })
    remoteDelete.remove.mockReturnValue(remote.promise)
    const { emitted, handlers, server, sessionMap, socket, state } = bridgeHarness()
    const bridge = {
      statusIfLoaded: vi.fn().mockReturnValue(status.promise),
    } as any
    ;(server as any).bridge = bridge
    ;(server as any).onConnection(socket)

    const resuming = handlers.get('resume')!({ session_id: 'same-id' })
    await vi.waitFor(() => expect(bridge.statusIfLoaded).toHaveBeenCalledTimes(1))

    const ctx: any = {
      params: { id: 'same-id' },
      state: { user: { id: 1, role: 'super_admin' } },
      body: null,
    }
    const deleting = remove(ctx)
    await vi.waitFor(() => expect(remoteDelete.remove).toHaveBeenCalledWith('same-id', 'research'))
    createSession({
      id: 'same-id',
      profile: 'research',
      workspace: '/tmp/workspace',
      title: 'reattach replacement',
    })
    const replacementState = {
      messages: [],
      isWorking: true,
      events: [{ event: 'replacement.started', data: { event: 'replacement.started' } }],
      queue: [],
      runId: 'replacement-run',
      activeRunMarker: 'replacement-marker',
      sessionRowId: getSessionRowId('same-id'),
      sessionIncarnation: getSessionIncarnation('same-id'),
      profile: 'research',
    }
    sessionMap.set('same-id', replacementState)
    emitted.length = 0
    socket.emit.mockClear()

    status.reject(new Error('status failed'))
    await resuming

    expect(sessionMap.get('same-id')).toBe(replacementState)
    expect(replacementState.events).toEqual([
      { event: 'replacement.started', data: { event: 'replacement.started' } },
    ])
    expect(emitted.filter(item => item.event === 'run.reattach_failed')).toEqual([])
    expect(socket.emit).not.toHaveBeenCalledWith('run.reattach_failed', expect.anything())
    expect(state.events).toEqual([])

    remote.resolve(true)
    await deleting
  })

  it('does not let delayed reattach success overwrite a newer run in the same generation', async () => {
    const status = deferred<any>()
    const workspaceSetup = deferred<string>()
    workspace.ensure.mockReturnValueOnce(workspaceSetup.promise)
    const { handlers, server, sessionMap, socket } = bridgeHarness()
    const bridge = {
      statusIfLoaded: vi.fn().mockReturnValue(status.promise),
      chat: vi.fn().mockResolvedValue({ run_id: 'new-live-run', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 10,
        fixed_context_tokens: 5,
        message_count: 1,
        tool_count: 0,
        system_prompt_chars: 1,
      }),
      streamOutput: vi.fn(async function* () {}),
    } as any
    ;(server as any).bridge = bridge
    ;(server as any).onConnection(socket)

    const resuming = handlers.get('resume')!({ session_id: 'same-id' })
    await vi.waitFor(() => expect(bridge.statusIfLoaded).toHaveBeenCalledTimes(1))
    const running = handlers.get('run')!({
      input: 'new same-generation request',
      session_id: 'same-id',
      source: 'cli',
      workspace: '/tmp/workspace',
      model: 'test-model',
      provider: 'test-provider',
    })
    await vi.waitFor(() => expect(workspace.ensure).toHaveBeenCalledTimes(1))
    const liveState = sessionMap.get('same-id')!
    const liveMarker = liveState.activeRunMarker
    const liveEvents = liveState.events

    status.resolve({
      ok: true,
      exists: true,
      running: true,
      current_run_id: 'stale-reattach-run',
      loaded: true,
    })
    await resuming

    expect(sessionMap.get('same-id')).toBe(liveState)
    expect(liveState).toMatchObject({
      isWorking: true,
      runId: undefined,
      activeRunMarker: liveMarker,
    })
    expect(liveState.events).toBe(liveEvents)
    expect(bridge.streamOutput).not.toHaveBeenCalledWith('stale-reattach-run')

    workspaceSetup.resolve('/tmp/workspace')
    await running
  })

  it('does not emit delayed reattach failure into a newer run in the same generation', async () => {
    const status = deferred<any>()
    const workspaceSetup = deferred<string>()
    workspace.ensure.mockReturnValueOnce(workspaceSetup.promise)
    const { emitted, handlers, server, sessionMap, socket } = bridgeHarness()
    const bridge = {
      statusIfLoaded: vi.fn().mockReturnValue(status.promise),
      chat: vi.fn().mockResolvedValue({ run_id: 'new-live-run', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 10,
        fixed_context_tokens: 5,
        message_count: 1,
        tool_count: 0,
        system_prompt_chars: 1,
      }),
      streamOutput: vi.fn(async function* () {}),
    } as any
    ;(server as any).bridge = bridge
    ;(server as any).onConnection(socket)

    const resuming = handlers.get('resume')!({ session_id: 'same-id' })
    await vi.waitFor(() => expect(bridge.statusIfLoaded).toHaveBeenCalledTimes(1))
    const running = handlers.get('run')!({
      input: 'new same-generation request',
      session_id: 'same-id',
      source: 'cli',
      workspace: '/tmp/workspace',
      model: 'test-model',
      provider: 'test-provider',
    })
    await vi.waitFor(() => expect(workspace.ensure).toHaveBeenCalledTimes(1))
    const liveState = sessionMap.get('same-id')!
    const liveMarker = liveState.activeRunMarker
    const liveEvents = liveState.events
    emitted.length = 0
    socket.emit.mockClear()

    status.reject(new Error('stale status failure'))
    await resuming

    expect(sessionMap.get('same-id')).toBe(liveState)
    expect(liveState).toMatchObject({
      isWorking: true,
      activeRunMarker: liveMarker,
    })
    expect(liveState.events).toBe(liveEvents)
    expect(emitted.filter(item => item.event === 'run.reattach_failed')).toEqual([])
    expect(socket.emit).not.toHaveBeenCalledWith('run.reattach_failed', expect.anything())

    workspaceSetup.resolve('/tmp/workspace')
    await running
  })

  it('drops a delayed old bridge chunk after HTTP delete and same-id recreation', async () => {
    const chunk = deferred<void>()
    const remote = deferred<boolean>()
    remoteDelete.inspect.mockResolvedValue({ id: 'same-id', messages: [] })
    remoteDelete.remove.mockReturnValue(remote.promise)
    const { emitted, nsp, server, sessionMap, socket } = bridgeHarness()
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'old-bridge-run', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 10,
        fixed_context_tokens: 5,
        message_count: 1,
        tool_count: 0,
        system_prompt_chars: 1,
      }),
      streamOutput: vi.fn(async function* () {
        await chunk.promise
        yield {
          ok: true,
          run_id: 'old-bridge-run',
          session_id: 'same-id',
          status: 'completed',
          delta: 'stale output',
          output: 'stale output',
          done: true,
          events: [],
          error: null,
        }
      }),
    } as any

    const oldRun = handleBridgeRun(
      nsp,
      socket,
      {
        input: 'old request',
        session_id: 'same-id',
        workspace: '/tmp/workspace',
        model: 'test-model',
        provider: 'test-provider',
      },
      'research',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )
    await vi.waitFor(() => expect(bridge.streamOutput).toHaveBeenCalledWith('old-bridge-run'))

    const ctx: any = {
      params: { id: 'same-id' },
      state: { user: { id: 1, role: 'super_admin' } },
      body: null,
    }
    const deleting = remove(ctx)
    await vi.waitFor(() => expect(remoteDelete.remove).toHaveBeenCalledWith('same-id', 'research'))
    expect(getSession('same-id')).toBeNull()

    createSession({
      id: 'same-id',
      profile: 'research',
      workspace: '/tmp/workspace',
      title: 'stream replacement',
    })
    const replacementState = {
      messages: [],
      isWorking: true,
      events: [{ event: 'replacement.started', data: { event: 'replacement.started' } }],
      queue: [],
      runId: 'replacement-run',
      activeRunMarker: 'replacement-marker',
      sessionRowId: getSessionRowId('same-id'),
      sessionIncarnation: getSessionIncarnation('same-id'),
      profile: 'research',
    }
    sessionMap.set('same-id', replacementState)
    emitted.length = 0
    socket.emit.mockClear()
    tracker.complete.mockClear()

    chunk.resolve()
    await oldRun

    expect((server as any).sessionMap.get('same-id')).toBe(replacementState)
    expect(getSession('same-id')).toMatchObject({
      title: 'stream replacement',
      message_count: 0,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
    })
    expect(getSessionDetail('same-id')?.messages).toEqual([])
    expect(replacementState.events).toEqual([
      { event: 'replacement.started', data: { event: 'replacement.started' } },
    ])
    expect(tracker.complete).not.toHaveBeenCalled()
    expect(emitted).toEqual([])
    expect(socket.emit).not.toHaveBeenCalled()

    remote.resolve(true)
    await deleting
    expect((server as any).sessionMap.get('same-id')).toBe(replacementState)
    expect(getSession('same-id')?.title).toBe('stream replacement')
  })

  it('purges an active public run generation before awaiting remote single-session deletion', async () => {
    seedWorkspaceChange()
    const remote = deferred<boolean>()
    remoteDelete.inspect.mockResolvedValue({ id: 'same-id', messages: [] })
    remoteDelete.remove.mockReturnValue(remote.promise)
    let runSignal: AbortSignal | undefined
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      runSignal = init?.signal || undefined
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { controller, handlers } = harness()
    chatRun.server = controller

    const running = handlers.get('run')!({ input: 'active write', session_id: 'same-id', queue_id: 'active' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(getSessionDetail('same-id')?.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'active write' }),
    ])

    const ctx: any = {
      params: { id: 'same-id' },
      state: { user: { id: 1, role: 'super_admin' } },
      body: null,
    }
    const deleting = remove(ctx)
    await vi.waitFor(() => expect(remoteDelete.remove).toHaveBeenCalledWith('same-id', 'research'))

    expect(runSignal?.aborted).toBe(true)
    expectSessionPurged()
    await running
    expectSessionPurged()

    remote.resolve(true)
    await deleting
    expectSessionPurged()
    expect(ctx.body).toEqual({
      ok: true,
      deleted: true,
      hermes: { attempted: true, deleted: true, profile: 'research', error: undefined },
    })
  })

  it('purges a batch target before awaiting its remote deletion and preserves result counts', async () => {
    seedWorkspaceChange()
    const remote = deferred<boolean>()
    remoteDelete.inspect.mockResolvedValue({ id: 'same-id', messages: [] })
    remoteDelete.remove.mockReturnValue(remote.promise)
    const ctx: any = {
      request: { body: { sessions: [{ id: 'same-id', profile: 'research' }] } },
      state: { user: { id: 1, role: 'super_admin' } },
      body: null,
    }

    const deleting = batchRemove(ctx)
    await vi.waitFor(() => expect(remoteDelete.remove).toHaveBeenCalledWith('same-id', 'research'))
    expectSessionPurged()

    remote.resolve(true)
    await deleting
    expectSessionPurged()
    expect(ctx.body).toMatchObject({
      ok: true,
      deleted: 1,
      failed: 0,
      hermesDeleted: 1,
      hermesFailed: 0,
    })
  })

  it('rejects public credential replay after a real session deletion without recreating it', async () => {
    expect(deleteSession('same-id')).toBe(true)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { controller, handlers, socket } = harness()

    await handlers.get('credential.replay')!({ session_id: 'same-id', run_id: 'parked-run' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(getSession('same-id')).toBeNull()
    expect((controller as any).getSessionState('same-id', 'research')).toBeUndefined()
    expect(socket.emit).toHaveBeenCalledWith('run.reattach_failed', expect.objectContaining({
      session_id: 'same-id',
      run_id: 'parked-run',
      terminal: true,
    }))
  })

  it('rejects an old auth card after same-id delete and recreate without attaching it to the replacement generation', async () => {
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
    const { controller, handlers, socket } = harness()

    await handlers.get('run')!({ input: 'old generation', session_id: 'same-id', queue_id: 'old' })
    const oldState = (controller as any).getSessionState('same-id', 'research')
    expect(oldState.parkedCredentialRuns.get('parked-run')).toMatchObject({
      rowId: getSessionRowId('same-id'),
      incarnation: getSessionIncarnation('same-id'),
    })

    expect(deleteSession('same-id')).toBe(true)
    createSession({ id: 'same-id', profile: 'research', workspace: '/tmp/workspace', title: 'replacement' })
    socket.emit.mockClear()
    await handlers.get('credential.replay')!({ session_id: 'same-id', run_id: 'parked-run' })

    const replacementState = (controller as any).getSessionState('same-id', 'research')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(replacementState).not.toBe(oldState)
    expect(oldState.parkedCredentialRuns.size).toBe(0)
    expect(replacementState.parkedCredentialRuns?.has('parked-run')).not.toBe(true)
    expect(replacementState.pendingTerminalEvents).toBeUndefined()
    const failure = socket.emit.mock.calls.find(call => call[0] === 'run.reattach_failed')?.[1]
    expect(failure).toMatchObject({
      session_id: 'same-id',
      run_id: 'parked-run',
      error: 'Credential replay is no longer available',
    })
    expect(failure.resume_event_id).toBeUndefined()
    expect(getSession('same-id')?.title).toBe('replacement')
  })

  it('does not resume an accepted replay resolution into a same-id replacement generation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: sseDone('replayed-run'),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, handlers, socket } = harness()
    const oldState = parkCredentialRun(controller)
    const oldRowId = getSessionRowId('same-id')
    const oldIncarnation = getSessionIncarnation('same-id')

    await handlers.get('credential.replay')!({ session_id: 'same-id', run_id: 'parked-run' })

    expect(oldState.pendingTerminalEvents).toContainEqual(expect.objectContaining({
      event: 'auth.resolved',
      data: expect.objectContaining({
        run_id: 'parked-run',
        session_row_id: oldRowId,
        session_incarnation: oldIncarnation,
      }),
    }))
    expect(deleteSession('same-id')).toBe(true)
    createSession({ id: 'same-id', profile: 'research', workspace: '/tmp/workspace', title: 'replacement' })
    expect(getSessionIncarnation('same-id')).not.toBe(oldIncarnation)

    socket.emit.mockClear()
    handlers.get('resume')!({ session_id: 'same-id' })
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('resumed', expect.anything()))

    const replacementState = (controller as any).getSessionState('same-id', 'research')
    const resumed = socket.emit.mock.calls.find(call => call[0] === 'resumed')?.[1]
    expect(replacementState).not.toBe(oldState)
    expect(replacementState).toMatchObject({
      sessionRowId: getSessionRowId('same-id'),
      sessionIncarnation: getSessionIncarnation('same-id'),
    })
    expect(resumed.events).not.toContainEqual(expect.objectContaining({ event: 'auth.resolved' }))
  })

  it('abandons dispatched replay after real delete and same-id recreation', async () => {
    const upstream = controlledSse()
    let replaySignal: AbortSignal | undefined
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      replaySignal = init?.signal || undefined
      return Promise.resolve({ ok: true, status: 200, body: upstream.stream })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { controller, emitted, handlers } = harness()
    parkCredentialRun(controller)

    const replay = handlers.get('credential.replay')!({ session_id: 'same-id', run_id: 'parked-run' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(deleteSession('same-id')).toBe(true)
    createSession({ id: 'same-id', profile: 'research', workspace: '/tmp/workspace', title: 'replacement' })
    upstream.send('content', { kind: 'content', run_id: 'stale-replay', text: 'must not leak' })
    await replay

    expect(replaySignal?.aborted).toBe(true)
    expect((controller as any).getSessionState('same-id', 'research')).toBeUndefined()
    expect(emitted.filter(item => item.event === 'message.delta')).toHaveLength(0)
    expect(getSession('same-id')?.title).toBe('replacement')
    expect(getSessionDetail('same-id')?.messages).toEqual([])
  })
})
