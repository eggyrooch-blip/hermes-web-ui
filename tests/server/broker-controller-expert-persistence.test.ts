import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('BrokerRunController expert metadata persistence', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')

    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
    }))
    vi.doMock('../../packages/server/src/db/hermes/sessions-db', () => ({
      listSessionSummaries: vi.fn().mockResolvedValue([]),
      getSessionDetailFromDb: vi.fn().mockResolvedValue(null),
      getSessionDetailFromDbWithProfile: vi.fn().mockResolvedValue(null),
      getSessionDetailPaginatedFromDbWithProfile: vi.fn().mockResolvedValue(null),
    }))
    vi.doMock('../../packages/server/src/db/hermes/compression-snapshot', () => ({
      getCompressionSnapshot: vi.fn(() => null),
    }))
    vi.doMock('../../packages/server/src/db/hermes/usage-store', () => ({
      updateUsage: vi.fn(),
      deleteUsage: vi.fn(),
      getUsage: vi.fn(),
      getUsageBatch: vi.fn(),
      getLocalUsageStats: vi.fn(),
    }))
    vi.doMock('../../packages/server/src/lib/context-compressor', () => ({
      ChatContextCompressor: vi.fn(),
      DEFAULT_COMPRESSION_CONFIG: {},
      SUMMARY_PREFIX: '[Previous context summary]',
      countTokens: vi.fn((value: string) => String(value || '').length),
    }))
    vi.doMock('../../packages/server/src/lib/context-compressor/export-compressor', () => ({
      ExportCompressor: class {
        async compress(messages: any[]) {
          return {
            messages,
            meta: { totalMessages: messages.length, compressed: true, llmCompressed: true, summaryTokenEstimate: 100, verbatimCount: 0, compressedStartIndex: -1 },
          }
        }
      },
    }))
    vi.doMock('../../packages/server/src/lib/llm-prompt', () => ({
      getSystemPrompt: vi.fn(() => 'system prompt'),
    }))
    vi.doMock('../../packages/server/src/services/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }))
    vi.doMock('../../packages/server/src/config', () => ({
      config: {
        appHome: '/tmp/hermes-web-ui-test',
        authMode: 'token',
        uploadDir: '/tmp/uploads',
        webuiRunBroker: true,
      },
    }))
    vi.doMock('../../packages/server/src/services/feishu-oauth', () => ({
      extractFeishuSessionFromCookieHeader: vi.fn(),
      getFeishuSessionSecret: vi.fn(() => 'secret'),
      parseFeishuSessionCookie: vi.fn(),
    }))
    vi.doMock('../../packages/server/src/services/hermes/hermes-profile', () => ({
      getActiveProfileName: vi.fn(() => 'default'),
      getProfileDir: vi.fn(() => '/tmp/hermes-profile'),
      listProfileNamesFromDisk: vi.fn(() => ['default']),
    }))
    vi.doMock('../../packages/server/src/services/hermes/agent-ownership', () => ({
      ownerOwnsProfile: vi.fn(() => false),
      resolveOwnedProfileAgentId: vi.fn(),
    }))
    vi.doMock('../../packages/server/src/services/compat-user', () => ({
      ensureWebUserForFeishu: vi.fn(() => ({ id: 1 })),
    }))
    vi.doMock('../../packages/server/src/middleware/user-auth', () => ({
      authenticateUserToken: vi.fn(),
      isAuthEnabled: vi.fn(async () => false),
    }))
    vi.doMock('../../packages/server/src/db/hermes/users-store', () => ({
      listUserProfiles: vi.fn(() => []),
      userCanAccessProfile: vi.fn(() => true),
    }))
    vi.doMock('../../packages/server/src/services/hermes/run-chat/handle-broker-run', () => ({
      handleBrokerRun: vi.fn(async () => undefined),
      parseBrokerSessionCommand: vi.fn(() => null),
      respondToBrokerClarify: vi.fn(),
      runBrokerGoalEvaluate: vi.fn(),
      runBrokerSessionCommand: vi.fn(),
    }))
    vi.doMock('../../packages/server/src/services/hermes/model-context', () => ({
      getModelContextLength: vi.fn(() => 200000),
    }))
    vi.doMock('../../packages/server/src/routes/hermes/group-chat', () => ({
      getGroupChatServer: vi.fn(() => null),
    }))
    vi.doMock('../../packages/server/src/services/config-helpers', () => ({
      readConfigYamlForProfile: vi.fn().mockResolvedValue({}),
    }))
    vi.doMock('../../packages/server/src/services/request-context', () => ({
      getRequestProfile: vi.fn(() => 'research'),
      isChatPlaneRequest: vi.fn(() => false),
    }))
    vi.doMock('../../packages/server/src/services/agent-runner/coding-agent-run-manager', () => ({
      codingAgentRunManager: { stop: vi.fn() },
    }))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.resetModules()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  async function initTestDb() {
    const { initAllStores } = await import('../../packages/server/src/db/hermes/init')
    initAllStores()
  }

  it('persists expert metadata from a socket run and returns it through list and paginated detail APIs', async () => {
    await initTestDb()
    const expertAvatar = '/api/hermes/plugin-assets/keep-resource-delivery/expert.png'
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    ;(controller as any).nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const socket = {
      connected: true,
      data: {},
      emit: vi.fn(),
      join: vi.fn(),
    }

    await (controller as any).handleRun(socket, {
      input: '启动资源投放',
      session_id: 'expert-run-session',
      source: 'cli',
      model: 'custom:litellm-sre/tencent-',
      provider: 'custom',
      expert_id: 'keep-resource-delivery',
      expert_label: '资源投放专家',
      expert_avatar: expertAvatar,
    }, 'research')

    const sessionsController = await import('../../packages/server/src/controllers/hermes/sessions')
    const listCtx: any = { query: {}, state: {}, body: null }
    await sessionsController.listConversations(listCtx)
    expect(listCtx.body.sessions[0]).toMatchObject({
      id: 'expert-run-session',
      expert_id: 'keep-resource-delivery',
      expert_label: '资源投放专家',
      expert_avatar: expertAvatar,
    })

    const detailCtx: any = { params: { id: 'expert-run-session' }, query: {}, state: {}, body: null }
    await sessionsController.getConversationMessagesPaginated(detailCtx)
    expect(detailCtx.body.session).toMatchObject({
      id: 'expert-run-session',
      expert_id: 'keep-resource-delivery',
      expert_label: '资源投放专家',
      expert_avatar: expertAvatar,
    })
  })
})
