import { beforeEach, describe, expect, it, vi } from 'vitest'

const respondToBrokerAuthorizationMock = vi.hoisted(() => vi.fn())
const getSessionMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSession: getSessionMock,
  getSessionDetail: vi.fn(() => null),
  createSession: vi.fn(),
  addMessage: vi.fn(),
  updateSession: vi.fn(),
  updateSessionStats: vi.fn(),
  getSessionRowId: vi.fn(() => 1),
  getSessionIncarnation: vi.fn(() => 1),
}))

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  getSessionDetailFromDb: vi.fn(async () => null),
  getSessionDetailFromDbWithProfile: vi.fn(async () => null),
}))

vi.mock('../../packages/server/src/db/hermes/compression-snapshot', () => ({
  getCompressionSnapshot: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({
  updateUsage: vi.fn(),
}))

vi.mock('../../packages/server/src/lib/context-compressor', () => ({
  ChatContextCompressor: vi.fn(),
  SUMMARY_PREFIX: '[Previous context summary]',
  countTokens: vi.fn((value: string) => String(value || '').length),
}))

vi.mock('../../packages/server/src/lib/llm-prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/config', () => ({
  config: {
    authMode: 'token',
    uploadDir: '/tmp/uploads',
    webuiRunBroker: true,
    runBrokerUrl: 'https://broker.invalid',
  },
}))

vi.mock('../../packages/server/src/services/feishu-oauth', () => ({
  extractFeishuSessionFromCookieHeader: vi.fn(),
  getFeishuSessionSecret: vi.fn(() => 'secret'),
  parseFeishuSessionCookie: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: vi.fn(() => '/tmp/hermes-profile'),
}))

vi.mock('../../packages/server/src/services/hermes/agent-ownership', () => ({
  ownerOwnsProfile: vi.fn(() => false),
  resolveOwnedProfileAgentId: vi.fn(),
}))

vi.mock('../../packages/server/src/services/compat-user', () => ({
  ensureWebUserForFeishu: vi.fn(() => ({ id: 1 })),
}))

vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  authenticateUserToken: vi.fn(),
  isAuthEnabled: vi.fn(async () => false),
}))

vi.mock('../../packages/server/src/db/hermes/users-store', () => ({
  userCanAccessProfile: vi.fn(() => true),
}))

vi.mock('../../packages/server/src/services/hermes/expert-registry-client', () => ({
  fetchExpertCatalog: vi.fn(async () => ({ profile_name: 'default', experts: [] })),
}))

vi.mock('../../packages/server/src/services/hermes/model-context', () => ({
  getModelContextLength: vi.fn(() => 200000),
}))

// The mapper and the replay memory are the units under test here, so they stay
// REAL; only the broker HTTP hop is stubbed.
vi.mock('../../packages/server/src/services/hermes/run-chat/handle-broker-run', async () => {
  const actual = await vi.importActual<any>(
    '../../packages/server/src/services/hermes/run-chat/handle-broker-run',
  )
  return {
    ...actual,
    handleBrokerRun: vi.fn(),
    respondToBrokerAuthorization: respondToBrokerAuthorizationMock,
    respondToBrokerApproval: vi.fn(),
    respondToBrokerClarify: vi.fn(),
    runBrokerGoalEvaluate: vi.fn(),
    runBrokerSessionCommand: vi.fn(),
    parseBrokerSessionCommand: vi.fn(() => null),
  }
})

import {
  mapRunBrokerFrameForChat,
  rememberBrokerWorkflowEvent,
} from '../../packages/server/src/services/hermes/run-chat/handle-broker-run'

const OWNER_OPEN_ID = 'ou_owner_seed_1'

function createSocketHarness() {
  const handlers = new Map<string, Function>()
  const roomEmit = vi.fn()
  const socket = {
    id: 'socket-1',
    connected: true,
    data: { user: { openid: OWNER_OPEN_ID, id: 7 }, profile: 'default' },
    handshake: { auth: {}, query: { profile: 'default' } },
    on: vi.fn((event: string, handler: Function) => { handlers.set(event, handler) }),
    join: vi.fn(),
    emit: vi.fn(),
  }
  return { handlers, roomEmit, socket }
}

