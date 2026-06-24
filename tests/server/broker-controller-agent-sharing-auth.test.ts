import { beforeEach, describe, expect, it, vi } from 'vitest'

const feishuAuthMocks = vi.hoisted(() => ({
  extractFeishuSessionFromCookieHeader: vi.fn(() => 'session-cookie'),
  getFeishuSessionSecret: vi.fn(() => 'secret'),
  parseFeishuSessionCookie: vi.fn(),
}))
const ownershipMocks = vi.hoisted(() => ({
  ownerOwnsProfile: vi.fn(),
  resolveOwnedProfileAgentId: vi.fn(),
}))

vi.mock('../../packages/server/src/config', () => ({
  config: {
    authMode: 'feishu-oauth-dev',
    runBrokerUrl: 'http://broker.test',
    runBrokerKey: 'broker-key',
    uploadDir: '/tmp/uploads',
    webuiRunBroker: true,
  },
}))

vi.mock('../../packages/server/src/services/feishu-oauth', () => feishuAuthMocks)
vi.mock('../../packages/server/src/services/hermes/agent-ownership', () => ownershipMocks)
vi.mock('../../packages/server/src/services/compat-user', () => ({
  ensureWebUserForFeishu: vi.fn(() => ({ id: 41 })),
}))
vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  authenticateUserToken: vi.fn(),
  isAuthEnabled: vi.fn(async () => false),
}))
vi.mock('../../packages/server/src/db/hermes/users-store', () => ({
  userCanAccessProfile: vi.fn(() => false),
}))
vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSession: vi.fn(),
  getSessionDetail: vi.fn(),
  createSession: vi.fn(),
  addMessage: vi.fn(),
  updateSessionStats: vi.fn(),
}))
vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  getSessionDetailFromDb: vi.fn(),
  getSessionDetailFromDbWithProfile: vi.fn(),
}))
vi.mock('../../packages/server/src/db/hermes/compression-snapshot', () => ({
  getCompressionSnapshot: vi.fn(),
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
vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: vi.fn(() => '/tmp/hermes-profile'),
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

function socketFor(query: Record<string, string>) {
  return {
    data: {},
    handshake: {
      headers: { cookie: 'sid=session-cookie' },
      query,
      auth: {},
    },
  } as any
}

describe('BrokerRunController shared-agent socket auth', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    feishuAuthMocks.parseFeishuSessionCookie.mockReturnValue({
      openid: 'ou_viewer',
      profile: 'viewer_profile',
    })
    ownershipMocks.ownerOwnsProfile.mockReturnValue(false)
    ownershipMocks.resolveOwnedProfileAgentId.mockReturnValue(null)
  })

  it('rejects socket handshakes for agent_id values not shared with the actor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ agents: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    const next = vi.fn()

    await (controller as any).authMiddleware(socketFor({
      profile: 'owned_agent_profile',
      agent_id: 'agent-shared',
    }), next)

    expect(next.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(next.mock.calls[0][0].message).toBe('Agent access denied')
  })

  it('accepts socket handshakes when the broker confirms the shared agent', async () => {
    const fetchMock = vi.fn(async (url: string, options: any) => {
      expect(url).toBe('http://broker.test/api/run-broker/agents/shared')
      expect(options.headers.Authorization).toBe('Bearer broker-key')
      expect(options.headers['X-Hermes-Owner-Open-Id']).toBe('ou_viewer')
      return new Response(JSON.stringify({
        agents: [{
          agent_id: 'agent-shared',
          profile_name: 'owned_agent_profile',
          role: 'viewer',
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    const socket = socketFor({
      profile: 'owned_agent_profile',
      agent_id: 'agent-shared',
    })
    const next = vi.fn()

    await (controller as any).authMiddleware(socket, next)

    expect(next).toHaveBeenCalledWith()
    expect(socket.data.profile).toBe('owned_agent_profile')
    expect(socket.data.agentId).toBe('agent-shared')
  })
})
