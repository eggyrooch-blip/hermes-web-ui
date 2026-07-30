import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A socket authenticated as profile B must not be able to drive profile A's session.
// The fence inside handle-broker-run only stops the broker call; by then the controller
// has already appended B's text to A's transcript, so the fence that matters is the one
// at the controller entry. These cases assert against the real message store.
const parseCommandMock = vi.hoisted(() => vi.fn(() => null as any))

describe('BrokerRunController cross-profile session fence', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    parseCommandMock.mockReturnValue(null as any)
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
    vi.doMock('../../packages/server/src/services/hermes/hermes-profile', () => ({
      getActiveProfileName: vi.fn(() => 'default'),
      getProfileDir: vi.fn(() => '/tmp/hermes-profile'),
      listProfileNamesFromDisk: vi.fn(() => ['user_a', 'user_b']),
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
      parseBrokerSessionCommand: parseCommandMock,
      respondToBrokerClarify: vi.fn(),
      runBrokerGoalEvaluate: vi.fn(),
      runBrokerSessionCommand: vi.fn(async () => ({ ok: true, handled: true, message: 'planned' })),
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
      getRequestProfile: vi.fn(() => 'user_a'),
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

  function fakeSocket() {
    return { connected: true, data: {}, emit: vi.fn(), join: vi.fn(), handshake: { query: {} } } as any
  }

  /** Boots the real controller against the in-memory DB with one session owned by user_a. */
  async function setup() {
    const { initAllStores } = await import('../../packages/server/src/db/hermes/init')
    initAllStores()
    const { createSession } = await import('../../packages/server/src/db/hermes/session-store')
    createSession({ id: 'a-session', profile: 'user_a' })
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController() as any
    controller.nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const brokerRun = await import('../../packages/server/src/services/hermes/run-chat/handle-broker-run')
    return { controller, handleBrokerRun: brokerRun.handleBrokerRun as any }
  }

  const messageCount = () => (db.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE session_id = ?',
  ).get('a-session') as { n: number }).n

  it('rejects a handleRun for another profile session before any transcript write', async () => {
    const { controller, handleBrokerRun } = await setup()
    const socket = fakeSocket()

    await controller.handleRun(socket, {
      input: 'text from the wrong profile',
      session_id: 'a-session',
      queue_id: 'client-1',
    }, 'user_b')

    // The leak this fence exists for: without it B's text lands in A's transcript.
    expect(messageCount()).toBe(0)
    expect(handleBrokerRun).not.toHaveBeenCalled()
    expect(socket.emit).toHaveBeenCalledWith('run.rejected', expect.objectContaining({
      event: 'run.rejected',
      session_id: 'a-session',
      queue_id: 'client-1',
      error: 'Session belongs to a different profile',
    }))
  })

  it('lets the owning profile through and persists its message', async () => {
    const { controller, handleBrokerRun } = await setup()
    const socket = fakeSocket()

    await controller.handleRun(socket, {
      input: 'text from the owner',
      session_id: 'a-session',
      queue_id: 'client-1',
    }, 'user_a')

    expect(socket.emit).not.toHaveBeenCalledWith('run.rejected', expect.anything())
    expect(messageCount()).toBe(1)
    expect(handleBrokerRun).toHaveBeenCalled()
  })

  it('rejects the socket run event before the queue branch can enqueue', async () => {
    const { controller, handleBrokerRun } = await setup()
    const socket = fakeSocket()
    socket.data.profile = 'user_b'
    const handlers = new Map<string, (data: any) => unknown>()
    socket.on = (event: string, handler: (data: any) => unknown) => { handlers.set(event, handler) }
    controller.onConnection(socket)

    // Make the attacker's own scoped state look busy, so an unfenced run would take
    // the queue branch (run.queued) rather than the handleRun branch.
    const state = controller.getOrCreateSession('a-session', 'user_b')
    state.isWorking = true

    await handlers.get('run')!({ input: 'queued text', session_id: 'a-session', queue_id: 'client-1' })

    expect(socket.emit).toHaveBeenCalledWith('run.rejected', expect.objectContaining({
      event: 'run.rejected',
      session_id: 'a-session',
      error: 'Session belongs to a different profile',
    }))
    expect(state.queue).toHaveLength(0)
    expect(messageCount()).toBe(0)
    expect(handleBrokerRun).not.toHaveBeenCalled()
  })

  // /plan and /goal persist a command message without going through handleRun, and the
  // queue drain calls handleBrokerSessionCommand directly - so the socket entry fence
  // does not cover a queued command whose row was created by someone else meanwhile.
  it('rejects a session command for another profile session before it persists', async () => {
    const { controller } = await setup()
    const socket = fakeSocket()
    parseCommandMock.mockReturnValue({ name: 'plan', raw: '/plan ship it' } as any)

    const handled = await controller.handleBrokerSessionCommand(socket, {
      input: '/plan ship it',
      session_id: 'a-session',
      queue_id: 'client-1',
    }, 'user_b')

    expect(messageCount()).toBe(0)
    expect(handled).toBe(true)
    expect(socket.emit).toHaveBeenCalledWith('run.rejected', expect.objectContaining({
      event: 'run.rejected',
      session_id: 'a-session',
      error: 'Session belongs to a different profile',
    }))
  })

  it('lets the owning profile run a session command', async () => {
    const { controller } = await setup()
    const socket = fakeSocket()
    parseCommandMock.mockReturnValue({ name: 'plan', raw: '/plan ship it' } as any)

    await controller.handleBrokerSessionCommand(socket, {
      input: '/plan ship it',
      session_id: 'a-session',
      queue_id: 'client-1',
    }, 'user_a')

    expect(socket.emit).not.toHaveBeenCalledWith('run.rejected', expect.anything())
    expect(messageCount()).toBeGreaterThan(0)
  })
})

// The chat header sends model AND provider on a session's first turn. If creation drops
// the provider, every later turn falls back to a model with no provider - the exact
// mismatch the pair fallback exists to prevent. The row -> metadata half of this chain
// is covered by tests/server/run-chat-broker-session-model.test.ts.
describe('BrokerRunController first-turn model/provider pairing', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    parseCommandMock.mockReturnValue(null as any)
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
    }))
    vi.doMock('../../packages/server/src/services/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }))
    vi.doMock('../../packages/server/src/config', () => ({
      config: { appHome: '/tmp/hermes-web-ui-test', authMode: 'token', uploadDir: '/tmp/uploads', webuiRunBroker: true },
    }))
    vi.doMock('../../packages/server/src/services/hermes/run-chat/handle-broker-run', () => ({
      handleBrokerRun: vi.fn(async () => undefined),
      parseBrokerSessionCommand: parseCommandMock,
      respondToBrokerClarify: vi.fn(),
      runBrokerGoalEvaluate: vi.fn(),
      runBrokerSessionCommand: vi.fn(),
    }))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('persists model and provider together when the first turn creates the session', async () => {
    const { initAllStores } = await import('../../packages/server/src/db/hermes/init')
    initAllStores()
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController() as any
    controller.nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }

    await controller.handleRun(
      { connected: true, data: {}, emit: vi.fn(), join: vi.fn() } as any,
      { input: 'first turn', session_id: 'new-session', model: 'chosen-model', provider: 'chosen-provider' },
      'user_a',
    )

    const { getSession } = await import('../../packages/server/src/db/hermes/session-store')
    expect(getSession('new-session')).toMatchObject({
      model: 'chosen-model',
      provider: 'chosen-provider',
    })
  })
})