async function createController() {
  const { BrokerRunController } = await import(
    '../../packages/server/src/services/hermes/broker-controller'
  )
  const controller: any = new BrokerRunController()
  const harness = createSocketHarness()
  const to = vi.fn(() => ({ emit: harness.roomEmit }))
  controller.nsp = { to }
  controller.onConnection(harness.socket)
  return { controller, to, ...harness }
}

/** Every payload this feature put on the wire, in one bag. */
function emittedPayloads(socket: any, roomEmit: any): unknown[] {
  return [
    ...socket.emit.mock.calls.map((call: any[]) => call[1]),
    ...roomEmit.mock.calls.map((call: any[]) => call[1]),
  ]
}

describe('inline authorization — broker frame mapping', () => {
  it('maps authorization_required onto an authorization.required chat event', () => {
    expect(mapRunBrokerFrameForChat({
      kind: 'authorization_required',
      run_id: 'run-1',
      payload: {
        authorization_id: 'auth-1',
        service: 'lark-cli',
        scopes: ['im:message', 'drive:file'],
        expires_at: 1780000000,
        state: 'pending',
      },
    })).toEqual({
      type: 'emit',
      event: 'authorization.required',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: {
        event: 'authorization.required',
        run_id: 'run-1',
        response_id: 'run-1',
        authorization_id: 'auth-1',
        service: 'lark-cli',
        scopes: ['im:message', 'drive:file'],
        expires_at: 1780000000,
        state: 'pending',
      },
    })
  })

  it('maps authorization_resolved with its terminal state and reason', () => {
    expect(mapRunBrokerFrameForChat({
      kind: 'authorization_resolved',
      run_id: 'run-1',
      payload: {
        authorization_id: 'auth-1',
        service: 'kep-cli-online',
        state: 'expired',
        reason: 'deadline passed',
      },
    })).toEqual(expect.objectContaining({
      type: 'emit',
      event: 'authorization.resolved',
      payload: expect.objectContaining({
        authorization_id: 'auth-1',
        service: 'kep-cli-online',
        state: 'expired',
        reason: 'deadline passed',
      }),
    }))
  })

  it('also accepts the dotted broker aliases', () => {
    expect(mapRunBrokerFrameForChat({
      kind: 'authorization.required',
      payload: { authorization_id: 'auth-2', service: 'kep-cli-pre' },
    })).toEqual(expect.objectContaining({ event: 'authorization.required' }))
    expect(mapRunBrokerFrameForChat({
      kind: 'authorization.resolved',
      payload: { authorization_id: 'auth-2', state: 'success' },
    })).toEqual(expect.objectContaining({ event: 'authorization.resolved' }))
  })

  it('ignores authorization frames with no authorization_id', () => {
    expect(mapRunBrokerFrameForChat({
      kind: 'authorization_required',
      payload: { service: 'lark-cli', scopes: [] },
    })).toEqual({ type: 'ignore' })
    expect(mapRunBrokerFrameForChat({
      kind: 'authorization_resolved',
      payload: { state: 'success' },
    })).toEqual({ type: 'ignore' })
  })
})

describe('inline authorization — replay memory', () => {
  it('keeps the pending card available to resume and drops it when resolved', () => {
    const state = { events: [] as Array<{ event: string; data: any }> }
    const card = { authorization_id: 'auth-1', service: 'lark-cli', state: 'pending' }

    rememberBrokerWorkflowEvent(state, 'authorization.required', card)
    expect(state.events).toEqual([{ event: 'authorization.required', data: card }])

    rememberBrokerWorkflowEvent(state, 'authorization.resolved', {
      authorization_id: 'auth-1', state: 'success',
    })
    expect(state.events).toEqual([])
  })

  it('dedupes by authorization_id and keeps sibling requests independent', () => {
    const state = { events: [] as Array<{ event: string; data: any }> }
    rememberBrokerWorkflowEvent(state, 'authorization.required', { authorization_id: 'auth-1', state: 'pending' })
    rememberBrokerWorkflowEvent(state, 'authorization.required', { authorization_id: 'auth-1', state: 'pending', scopes: ['a'] })
    rememberBrokerWorkflowEvent(state, 'authorization.required', { authorization_id: 'auth-2', state: 'pending' })

    expect(state.events).toEqual([
      { event: 'authorization.required', data: { authorization_id: 'auth-1', state: 'pending', scopes: ['a'] } },
      { event: 'authorization.required', data: { authorization_id: 'auth-2', state: 'pending' } },
    ])

    rememberBrokerWorkflowEvent(state, 'authorization.resolved', { authorization_id: 'auth-2', state: 'cancelled' })
    expect(state.events).toEqual([
      { event: 'authorization.required', data: { authorization_id: 'auth-1', state: 'pending', scopes: ['a'] } },
    ])
  })

  it('survives into the resume replay list alongside the other workflow events', () => {
    const state = { events: [] as Array<{ event: string; data: any }> }
    rememberBrokerWorkflowEvent(state, 'workflow.stage', { stage: 'run', status: 'running' })
    rememberBrokerWorkflowEvent(state, 'authorization.required', { authorization_id: 'auth-1', state: 'pending' })

    // This is exactly how resumeSession assembles what an F5'd client replays.
    const replayEvents = [...state.events]
    expect(replayEvents.map(item => item.event)).toEqual(['workflow.stage', 'authorization.required'])
  })
})

