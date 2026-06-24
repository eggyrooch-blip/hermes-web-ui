import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionDetailMock = vi.hoisted(() => vi.fn())
const getSessionDetailFromDbMock = vi.hoisted(() => vi.fn())
const getSessionDetailFromDbWithProfileMock = vi.hoisted(() => vi.fn())
const getCompressionSnapshotMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSession: vi.fn(),
  getSessionDetail: getSessionDetailMock,
  createSession: vi.fn(),
  addMessage: vi.fn(),
  updateSessionStats: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  getSessionDetailFromDb: getSessionDetailFromDbMock,
  getSessionDetailFromDbWithProfile: getSessionDetailFromDbWithProfileMock,
}))

vi.mock('../../packages/server/src/db/hermes/compression-snapshot', () => ({
  getCompressionSnapshot: getCompressionSnapshotMock,
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

vi.mock('../../packages/server/src/services/hermes/run-chat/handle-broker-run', () => ({
  handleBrokerRun: vi.fn(),
  parseBrokerSessionCommand: vi.fn(() => null),
  respondToBrokerClarify: vi.fn(),
  runBrokerGoalEvaluate: vi.fn(),
  runBrokerSessionCommand: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/model-context', () => ({
  getModelContextLength: vi.fn(() => 200000),
}))

describe('BrokerRunController local session resume', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getCompressionSnapshotMock.mockReturnValue(null)
    getSessionDetailFromDbMock.mockResolvedValue(null)
    getSessionDetailFromDbWithProfileMock.mockResolvedValue(null)
    getSessionDetailMock.mockReturnValue({
      id: 'local-session',
      profile: 'feishu_g41a5b5g',
      source: 'api_server',
      messages: [
        { id: 1, session_id: 'local-session', role: 'user', content: '历史问题', timestamp: 1 },
        { id: 2, session_id: 'local-session', role: 'assistant', content: '历史回答', timestamp: 2 },
      ],
    })
  })

  it('hydrates resume state from WebUI local store before falling back to profile state.db', async () => {
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()

    const state = await (controller as any).loadSessionStateFromDb('local-session', 'feishu_g41a5b5g')

    expect(getSessionDetailMock).toHaveBeenCalledWith('local-session')
    expect(getSessionDetailFromDbMock).not.toHaveBeenCalled()
    expect(getSessionDetailFromDbWithProfileMock).not.toHaveBeenCalled()
    expect(state.messages).toMatchObject([
      { role: 'user', content: '历史问题' },
      { role: 'assistant', content: '历史回答' },
    ])
    expect(state.inputTokens).toBeGreaterThan(0)
    expect(state.outputTokens).toBeGreaterThan(0)
  })

  it('does not hydrate a local-store session that belongs to a different profile', async () => {
    getSessionDetailFromDbWithProfileMock.mockResolvedValue({
      id: 'local-session',
      profile: 'other_profile',
      source: 'cli',
      messages: [
        { id: 3, session_id: 'local-session', role: 'user', content: 'profile scoped question', timestamp: 3 },
      ],
    })
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()

    const state = await (controller as any).loadSessionStateFromDb('local-session', 'other_profile')

    expect(getSessionDetailMock).toHaveBeenCalledWith('local-session')
    expect(getSessionDetailFromDbWithProfileMock).toHaveBeenCalledWith('local-session', 'other_profile')
    expect(state.messages).toMatchObject([
      { role: 'user', content: 'profile scoped question' },
    ])
    expect(state.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: '历史问题' }),
    ]))
  })

  it('falls back to profile state.db when the matching local-store row is not api_server', async () => {
    getSessionDetailMock.mockReturnValue({
      id: 'local-session',
      profile: 'feishu_g41a5b5g',
      source: 'cli',
      messages: [
        { id: 4, session_id: 'local-session', role: 'user', content: 'stale local cli copy', timestamp: 4 },
      ],
    })
    getSessionDetailFromDbWithProfileMock.mockResolvedValue({
      id: 'local-session',
      profile: 'feishu_g41a5b5g',
      source: 'cli',
      messages: [
        { id: 5, session_id: 'local-session', role: 'user', content: 'profile state db question', timestamp: 5 },
      ],
    })
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()

    const state = await (controller as any).loadSessionStateFromDb('local-session', 'feishu_g41a5b5g')

    expect(getSessionDetailMock).toHaveBeenCalledWith('local-session')
    expect(getSessionDetailFromDbWithProfileMock).toHaveBeenCalledWith('local-session', 'feishu_g41a5b5g')
    expect(state.messages).toMatchObject([
      { role: 'user', content: 'profile state db question' },
    ])
    expect(state.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'stale local cli copy' }),
    ]))
  })

  it('keeps resumed session cache scoped by profile for the same session id', async () => {
    getSessionDetailFromDbWithProfileMock.mockResolvedValue({
      id: 'local-session',
      profile: 'other_profile',
      source: 'cli',
      messages: [
        { id: 3, session_id: 'local-session', role: 'user', content: 'profile scoped question', timestamp: 3 },
      ],
    })
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    const otherSocket = { id: 'socket-other', emit: vi.fn() }
    const localSocket = { id: 'socket-local', emit: vi.fn() }

    await (controller as any).resumeSession(otherSocket, 'local-session', 'other_profile')
    await (controller as any).resumeSession(localSocket, 'local-session', 'feishu_g41a5b5g')

    const otherPayload = otherSocket.emit.mock.calls.find(call => call[0] === 'resumed')?.[1]
    const localPayload = localSocket.emit.mock.calls.find(call => call[0] === 'resumed')?.[1]
    expect(otherPayload?.messages).toMatchObject([
      { role: 'user', content: 'profile scoped question' },
    ])
    expect(localPayload?.messages).toMatchObject([
      { role: 'user', content: '历史问题' },
      { role: 'assistant', content: '历史回答' },
    ])
    expect(localPayload?.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'profile scoped question' }),
    ]))
  })

  it('calculates usage from the matching WebUI local-store session after a broker follow-up', async () => {
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    const emit = vi.fn()
    const state = {
      messages: [],
      isWorking: false,
      events: [],
      queue: [],
      profile: 'feishu_g41a5b5g',
    }

    const usage = await (controller as any).calcAndUpdateUsage('local-session', state, emit)

    expect(getSessionDetailMock).toHaveBeenCalledWith('local-session')
    expect(getSessionDetailFromDbMock).not.toHaveBeenCalled()
    expect(getSessionDetailFromDbWithProfileMock).not.toHaveBeenCalled()
    expect(usage.inputTokens).toBeGreaterThan(0)
    expect(usage.outputTokens).toBeGreaterThan(0)
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({
      session_id: 'local-session',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    }))
  })
})
