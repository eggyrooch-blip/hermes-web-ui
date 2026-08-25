import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('BrokerRunController expert metadata persistence', () => {
  let db: any = null
  let fetchExpertCatalogMock: ReturnType<typeof vi.fn>
  let handleBrokerRunMock: ReturnType<typeof vi.fn>
  let parseBrokerSessionCommandMock: ReturnType<typeof vi.fn>
  let runBrokerSessionCommandMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    handleBrokerRunMock = vi.fn(async () => undefined)
    parseBrokerSessionCommandMock = vi.fn(() => null)
    runBrokerSessionCommandMock = vi.fn(async () => ({ handled: true, command: 'plan', action: 'status' }))
    fetchExpertCatalogMock = vi.fn(async ({ profileName }: { profileName: string }) => ({
      profile_name: profileName,
      experts: [{
        id: 'keep-resource-delivery',
        name: '资源投放专家',
        title: '资源投放专家',
        avatar: '/api/hermes/plugin-assets/keep-resource-delivery/expert.png',
      }],
    }))
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
      handleBrokerRun: handleBrokerRunMock,
      parseBrokerSessionCommand: parseBrokerSessionCommandMock,
      respondToBrokerClarify: vi.fn(),
      runBrokerGoalEvaluate: vi.fn(),
      runBrokerSessionCommand: runBrokerSessionCommandMock,
    }))
    vi.doMock('../../packages/server/src/services/hermes/expert-registry-client', () => ({
      fetchExpertCatalog: fetchExpertCatalogMock,
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

  it('persists only authoritative expert metadata and returns it through list and paginated detail APIs', async () => {
    await initTestDb()
    const expertAvatar = '/api/hermes/plugin-assets/keep-resource-delivery/expert.png'
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    ;(controller as any).nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const socket = {
      connected: true,
      data: { user: { openid: 'principal-a' } },
      emit: vi.fn(),
      join: vi.fn(),
    }

    await (controller as any).handleRun(socket, {
      input: '启动资源投放',
      session_id: 'expert-run-session',
      queue_id: 'client-prompt-1',
      source: 'cli',
      model: 'custom:litellm-sre/tencent-',
      provider: 'custom',
      expert_id: 'keep-resource-delivery',
      expert_label: '客户端伪造名称',
      expert_avatar: '/fake-client-avatar.png',
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
    expect(detailCtx.body.messages).toEqual([
      expect.objectContaining({ role: 'user', client_id: 'client-prompt-1' }),
    ])
    expect(fetchExpertCatalogMock).toHaveBeenCalledWith(expect.objectContaining({
      profileName: 'research',
      userKey: 'principal-a',
    }))
    expect(handleBrokerRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ expert_id: 'keep-resource-delivery' }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
  })

  it('rejects changing a bound expert before writing a message or invoking the broker', async () => {
    await initTestDb()
    const { createSession, updateSession, getSession } = await import('../../packages/server/src/db/hermes/session-store')
    createSession({ id: 'bound-session', profile: 'research', user_id: 'principal-a' })
    updateSession('bound-session', {
      expert_id: 'keep-resource-delivery',
      expert_label: '资源投放专家',
      expert_avatar: '/trusted.png',
    })
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    ;(controller as any).nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const socket = { connected: true, data: { user: { openid: 'principal-a' } }, emit: vi.fn(), join: vi.fn() }

    await (controller as any).handleRun(socket, {
      input: '换一个员工处理',
      session_id: 'bound-session',
      queue_id: 'client-prompt-2',
      source: 'cli',
      expert_id: 'another-expert',
    }, 'research')

    expect(socket.emit).toHaveBeenCalledWith('run.rejected', expect.objectContaining({
      session_id: 'bound-session',
    }))
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get('bound-session')).toEqual({ count: 0 })
    expect(getSession('bound-session')).toMatchObject({
      expert_id: 'keep-resource-delivery',
      expert_label: '资源投放专家',
      expert_avatar: '/trusted.png',
    })
    expect(fetchExpertCatalogMock).not.toHaveBeenCalled()
    expect(handleBrokerRunMock).not.toHaveBeenCalled()
  })

  it('fails closed before creating a session when the authoritative catalog is unavailable', async () => {
    await initTestDb()
    fetchExpertCatalogMock.mockRejectedValueOnce(new Error('catalog unavailable'))
    const { getSession } = await import('../../packages/server/src/db/hermes/session-store')
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    ;(controller as any).nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const socket = { connected: true, data: { user: { openid: 'principal-a' } }, emit: vi.fn(), join: vi.fn() }

    await (controller as any).handleRun(socket, {
      input: '启动资源投放',
      session_id: 'unavailable-session',
      queue_id: 'client-prompt-3',
      source: 'cli',
      expert_id: 'keep-resource-delivery',
    }, 'research')

    expect(socket.emit).toHaveBeenCalledWith('run.rejected', expect.objectContaining({
      session_id: 'unavailable-session',
      error: expect.stringContaining('catalog unavailable'),
    }))
    expect(getSession('unavailable-session')).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get('unavailable-session')).toEqual({ count: 0 })
    expect(handleBrokerRunMock).not.toHaveBeenCalled()
  })

  it('fails closed when the authoritative catalog omits its profile binding', async () => {
    await initTestDb()
    fetchExpertCatalogMock.mockResolvedValueOnce({
      experts: [{ id: 'keep-resource-delivery', name: '资源投放专家' }],
    })
    const { getSession } = await import('../../packages/server/src/db/hermes/session-store')
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    ;(controller as any).nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const socket = { connected: true, data: { user: { openid: 'principal-a' } }, emit: vi.fn(), join: vi.fn() }

    await (controller as any).handleRun(socket, {
      input: '启动资源投放', session_id: 'missing-profile-session', source: 'cli', expert_id: 'keep-resource-delivery',
    }, 'research')

    expect(getSession('missing-profile-session')).toBeNull()
    expect(handleBrokerRunMock).not.toHaveBeenCalled()
    expect(socket.emit).toHaveBeenCalledWith('run.rejected', expect.objectContaining({ error: 'Expert catalog profile mismatch' }))
  })

  it('keeps two principals isolated and rejects principal B before touching principal A session', async () => {
    await initTestDb()
    const { getSession } = await import('../../packages/server/src/db/hermes/session-store')
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    ;(controller as any).nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const principalA = { connected: true, data: { user: { openid: 'principal-a' } }, emit: vi.fn(), join: vi.fn() }
    const principalB = { connected: true, data: { user: { openid: 'principal-b' } }, emit: vi.fn(), join: vi.fn() }

    await (controller as any).handleRun(principalA, {
      input: 'A starts X', session_id: 'principal-a-session', source: 'cli', expert_id: 'keep-resource-delivery',
    }, 'research')
    await (controller as any).handleRun(principalB, {
      input: 'B starts X', session_id: 'principal-b-session', source: 'cli', expert_id: 'keep-resource-delivery',
    }, 'research')
    handleBrokerRunMock.mockClear()
    fetchExpertCatalogMock.mockClear()

    await (controller as any).handleRun(principalB, {
      input: 'B attacks A', session_id: 'principal-a-session', source: 'cli', expert_id: 'keep-resource-delivery',
    }, 'research')

    expect(getSession('principal-a-session')).toMatchObject({ user_id: 'principal-a', expert_id: 'keep-resource-delivery' })
    expect(getSession('principal-b-session')).toMatchObject({ user_id: 'principal-b', expert_id: 'keep-resource-delivery' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get('principal-a-session')).toEqual({ count: 1 })
    expect(principalB.emit).toHaveBeenCalledWith('run.rejected', expect.objectContaining({
      session_id: 'principal-a-session',
      error: 'Session ownership could not be verified',
    }))
    expect(fetchExpertCatalogMock).not.toHaveBeenCalled()
    expect(handleBrokerRunMock).not.toHaveBeenCalled()
  })

  it('rejects principal B before queueing onto principal A active expert session', async () => {
    await initTestDb()
    const { createSession, updateSession } = await import('../../packages/server/src/db/hermes/session-store')
    createSession({ id: 'active-a-session', profile: 'research', user_id: 'principal-a' })
    updateSession('active-a-session', { expert_id: 'keep-resource-delivery', expert_label: '资源投放专家' })

    let releaseActive!: () => void
    handleBrokerRunMock.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseActive = resolve }))
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    ;(controller as any).nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const handlersA = new Map<string, (...args: any[]) => any>()
    const handlersB = new Map<string, (...args: any[]) => any>()
    const principalA = {
      id: 'socket-a', connected: true,
      data: { profile: 'research', user: { openid: 'principal-a' } },
      handshake: { query: { profile: 'research' } }, emit: vi.fn(), join: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => any) => handlersA.set(event, handler)),
    }
    const principalB = {
      id: 'socket-b', connected: true,
      data: { profile: 'research', user: { openid: 'principal-b' } },
      handshake: { query: { profile: 'research' } }, emit: vi.fn(), join: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => any) => handlersB.set(event, handler)),
    }
    ;(controller as any).onConnection(principalA)
    ;(controller as any).onConnection(principalB)

    const active = handlersA.get('run')!({ input: 'A is working', session_id: 'active-a-session', queue_id: 'active-a' })
    await vi.waitFor(() => expect(handleBrokerRunMock).toHaveBeenCalledTimes(1))
    const state = (controller as any).getSessionState('active-a-session', 'research')

    await handlersB.get('run')!({ input: 'B attacks A queue', session_id: 'active-a-session', queue_id: 'attack-b' })

    expect(state.queue).toEqual([])
    expect(principalB.emit).toHaveBeenCalledWith('run.rejected', expect.objectContaining({
      session_id: 'active-a-session',
      queue_id: 'attack-b',
      error: 'Session ownership could not be verified',
    }))
    expect(handleBrokerRunMock).toHaveBeenCalledTimes(1)

    releaseActive()
    await active
  })

  it('uses a bound session expert when the continuation payload omits expert_id', async () => {
    await initTestDb()
    const { createSession, updateSession } = await import('../../packages/server/src/db/hermes/session-store')
    createSession({ id: 'bound-session', profile: 'research', user_id: 'principal-a' })
    updateSession('bound-session', {
      expert_id: 'keep-resource-delivery',
      expert_label: '资源投放专家',
      expert_avatar: '/trusted.png',
    })
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    ;(controller as any).nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const socket = { connected: true, data: { user: { openid: 'principal-a' } }, emit: vi.fn(), join: vi.fn() }

    await (controller as any).handleRun(socket, {
      input: '继续', session_id: 'bound-session', queue_id: 'continuation', source: 'cli',
    }, 'research')

    expect(handleBrokerRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ expert_id: 'keep-resource-delivery' }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
  })

  it('rejects a bound session when the catalog is unavailable before transcript or broker writes', async () => {
    await initTestDb()
    const { createSession, updateSession } = await import('../../packages/server/src/db/hermes/session-store')
    createSession({ id: 'bound-unavailable', profile: 'research', user_id: 'principal-a' })
    updateSession('bound-unavailable', { expert_id: 'keep-resource-delivery', expert_label: '资源投放专家' })
    fetchExpertCatalogMock.mockRejectedValueOnce(new Error('catalog unavailable'))
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    ;(controller as any).nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const socket = { connected: true, data: { user: { openid: 'principal-a' } }, emit: vi.fn(), join: vi.fn() }

    await (controller as any).handleRun(socket, {
      input: '继续', session_id: 'bound-unavailable', queue_id: 'continuation', source: 'cli',
    }, 'research')

    expect(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get('bound-unavailable')).toEqual({ count: 0 })
    expect(handleBrokerRunMock).not.toHaveBeenCalled()
    expect(socket.emit).toHaveBeenCalledWith('run.rejected', expect.objectContaining({ error: 'catalog unavailable' }))
  })

  it('authorizes a session command before persistence and forwards the bound expert', async () => {
    await initTestDb()
    parseBrokerSessionCommandMock.mockReturnValue({ raw: '/plan status', name: 'plan' })
    const { createSession, updateSession } = await import('../../packages/server/src/db/hermes/session-store')
    createSession({ id: 'bound-command', profile: 'research', user_id: 'principal-a' })
    updateSession('bound-command', { expert_id: 'keep-resource-delivery', expert_label: '资源投放专家' })
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    ;(controller as any).nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const socket = { connected: true, data: { user: { openid: 'principal-a' } }, emit: vi.fn(), join: vi.fn() }

    await (controller as any).handleBrokerSessionCommand(socket, {
      input: '/plan status', session_id: 'bound-command', queue_id: 'command-1', source: 'cli',
    }, 'research')

    expect(runBrokerSessionCommandMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'bound-command',
      expertId: 'keep-resource-delivery',
    }))
  })

  it('rejects a session command when expert authorization is unavailable before persistence or dispatch', async () => {
    await initTestDb()
    parseBrokerSessionCommandMock.mockReturnValue({ raw: '/plan status', name: 'plan' })
    const { createSession, updateSession } = await import('../../packages/server/src/db/hermes/session-store')
    createSession({ id: 'bound-command', profile: 'research', user_id: 'principal-a' })
    updateSession('bound-command', { expert_id: 'keep-resource-delivery', expert_label: '资源投放专家' })
    fetchExpertCatalogMock.mockRejectedValueOnce(new Error('catalog unavailable'))
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    ;(controller as any).nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const socket = { connected: true, data: { user: { openid: 'principal-a' } }, emit: vi.fn(), join: vi.fn() }

    await (controller as any).handleBrokerSessionCommand(socket, {
      input: '/plan status', session_id: 'bound-command', queue_id: 'command-1', source: 'cli',
    }, 'research')

    expect(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get('bound-command')).toEqual({ count: 0 })
    expect(runBrokerSessionCommandMock).not.toHaveBeenCalled()
    expect(socket.emit).toHaveBeenCalledWith('run.rejected', expect.objectContaining({ error: 'catalog unavailable' }))
  })

  it('persists the broker response run id when flushing messages', async () => {
    await initTestDb()
    const { createSession } = await import('../../packages/server/src/db/hermes/session-store')
    createSession({ id: 'run-id-session', profile: 'research' })
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    const state = {
      messages: [{
        id: 1,
        session_id: 'run-id-session',
        runMarker: 'marker-1',
        role: 'assistant',
        content: 'answer',
        timestamp: 100,
      }],
      isWorking: false,
      events: [],
      queue: [],
      profile: 'research',
      responseRun: {
        runMarker: 'marker-1',
        responseId: 'run-broker-1',
        insertedKeys: new Set<string>(),
        toolCalls: new Map(),
      },
    }

    ;(controller as any).flushResponseRunToDb(state, 'run-id-session')

    const row = db.prepare('SELECT run_id FROM messages WHERE session_id = ? AND role = ?')
      .get('run-id-session', 'assistant') as { run_id: string }
    expect(row.run_id).toBe('run-broker-1')
  })

  it('rejects principal B across resume and every control-event family on principal A session', async () => {
    await initTestDb()
    const { createSession, updateSession } = await import('../../packages/server/src/db/hermes/session-store')
    createSession({ id: 'control-a-session', profile: 'research', user_id: 'principal-a' })
    updateSession('control-a-session', { expert_id: 'keep-resource-delivery', expert_label: '资源投放专家' })
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    ;(controller as any).nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const handlersB = new Map<string, (...args: any[]) => any>()
    const principalB = {
      id: 'socket-b', connected: true,
      data: { profile: 'research', user: { openid: 'principal-b' } },
      handshake: { query: { profile: 'research' } }, emit: vi.fn(), join: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => any) => handlersB.set(event, handler)),
    }
    ;(controller as any).onConnection(principalB)

    await handlersB.get('resume')!({ session_id: 'control-a-session' })
    handlersB.get('cancel_queued_run')!({ session_id: 'control-a-session', queue_id: 'q1' })
    handlersB.get('resume.events.ack')!({ session_id: 'control-a-session', event_ids: ['e1'] })
    handlersB.get('abort')!({ session_id: 'control-a-session' })
    await handlersB.get('clarify.respond')!({ session_id: 'control-a-session', clarify_id: 'c1', response: 'yes' })
    await handlersB.get('credential.replay')!({ session_id: 'control-a-session', run_id: 'r1' })

    // The room join replays the transcript — B must never get there.
    expect(principalB.join).not.toHaveBeenCalled()
    const rejections = principalB.emit.mock.calls.filter(([event]) => event === 'run.rejected')
    expect(rejections.length).toBe(6)
    for (const [, payload] of rejections) {
      expect(payload).toMatchObject({ session_id: 'control-a-session' })
    }
    expect(handleBrokerRunMock).not.toHaveBeenCalled()
  })

  it('queues a second concurrent submit while catalog resolution is still awaited', async () => {
    await initTestDb()
    let releaseCatalog!: (value: any) => void
    fetchExpertCatalogMock.mockImplementationOnce(() => new Promise((resolve) => { releaseCatalog = resolve }))
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    ;(controller as any).nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const socket = { id: 's', connected: true, data: { user: { openid: 'principal-a' } }, emit: vi.fn(), join: vi.fn() }

    const first = (controller as any).handleRun(socket, {
      input: 'first', session_id: 'concurrent-session', queue_id: 'q-first', source: 'cli', expert_id: 'keep-resource-delivery',
    }, 'research')
    const second = (controller as any).handleRun(socket, {
      input: 'second', session_id: 'concurrent-session', queue_id: 'q-second', source: 'cli', expert_id: 'keep-resource-delivery',
    }, 'research')
    await second

    // The reservation is synchronous: the second submit queued instead of
    // double-entering an idle session and overwriting the run marker.
    const state = (controller as any).getSessionState('concurrent-session', 'research')
    expect(state.queue.map((item: any) => item.queue_id)).toEqual(['q-second'])
    expect(handleBrokerRunMock).not.toHaveBeenCalled()

    releaseCatalog({
      profile_name: 'research',
      experts: [{ id: 'keep-resource-delivery', name: '资源投放专家', title: '资源投放专家', avatar: null }],
    })
    await first
    expect(handleBrokerRunMock).toHaveBeenCalled()
  })

  it('rejects the post-await write when the row was recreated for another principal during catalog resolution', async () => {
    await initTestDb()
    const { createSession, getSession } = await import('../../packages/server/src/db/hermes/session-store')
    let releaseCatalog!: (value: any) => void
    fetchExpertCatalogMock.mockImplementationOnce(() => new Promise((resolve) => { releaseCatalog = resolve }))
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    ;(controller as any).nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const socket = { id: 's', connected: true, data: { user: { openid: 'principal-a' } }, emit: vi.fn(), join: vi.fn() }

    const run = (controller as any).handleRun(socket, {
      input: 'A creates', session_id: 'raced-session', queue_id: 'q-a', source: 'cli', expert_id: 'keep-resource-delivery',
    }, 'research')
    // While A's catalog fetch is in flight, the row appears owned by B.
    createSession({ id: 'raced-session', profile: 'research', user_id: 'principal-b' })
    releaseCatalog({
      profile_name: 'research',
      experts: [{ id: 'keep-resource-delivery', name: '资源投放专家', title: '资源投放专家', avatar: null }],
    })
    await run

    expect(socket.emit).toHaveBeenCalledWith('run.rejected', expect.objectContaining({ session_id: 'raced-session' }))
    expect(handleBrokerRunMock).not.toHaveBeenCalled()
    expect(getSession('raced-session')).toMatchObject({ user_id: 'principal-b' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get('raced-session')).toEqual({ count: 0 })
    const state = (controller as any).getSessionState('raced-session', 'research')
    expect(state?.isWorking ?? false).toBe(false)
  })

  it('rejects control events for a session row that does not exist yet', async () => {
    await initTestDb()
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    ;(controller as any).nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const handlersB = new Map<string, (...args: any[]) => any>()
    const principalB = {
      id: 'socket-b', connected: true,
      data: { profile: 'research', user: { openid: 'principal-b' } },
      handshake: { query: { profile: 'research' } }, emit: vi.fn(), join: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => any) => handlersB.set(event, handler)),
    }
    ;(controller as any).onConnection(principalB)

    // No row for this id: every control family must reject instead of joining
    // the rowless in-memory session of someone else's first-turn window.
    await handlersB.get('resume')!({ session_id: 'rowless-session' })
    handlersB.get('cancel_queued_run')!({ session_id: 'rowless-session', queue_id: 'q1' })
    handlersB.get('resume.events.ack')!({ session_id: 'rowless-session', event_ids: ['e1'] })
    handlersB.get('abort')!({ session_id: 'rowless-session' })
    await handlersB.get('clarify.respond')!({ session_id: 'rowless-session', clarify_id: 'c1', response: 'yes' })
    await handlersB.get('credential.replay')!({ session_id: 'rowless-session', run_id: 'r1' })

    expect(principalB.join).not.toHaveBeenCalled()
    const rejections = principalB.emit.mock.calls.filter(([event]) => event === 'run.rejected')
    expect(rejections.length).toBe(6)
  })

  it('discards a foreign principal queued item at dequeue instead of executing it as the owner', async () => {
    await initTestDb()
    let releaseCatalog!: (value: any) => void
    fetchExpertCatalogMock.mockImplementationOnce(() => new Promise((resolve) => { releaseCatalog = resolve }))
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    ;(controller as any).nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const socketA = { id: 'sa', connected: true, data: { user: { openid: 'principal-a' } }, emit: vi.fn(), join: vi.fn() }
    const socketB = { id: 'sb', connected: true, data: { user: { openid: 'principal-b' } }, emit: vi.fn(), join: vi.fn() }

    // A starts the first turn on a rowless session; catalog fetch is in flight.
    const first = (controller as any).handleRun(socketA, {
      input: 'A first turn', session_id: 'ab-queue-session', queue_id: 'q-a', source: 'cli', expert_id: 'keep-resource-delivery',
    }, 'research')
    // B races the same rowless id: the run fence admits unknown ids, so B's
    // input lands in the queue — recorded with B's principal.
    await (controller as any).handleRun(socketB, {
      input: 'B smuggled input', session_id: 'ab-queue-session', queue_id: 'q-b', source: 'cli', expert_id: 'keep-resource-delivery',
    }, 'research')
    const state = (controller as any).getSessionState('ab-queue-session', 'research')
    expect(state.queue.map((item: any) => item.queue_id)).toEqual(['q-b'])
    expect(state.queue[0].principal).toBe('principal-b')

    releaseCatalog({
      profile_name: 'research',
      experts: [{ id: 'keep-resource-delivery', name: '资源投放专家', title: '资源投放专家', avatar: null }],
    })
    await first
    // Simulate A's run completion (the broker mock emits no terminal event),
    // then drive the drain the way completion does: the dequeue guard is the
    // unit under test.
    state.isWorking = false
    state.activeRunMarker = undefined
    ;(controller as any).dequeueNextQueuedRun(socketA, 'ab-queue-session', 'research')
    expect(state.queue.length).toBe(0)

    // Only A's input ever reached the broker; B's queued item was discarded.
    expect(handleBrokerRunMock).toHaveBeenCalledTimes(1)
    const dispatched = handleBrokerRunMock.mock.calls.map(call => call[1]?.input ?? call[1])
    expect(JSON.stringify(dispatched)).not.toContain('B smuggled input')
  })

  it('rejects the post-await write when the SAME owner deleted and recreated the row during catalog resolution', async () => {
    await initTestDb()
    const { createSession, getSession, updateSession } = await import('../../packages/server/src/db/hermes/session-store')
    createSession({ id: 'same-owner-recreate', profile: 'research', user_id: 'principal-a' })
    updateSession('same-owner-recreate', { expert_id: 'keep-resource-delivery', expert_label: '资源投放专家' })
    let releaseCatalog!: (value: any) => void
    fetchExpertCatalogMock.mockImplementationOnce(() => new Promise((resolve) => { releaseCatalog = resolve }))
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    ;(controller as any).nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const socket = { id: 's', connected: true, data: { user: { openid: 'principal-a' } }, emit: vi.fn(), join: vi.fn() }

    const run = (controller as any).handleRun(socket, {
      input: 'stale write', session_id: 'same-owner-recreate', queue_id: 'q-a', source: 'cli', expert_id: 'keep-resource-delivery',
    }, 'research')
    // Same owner deletes and recreates the row while the catalog is awaited:
    // the owner fence passes, only the generation check can catch this.
    db.prepare('DELETE FROM sessions WHERE id = ?').run('same-owner-recreate')
    createSession({ id: 'same-owner-recreate', profile: 'research', user_id: 'principal-a' })
    releaseCatalog({
      profile_name: 'research',
      experts: [{ id: 'keep-resource-delivery', name: '资源投放专家', title: '资源投放专家', avatar: null }],
    })
    await run

    expect(socket.emit).toHaveBeenCalledWith('run.rejected', expect.objectContaining({
      session_id: 'same-owner-recreate',
      error: 'Session was recreated during authorization',
    }))
    expect(handleBrokerRunMock).not.toHaveBeenCalled()
    expect(getSession('same-owner-recreate')).toMatchObject({ user_id: 'principal-a' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get('same-owner-recreate')).toEqual({ count: 0 })
  })

  it('rejects an expert overlay for global-agent runs and sessions', async () => {
    await initTestDb()
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    ;(controller as any).nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const socket = { id: 's', connected: true, data: { user: { openid: 'principal-a' } }, emit: vi.fn(), join: vi.fn() }

    await (controller as any).handleRun(socket, {
      input: 'crafted', session_id: 'global-agent-session', queue_id: 'q-g', source: 'global_agent', expert_id: 'keep-resource-delivery',
    }, 'research')

    expect(socket.emit).toHaveBeenCalledWith('run.rejected', expect.objectContaining({
      session_id: 'global-agent-session',
      error: 'Expert is not available for this session type',
    }))
    expect(fetchExpertCatalogMock).not.toHaveBeenCalled()
    expect(handleBrokerRunMock).not.toHaveBeenCalled()
  })

  it('caps queued admissions and drains a flooded foreign queue iteratively with zero dispatch', async () => {
    await initTestDb()
    const { createSession, updateSession } = await import('../../packages/server/src/db/hermes/session-store')
    createSession({ id: 'flood-session', profile: 'research', user_id: 'principal-a' })
    updateSession('flood-session', { expert_id: 'keep-resource-delivery', expert_label: '资源投放专家' })
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    ;(controller as any).nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const socketA = { id: 'sa', connected: true, data: { user: { openid: 'principal-a' } }, emit: vi.fn(), join: vi.fn() }
    const socketB = { id: 'sb', connected: true, data: { user: { openid: 'principal-b' } }, emit: vi.fn(), join: vi.fn() }

    // Simulate an in-flight run and flood the queue with foreign items.
    const state = (controller as any).getOrCreateSession('flood-session', 'research')
    state.isWorking = true
    for (let i = 0; i < 500; i += 1) {
      state.queue.push({ queue_id: `forged-${i}`, input: `forged ${i}`, profile: 'research', principal: 'principal-b' })
    }
    // Admission cap: even the owner cannot grow a full queue further.
    await (controller as any).handleRun(socketA, {
      input: 'one more', session_id: 'flood-session', queue_id: 'q-more', source: 'cli',
    }, 'research')
    expect(socketA.emit).toHaveBeenCalledWith('run.rejected', expect.objectContaining({ error: 'Session queue is full' }))

    state.isWorking = false
    state.activeRunMarker = undefined
    const dispatched = (controller as any).dequeueNextQueuedRun(socketA, 'flood-session', 'research')

    // Every forged item was discarded iteratively (no stack failure), nothing dispatched.
    expect(dispatched).toBe(false)
    expect(state.queue.length).toBe(0)
    expect(handleBrokerRunMock).not.toHaveBeenCalled()
  })

  it('rejects a persisted global-agent session carrying a stored expert', async () => {
    await initTestDb()
    const { createSession, updateSession } = await import('../../packages/server/src/db/hermes/session-store')
    createSession({ id: 'ga-persisted', profile: 'research', user_id: 'principal-a', source: 'global_agent' })
    updateSession('ga-persisted', { expert_id: 'keep-resource-delivery' })
    const { BrokerRunController } = await import('../../packages/server/src/services/hermes/broker-controller')
    const controller = new BrokerRunController()
    ;(controller as any).nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }
    const socket = { id: 's', connected: true, data: { user: { openid: 'principal-a' } }, emit: vi.fn(), join: vi.fn() }

    await (controller as any).handleRun(socket, {
      input: 'continue', session_id: 'ga-persisted', queue_id: 'q-ga', source: 'global_agent',
    }, 'research')

    expect(socket.emit).toHaveBeenCalledWith('run.rejected', expect.objectContaining({
      error: 'Expert is not available for this session type',
    }))
    expect(fetchExpertCatalogMock).not.toHaveBeenCalled()
    expect(handleBrokerRunMock).not.toHaveBeenCalled()
  })
})