describe('inline authorization — socket handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSessionMock.mockImplementation((id: string) => ({
      id, profile: 'default', user_id: OWNER_OPEN_ID, source: 'cli',
    }))
    respondToBrokerAuthorizationMock.mockReset()
  })

  it('returns the broker-minted verification URL to the requesting socket only', async () => {
    respondToBrokerAuthorizationMock.mockResolvedValue({
      ok: true, authorization_id: 'auth-1', verification_uri: 'https://broker.invalid/device/AB12',
    })
    const { handlers, socket, roomEmit, to } = await createController()

    await handlers.get('authorization.respond')?.({
      session_id: 'session-1', authorization_id: 'auth-1', action: 'authorize',
    })

    expect(respondToBrokerAuthorizationMock).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'default', sessionId: 'session-1', authorizationId: 'auth-1', action: 'authorize',
    }))
    expect(socket.emit).toHaveBeenCalledWith('authorization.url', {
      event: 'authorization.url',
      session_id: 'session-1',
      authorization_id: 'auth-1',
      verification_uri: 'https://broker.invalid/device/AB12',
    })
    expect(to).not.toHaveBeenCalled()
    expect(roomEmit).not.toHaveBeenCalled()
  })

  it('stays silent while confirm reports the user has not authorized yet', async () => {
    respondToBrokerAuthorizationMock.mockResolvedValue({ ok: false, state: 'pending', reason: 'not_authorized' })
    const { handlers, socket, roomEmit } = await createController()

    await handlers.get('authorization.respond')?.({
      session_id: 'session-1', authorization_id: 'auth-1', action: 'confirm',
    })

    expect(respondToBrokerAuthorizationMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'confirm' }))
    expect(socket.emit).not.toHaveBeenCalled()
    expect(roomEmit).not.toHaveBeenCalled()
  })

  it('does not synthesize success on confirm — the broker pushes it on the run stream', async () => {
    respondToBrokerAuthorizationMock.mockResolvedValue({ ok: true, state: 'success' })
    const { handlers, socket, roomEmit } = await createController()

    await handlers.get('authorization.respond')?.({
      session_id: 'session-1', authorization_id: 'auth-1', action: 'confirm',
    })

    expect(socket.emit).not.toHaveBeenCalled()
    expect(roomEmit).not.toHaveBeenCalled()
  })

  it('broadcasts a cancelled resolution to the session room and forgets the replay card', async () => {
    respondToBrokerAuthorizationMock.mockResolvedValue({ ok: true, state: 'cancelled' })
    const { controller, handlers, roomEmit, to } = await createController()
    const state = { events: [{ event: 'authorization.required', data: { authorization_id: 'auth-1' } }] }
    controller.sessionMap.set('default\u0000session-1', state)

    await handlers.get('authorization.respond')?.({
      session_id: 'session-1', authorization_id: 'auth-1', action: 'cancel',
    })

    expect(to).toHaveBeenCalledWith('session:default:session-1')
    expect(roomEmit).toHaveBeenCalledWith('authorization.resolved', {
      event: 'authorization.resolved',
      session_id: 'session-1',
      authorization_id: 'auth-1',
      state: 'cancelled',
      reason: '',
    })
    expect(state.events).toEqual([])
  })

  it('surfaces a gone/consumed request as a terminal authorization.failed, not a retry', async () => {
    respondToBrokerAuthorizationMock.mockRejectedValue(new Error('Run broker authorization 404'))
    const { handlers, socket, roomEmit } = await createController()

    await handlers.get('authorization.respond')?.({
      session_id: 'session-1', authorization_id: 'auth-1', action: 'authorize',
    })

    expect(socket.emit).toHaveBeenCalledWith('authorization.failed', {
      event: 'authorization.failed',
      session_id: 'session-1',
      authorization_id: 'auth-1',
      error: 'Run broker authorization 404',
    })
    expect(roomEmit).not.toHaveBeenCalled()
  })

  it('fails closed when authorize comes back without a verification URL', async () => {
    respondToBrokerAuthorizationMock.mockResolvedValue({ ok: true, authorization_id: 'auth-1' })
    const { handlers, socket } = await createController()

    await handlers.get('authorization.respond')?.({
      session_id: 'session-1', authorization_id: 'auth-1', action: 'authorize',
    })

    expect(socket.emit).toHaveBeenCalledWith('authorization.failed', expect.objectContaining({
      authorization_id: 'auth-1',
    }))
    expect(socket.emit).not.toHaveBeenCalledWith('authorization.url', expect.anything())
  })

  it('refuses a session this socket does not own and never calls the broker', async () => {
    getSessionMock.mockImplementation((id: string) => ({
      id, profile: 'default', user_id: 'ou_someone_else', source: 'cli',
    }))
    const { handlers, socket, roomEmit } = await createController()

    await handlers.get('authorization.respond')?.({
      session_id: 'session-1', authorization_id: 'auth-1', action: 'authorize',
    })

    expect(respondToBrokerAuthorizationMock).not.toHaveBeenCalled()
    expect(socket.emit).toHaveBeenCalledWith('run.rejected', expect.objectContaining({
      session_id: 'session-1',
    }))
    expect(roomEmit).not.toHaveBeenCalled()
  })

  it('ignores unknown actions instead of forwarding them to the broker', async () => {
    const { handlers, socket, roomEmit } = await createController()

    await handlers.get('authorization.respond')?.({
      session_id: 'session-1', authorization_id: 'auth-1', action: 'approve',
    })

    expect(respondToBrokerAuthorizationMock).not.toHaveBeenCalled()
    expect(socket.emit).not.toHaveBeenCalled()
    expect(roomEmit).not.toHaveBeenCalled()
  })

  it('never puts a token or an open_id on the wire', async () => {
    respondToBrokerAuthorizationMock.mockResolvedValue({
      ok: true,
      authorization_id: 'auth-1',
      verification_uri: 'https://broker.invalid/device/AB12',
      // A sloppy broker echoing secrets back must not leak through the socket.
      access_token: 'tok_super_secret_value',
      owner_open_id: OWNER_OPEN_ID,
    })
    const { handlers, socket, roomEmit } = await createController()

    await handlers.get('authorization.respond')?.({
      session_id: 'session-1', authorization_id: 'auth-1', action: 'authorize',
    })
    respondToBrokerAuthorizationMock.mockResolvedValue({ ok: true, state: 'cancelled' })
    await handlers.get('authorization.respond')?.({
      session_id: 'session-1', authorization_id: 'auth-1', action: 'cancel',
    })

    const payloads = emittedPayloads(socket, roomEmit)
    expect(payloads.length).toBeGreaterThan(0)
    for (const payload of payloads) {
      const serialized = JSON.stringify(payload)
      expect(serialized).not.toContain('ou_')
      expect(serialized).not.toContain('tok_super_secret_value')
      expect(serialized).not.toContain('access_token')
    }
  })

  it('never routes into the credential.replay run-resurrection path', async () => {
    respondToBrokerAuthorizationMock.mockResolvedValue({ ok: true, state: 'cancelled' })
    const { handlers, socket, roomEmit } = await createController()

    await handlers.get('authorization.respond')?.({
      session_id: 'session-1', authorization_id: 'auth-1', action: 'cancel',
    })

    const emittedEvents = [
      ...socket.emit.mock.calls.map((call: any[]) => call[0]),
      ...roomEmit.mock.calls.map((call: any[]) => call[0]),
    ]
    expect(emittedEvents).not.toContain('credential.replay')
    expect(emittedEvents).not.toContain('auth.required')
  })
})
