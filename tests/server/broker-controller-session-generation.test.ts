import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dbState = vi.hoisted(() => ({ db: null as DatabaseSync | null, appHome: '' }))
const tracker = vi.hoisted(() => ({ start: vi.fn(), complete: vi.fn(), discard: vi.fn() }))

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
}))
vi.mock('../../packages/server/src/db/hermes/compression-snapshot', () => ({ getCompressionSnapshot: vi.fn(() => null) }))
vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({ updateUsage: vi.fn() }))
vi.mock('../../packages/server/src/lib/context-compressor', () => ({
  ChatContextCompressor: vi.fn(),
  SUMMARY_PREFIX: '[Previous context summary]',
  countTokens: vi.fn(() => 0),
}))
vi.mock('../../packages/server/src/lib/llm-prompt', () => ({ getSystemPrompt: vi.fn(() => '') }))
vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../packages/server/src/services/feishu-oauth', () => ({
  extractFeishuSessionFromCookieHeader: vi.fn(),
  getFeishuSessionSecret: vi.fn(() => 'secret'),
  parseFeishuSessionCookie: vi.fn(),
}))
vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({ getProfileDir: vi.fn(() => '/tmp/profile') }))
vi.mock('../../packages/server/src/services/hermes/agent-ownership', () => ({
  ownerOwnsProfile: vi.fn(() => false),
  resolveOwnedProfileAgentId: vi.fn(),
}))
vi.mock('../../packages/server/src/services/compat-user', () => ({ ensureWebUserForFeishu: vi.fn(() => ({ id: 1 })) }))
vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  authenticateUserToken: vi.fn(),
  isAuthEnabled: vi.fn(async () => false),
}))
vi.mock('../../packages/server/src/db/hermes/users-store', () => ({ userCanAccessProfile: vi.fn(() => true) }))
vi.mock('../../packages/server/src/services/hermes/model-context', () => ({ getModelContextLength: vi.fn(() => 200000) }))
vi.mock('../../packages/server/src/services/hermes/run-chat/workspace', () => ({
  ensureHermesRunWorkspace: vi.fn(async () => '/tmp/workspace'),
}))
vi.mock('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker', () => ({
  startWorkspaceRunCheckpoint: tracker.start,
  completeWorkspaceRunCheckpoint: tracker.complete,
  discardWorkspaceRunCheckpoint: tracker.discard,
}))

import { initAllHermesTables } from '../../packages/server/src/db/hermes/schemas'
import {
  createSession,
  deleteSession,
  getSessionIncarnation,
  getSessionRowId,
} from '../../packages/server/src/db/hermes/session-store'
import { BrokerRunController } from '../../packages/server/src/services/hermes/broker-controller'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
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

function harness() {
  const handlers = new Map<string, (...args: any[]) => any>()
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
    to: vi.fn(() => ({ emit: vi.fn() })),
  }
  ;(controller as any).onConnection(socket)
  return { controller, handlers }
}

describe('BrokerRunController session generation integration', () => {
  let root: string

  beforeEach(() => {
    vi.clearAllMocks()
    root = mkdtempSync(join(tmpdir(), 'hermes-broker-generation-'))
    dbState.appHome = root
    dbState.db = new DatabaseSync(join(root, 'sessions.db'))
    initAllHermesTables()
    createSession({ id: 'same-id', profile: 'research', workspace: '/tmp/workspace' })
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
})
