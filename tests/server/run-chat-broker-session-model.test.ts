import { afterEach, describe, expect, it, vi } from 'vitest'

// The chat header's model selection is persisted on the session row
// (POST /api/hermes/sessions/:id/model), but the client only sends model/provider on
// the session's FIRST turn. Regression coverage: every later turn must still reach the
// Run Broker with the stored model/provider pair instead of silently falling back to
// the profile default.
const sessionStore = vi.hoisted(() => ({
  getSession: vi.fn(() => ({ id: 's1', profile: 'default', workspace: null, model: '', provider: '' })),
  getSessionRowId: vi.fn(() => 1),
  getSessionIncarnation: vi.fn(() => 1),
  updateSession: vi.fn(),
}))

vi.mock('../../packages/server/src/config', () => ({
  config: { runBrokerUrl: 'http://broker.test', runBrokerKey: 'k' },
}))
vi.mock('../../packages/server/src/db/hermes/session-store', () => sessionStore)
vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: () => '/tmp',
}))
vi.mock('../../packages/server/src/services/hermes/hermes-path', () => ({
  isNearestExistingRealPathWithin: vi.fn(async () => true),
}))
vi.mock('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker', () => ({
  startWorkspaceRunCheckpoint: vi.fn(() => ({ key: 'checkpoint-1' })),
  discardWorkspaceRunCheckpoint: vi.fn(),
  completeWorkspaceRunCheckpoint: vi.fn(() => null),
}))

import { handleBrokerRun } from '../../packages/server/src/services/hermes/run-chat/handle-broker-run'

function sseStream(...frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f))
      c.close()
    },
  })
}

function fakeContext() {
  const state = { messages: [], isWorking: false, events: [], queue: [], runId: undefined, abortController: undefined } as any
  return {
    sessionMap: new Map([['s1', state]]),
    getOrCreateSession: () => state,
    getResponseRunState: () => ({ responseId: undefined, insertedKeys: new Set(), toolCalls: new Map() }),
    markCompleted: vi.fn(async () => ({ finalized: true })),
    abandonRun: vi.fn(() => true),
    dequeueNextQueuedRun: vi.fn(() => true),
    buildInput: (x: any) => x,
  } as any
}

function fakeSocket() {
  return { data: { user: { openid: 'ou_alice' } }, join: vi.fn(), emit: vi.fn(), connected: true } as any
}

/** Runs one broker turn and hands back everything the assertions need. */
async function runTurn(data: Record<string, any>, profile = 'default') {
  let body: any
  const fetchMock = vi.fn(async (_url: string, init: any) => {
    body = JSON.parse(String(init?.body || '{}'))
    return { ok: true, body: sseStream('event: done\ndata: {"kind":"done","run_id":"r"}\n\n'), status: 200 } as any
  })
  vi.stubGlobal('fetch', fetchMock)
  const socket = fakeSocket()
  const context = fakeContext()
  await handleBrokerRun(socket, { input: 'hi', session_id: 's1', ...data } as any, profile, 'rm', vi.fn(), context)
  return { fetchMock, socket, context, metadata: (body?.metadata || {}) as Record<string, any> }
}

/** Runs a broker turn and returns the metadata block the broker actually received. */
async function runAndCaptureMetadata(data: Record<string, any>): Promise<Record<string, any>> {
  return (await runTurn(data)).metadata
}

afterEach(() => {
  vi.restoreAllMocks()
  sessionStore.getSession.mockReset()
  sessionStore.getSession.mockReturnValue({ id: 's1', profile: 'default', workspace: null, model: '', provider: '' })
  sessionStore.updateSession.mockClear()
})

describe('broker run model stickiness', () => {
  it('uses the request model/provider when the turn carries them', async () => {
    sessionStore.getSession.mockReturnValue({
      id: 's1', profile: 'default', workspace: null, model: 'stored-model', provider: 'stored-provider',
    } as any)

    const metadata = await runAndCaptureMetadata({ model: 'req-model', provider: 'req-provider' })

    expect(metadata.model).toBe('req-model')
    expect(metadata.provider).toBe('req-provider')
  })

  it('falls back to the stored session model/provider pair when the turn omits them', async () => {
    sessionStore.getSession.mockReturnValue({
      id: 's1', profile: 'default', workspace: null, model: 'stored-model', provider: 'stored-provider',
    } as any)

    const metadata = await runAndCaptureMetadata({})

    expect(metadata.model).toBe('stored-model')
    expect(metadata.provider).toBe('stored-provider')
  })

  it('never mixes the request provider with the stored session model', async () => {
    sessionStore.getSession.mockReturnValue({
      id: 's1', profile: 'default', workspace: null, model: 'stored-model', provider: 'stored-provider',
    } as any)

    const metadata = await runAndCaptureMetadata({ provider: 'req-provider' })

    expect(metadata.model).toBe('stored-model')
    expect(metadata.provider).toBe('stored-provider')
  })

  it('omits model/provider when neither the turn nor the session has a model', async () => {
    const metadata = await runAndCaptureMetadata({})

    expect('model' in metadata).toBe(false)
    expect('provider' in metadata).toBe(false)
  })
})

// getSession() resolves a session id globally — nothing filters by profile. A socket
// authenticated as profile B must not be able to drive profile A's session, or it
// would write into A's transcript and (via the stickiness fallback above) run under
// A's persisted model/provider and workspace.
describe('broker run cross-profile session fence', () => {
  it('rejects the run when the session row belongs to another profile', async () => {
    sessionStore.getSession.mockReturnValue({
      id: 's1', profile: 'user_a', workspace: '/tmp/a', model: 'a-model', provider: 'a-provider',
    } as any)

    const { fetchMock, socket, context } = await runTurn({}, 'user_b')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(context.abandonRun).toHaveBeenCalled()
    // No transcript write: markCompleted is the only path that persists messages here.
    expect(context.markCompleted).not.toHaveBeenCalled()
    expect(sessionStore.updateSession).not.toHaveBeenCalled()
    expect(socket.emit).toHaveBeenCalledWith('run.rejected', expect.objectContaining({
      event: 'run.rejected',
      session_id: 's1',
      error: 'Session belongs to a different profile',
    }))
  })

  it('allows the run when the session row profile matches the socket profile', async () => {
    sessionStore.getSession.mockReturnValue({
      id: 's1', profile: 'user_a', workspace: null, model: 'a-model', provider: 'a-provider',
    } as any)

    const { fetchMock, socket, metadata } = await runTurn({}, 'user_a')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(metadata.model).toBe('a-model')
    expect(socket.emit).not.toHaveBeenCalledWith('run.rejected', expect.anything())
  })

  it('allows legacy sessions where both sides default to the "default" profile', async () => {
    sessionStore.getSession.mockReturnValue({
      id: 's1', profile: 'default', workspace: null, model: '', provider: '',
    } as any)

    const { fetchMock, socket } = await runTurn({}, 'default')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(socket.emit).not.toHaveBeenCalledWith('run.rejected', expect.anything())
  })
})
