import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const listConversationSummariesFromDbMock = vi.fn()
const getConversationDetailFromDbMock = vi.fn()
const listConversationSummariesMock = vi.fn()
const getConversationDetailMock = vi.fn()
const listSessionSummariesMock = vi.fn()
const getSessionDetailFromDbMock = vi.fn()
const getSessionDetailFromDbWithProfileMock = vi.fn()
const getSessionDetailPaginatedFromDbWithProfileMock = vi.fn()
const getExactSessionDetailFromDbWithProfileMock = vi.fn()
const getUsageStatsFromDbMock = vi.fn()
const getSessionMock = vi.fn()
const deleteHermesSessionForProfileMock = vi.fn()
const localListSessionsMock = vi.fn()
const localListSessionsByAgentMock = vi.fn()
const localGetSessionDetailMock = vi.fn()
const localGetSessionDetailPaginatedMock = vi.fn()
const localSearchSessionsMock = vi.fn()
const localSearchSessionsByAgentMock = vi.fn()
const localDeleteSessionMock = vi.fn()
const localRenameSessionMock = vi.fn()
const localSetSessionArchivedMock = vi.fn()
const localCreateSessionMock = vi.fn()
const localUpdateSessionMock = vi.fn()
const localAddMessagesMock = vi.fn()
const localUpdateSessionStatsMock = vi.fn()
const listWorkspaceRunChangesForSessionMock = vi.fn()
const getWorkspaceRunChangeMock = vi.fn()
const getWorkspaceRunChangeFileMock = vi.fn()
const getGroupChatServerMock = vi.fn()
const getLocalUsageStatsMock = vi.fn()
const getActiveProfileNameMock = vi.fn()
const loggerWarnMock = vi.fn()
const getCompressionSnapshotMock = vi.fn()
const listUserProfilesMock = vi.fn()
const readConfigYamlForProfileMock = vi.fn()
const getRequestProfileMock = vi.fn()
const isChatPlaneRequestMock = vi.fn()
const bridgeSwitchSessionModelMock = vi.fn()
const bridgeGetRuntimeStateMock = vi.fn()
const codingAgentRunManagerMock = vi.hoisted(() => ({
  stop: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/conversations-db', () => ({
  listConversationSummariesFromDb: listConversationSummariesFromDbMock,
  getConversationDetailFromDb: getConversationDetailFromDbMock,
}))

vi.mock('../../packages/server/src/services/hermes/conversations', () => ({
  listConversationSummaries: listConversationSummariesMock,
  getConversationDetail: getConversationDetailMock,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: {
    warn: loggerWarnMock,
    error: vi.fn(),
  },
}))

vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  listSessions: vi.fn(),
  getSession: getSessionMock,
  deleteSession: vi.fn(),
  deleteSessionForProfile: deleteHermesSessionForProfileMock,
  renameSession: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  listSessionSummaries: listSessionSummariesMock,
  searchSessionSummaries: vi.fn(),
  getSessionDetailFromDb: getSessionDetailFromDbMock,
  getSessionDetailFromDbWithProfile: getSessionDetailFromDbWithProfileMock,
  getSessionDetailPaginatedFromDbWithProfile: getSessionDetailPaginatedFromDbWithProfileMock,
  getExactSessionDetailFromDbWithProfile: getExactSessionDetailFromDbWithProfileMock,
  getUsageStatsFromDb: getUsageStatsFromDbMock,
}))

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  listSessions: localListSessionsMock,
  listSessionsByAgent: localListSessionsByAgentMock,
  searchSessions: localSearchSessionsMock,
  searchSessionsByAgent: localSearchSessionsByAgentMock,
  getSessionDetail: localGetSessionDetailMock,
  getSessionDetailPaginated: localGetSessionDetailPaginatedMock,
  deleteSession: localDeleteSessionMock,
  renameSession: localRenameSessionMock,
  setSessionArchived: localSetSessionArchivedMock,
  createSession: localCreateSessionMock,
  addMessages: localAddMessagesMock,
  getSession: getSessionMock,
  updateSession: localUpdateSessionMock,
  updateSessionStats: localUpdateSessionStatsMock,
}))

vi.mock('../../packages/server/src/db/hermes/workspace-run-changes-store', () => ({
  listWorkspaceRunChangesForSession: listWorkspaceRunChangesForSessionMock,
  getWorkspaceRunChange: getWorkspaceRunChangeMock,
  getWorkspaceRunChangeFile: getWorkspaceRunChangeFileMock,
}))

vi.mock('../../packages/server/src/db/hermes/users-store', () => ({
  listUserProfiles: listUserProfilesMock,
}))

vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({
  deleteUsage: vi.fn(),
  getUsage: vi.fn(),
  getUsageBatch: vi.fn(),
  getLocalUsageStats: getLocalUsageStatsMock,
}))

vi.mock('../../packages/server/src/routes/hermes/group-chat', () => ({
  getGroupChatServer: getGroupChatServerMock,
}))

vi.mock('../../packages/server/src/services/hermes/model-context', () => ({
  getModelContextLength: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: getActiveProfileNameMock,
  getProfileDir: (name: string) => `/tmp/hermes-test/${name || 'default'}`,
  listProfileNamesFromDisk: () => ['default', 'travel'],
}))

vi.mock('../../packages/server/src/services/hermes/agent-bridge', () => ({
  AgentBridgeClient: vi.fn().mockImplementation(() => ({
    switchSessionModel: bridgeSwitchSessionModelMock,
  })),
  getAgentBridgeManager: vi.fn(() => ({
    getRuntimeState: bridgeGetRuntimeStateMock,
  })),
}))

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  readConfigYamlForProfile: readConfigYamlForProfileMock,
}))

vi.mock('../../packages/server/src/services/request-context', () => ({
  getRequestProfile: getRequestProfileMock,
  isChatPlaneRequest: isChatPlaneRequestMock,
}))

vi.mock('../../packages/server/src/services/agent-runner/coding-agent-run-manager', () => ({
  codingAgentRunManager: codingAgentRunManagerMock,
}))

vi.mock('../../packages/server/src/db/hermes/compression-snapshot', () => ({
  getCompressionSnapshot: getCompressionSnapshotMock,
}))

vi.mock('../../packages/server/src/lib/context-compressor/export-compressor', () => ({
  ExportCompressor: class {
    async compress(messages: any[]) {
      return {
        messages,
        meta: { totalMessages: messages.length, compressed: true, llmCompressed: true, summaryTokenEstimate: 100, verbatimCount: 0, compressedStartIndex: -1 },
      }
    }
  },
}))

describe('session conversations controller', () => {
  beforeEach(() => {
    vi.resetModules()
    listConversationSummariesFromDbMock.mockReset()
    getConversationDetailFromDbMock.mockReset()
    listConversationSummariesMock.mockReset()
    getConversationDetailMock.mockReset()
    listSessionSummariesMock.mockReset()
    getSessionDetailFromDbMock.mockReset()
    getSessionDetailFromDbWithProfileMock.mockReset()
    getSessionDetailPaginatedFromDbWithProfileMock.mockReset()
    getExactSessionDetailFromDbWithProfileMock.mockReset()
    getUsageStatsFromDbMock.mockReset()
    getSessionMock.mockReset()
    deleteHermesSessionForProfileMock.mockReset()
    localListSessionsMock.mockReset()
    localListSessionsByAgentMock.mockReset()
    localGetSessionDetailMock.mockReset()
    localGetSessionDetailPaginatedMock.mockReset()
    localSearchSessionsMock.mockReset()
    localSearchSessionsByAgentMock.mockReset()
    localDeleteSessionMock.mockReset()
    localRenameSessionMock.mockReset()
    localSetSessionArchivedMock.mockReset()
    localCreateSessionMock.mockReset()
    localUpdateSessionMock.mockReset()
    localAddMessagesMock.mockReset()
    localUpdateSessionStatsMock.mockReset()
    listWorkspaceRunChangesForSessionMock.mockReset()
    getWorkspaceRunChangeMock.mockReset()
    getWorkspaceRunChangeFileMock.mockReset()
    getGroupChatServerMock.mockReset()
    getGroupChatServerMock.mockReturnValue(null)
    getLocalUsageStatsMock.mockReset()
    getActiveProfileNameMock.mockReset()
    getActiveProfileNameMock.mockReturnValue('default')
    loggerWarnMock.mockReset()
    getCompressionSnapshotMock.mockReset()
    listUserProfilesMock.mockReset()
    listUserProfilesMock.mockReturnValue([])
    readConfigYamlForProfileMock.mockReset()
    readConfigYamlForProfileMock.mockResolvedValue({ model: { default: 'gpt-default', provider: 'openai' } })
    getRequestProfileMock.mockReset()
    getRequestProfileMock.mockReturnValue('default')
    isChatPlaneRequestMock.mockReset()
    isChatPlaneRequestMock.mockReturnValue(false)
    bridgeSwitchSessionModelMock.mockReset()
    bridgeGetRuntimeStateMock.mockReset()
    bridgeGetRuntimeStateMock.mockReturnValue({ ready: false, running: false, endpoint: 'ipc:///tmp/hermes-agent-bridge.sock' })
    codingAgentRunManagerMock.stop.mockReset()
    delete process.env.HERMES_RUN_BROKER_URL
    delete process.env.HERMES_RUN_BROKER_KEY
    vi.unstubAllGlobals()
  })

  function stubSharedAgentRole(role: 'viewer' | 'editor' | 'manager') {
    process.env.HERMES_RUN_BROKER_URL = 'http://broker.test'
    const fetchMock = vi.fn(async (url: string, options: any) => {
      expect(url).toBe('http://broker.test/api/run-broker/agents/shared')
      expect(options.headers['X-Hermes-Owner-Open-Id']).toMatch(/^ou_/)
      return new Response(JSON.stringify({
        agents: [{ agent_id: 'agent-shared', role }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  function sharedAgentSession(overrides: Record<string, unknown> = {}) {
    return {
      id: 'shared-session',
      profile: 'owner_profile',
      source: 'api_server',
      agent: 'agent-shared',
      user_id: 'ou_teammate',
      ...overrides,
    }
  }

  function sharedAgentCtx(openid: string, extra: Record<string, unknown> = {}) {
    return {
      state: {
        user: { id: 9, role: 'admin', openid, profile: `feishu_${openid}` },
      },
      body: null,
      ...extra,
    }
  }

  it('lists conversations from the local session store', async () => {
    localListSessionsMock.mockReturnValue([{
      id: 'local-conversation',
      source: 'cli',
      model: 'gpt-5',
      title: 'Local',
      started_at: 1,
      ended_at: null,
      last_active: Math.floor(Date.now() / 1000),
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 1,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: null,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: '',
      preview: 'preview',
      workspace: null,
      expert_id: 'keep-resource-delivery',
      expert_label: '资源投放专家',
      expert_avatar: '/api/hermes/plugin-assets/keep-resource-delivery/expert.png',
    }])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { humanOnly: 'true', limit: '5' }, body: null }
    await mod.listConversations(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith(undefined, undefined, 5)
    expect(listConversationSummariesMock).not.toHaveBeenCalled()
    expect(ctx.body.sessions[0]).toMatchObject({
      id: 'local-conversation',
      source: 'cli',
      title: 'Local',
      expert_id: 'keep-resource-delivery',
      expert_label: '资源投放专家',
      expert_avatar: '/api/hermes/plugin-assets/keep-resource-delivery/expert.png',
    })
  })

  it('lists all account-accessible single-chat sessions when only the active profile header is present', async () => {
    listUserProfilesMock.mockReturnValue([{ profile_name: 'default' }, { profile_name: 'travel' }])
    localListSessionsMock.mockReturnValue([
      {
        id: 'default-session',
        profile: 'default',
        source: 'cli',
        model: 'gpt-5',
        title: 'Default',
        started_at: 1,
        ended_at: null,
        last_active: 3,
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
        preview: '',
      },
      {
        id: 'travel-session',
        profile: 'travel',
        source: 'cli',
        model: 'gpt-5',
        title: 'Travel',
        started_at: 2,
        ended_at: null,
        last_active: 4,
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
        preview: '',
      },
      {
        id: 'secret-session',
        profile: 'secret',
        source: 'cli',
        model: 'gpt-5',
        title: 'Secret',
        started_at: 3,
        ended_at: null,
        last_active: 5,
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
        preview: '',
      },
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: {},
      state: {
        user: { id: 1, role: 'admin' },
        profile: { name: 'travel' },
      },
      body: null,
    }
    await mod.list(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith(undefined, undefined, 2000)
    expect(ctx.body.sessions.map((session: any) => session.id)).toEqual(['default-session', 'travel-session'])
  })

  it('lists only the actor sessions for a shared viewer agent', async () => {
    process.env.HERMES_RUN_BROKER_URL = 'http://broker.test'
    process.env.HERMES_RUN_BROKER_KEY = 'broker-key'
    const fetchMock = vi.fn(async (url: string, options: any) => {
      expect(options.headers.Authorization).toBe('Bearer broker-key')
      expect(options.headers['X-Hermes-Owner-Open-Id']).toBe('ou_viewer')
      expect(url).toBe('http://broker.test/api/run-broker/agents/shared')
      return new Response(JSON.stringify({
        agents: [{ agent_id: 'agent-shared', role: 'viewer' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    localListSessionsByAgentMock.mockReturnValue([
      { id: 'own-session', profile: 'owner_profile', source: 'api_server', agent: 'agent-shared', user_id: 'ou_viewer' },
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: {},
      get: (name: string) => name.toLowerCase() === 'x-hermes-agent-id' ? 'agent-shared' : '',
      state: {
        user: { id: 2, role: 'admin', openid: 'ou_viewer', profile: 'feishu_viewer' },
      },
      body: null,
    }
    await mod.list(ctx)

    expect(localListSessionsByAgentMock).toHaveBeenCalledWith('agent-shared', {
      userId: 'ou_viewer',
      source: undefined,
      limit: 2000,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(ctx.body.sessions.map((session: any) => session.id)).toEqual(['own-session'])
  })

  it('does not promote a shared viewer when the manager probe would be readable', async () => {
    process.env.HERMES_RUN_BROKER_URL = 'http://broker.test'
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://broker.test/api/run-broker/agents/shared') {
        return new Response(JSON.stringify({
          agents: [{ agent_id: 'agent-shared', role: 'viewer' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'http://broker.test/api/run-broker/agents/agent-shared/shares') {
        return new Response(JSON.stringify({ shares: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    localListSessionsByAgentMock.mockReturnValue([
      { id: 'own-session', profile: 'owner_profile', source: 'api_server', agent: 'agent-shared', user_id: 'ou_viewer' },
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: {},
      get: (name: string) => name.toLowerCase() === 'x-hermes-agent-id' ? 'agent-shared' : '',
      state: {
        user: { id: 2, role: 'admin', openid: 'ou_viewer', profile: 'feishu_viewer' },
      },
      body: null,
    }
    await mod.list(ctx)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(localListSessionsByAgentMock).toHaveBeenCalledWith('agent-shared', {
      userId: 'ou_viewer',
      source: undefined,
      limit: 2000,
    })
  })

  it('promotes an owner or manager only when the share probe returns an explicit actor role', async () => {
    process.env.HERMES_RUN_BROKER_URL = 'http://broker.test'
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://broker.test/api/run-broker/agents/shared') {
        return new Response(JSON.stringify({ agents: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'http://broker.test/api/run-broker/agents/agent-shared/shares') {
        return new Response(JSON.stringify({ actor_role: 'manager', shares: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    localListSessionsByAgentMock.mockReturnValue([
      { id: 'manager-session', profile: 'owner_profile', source: 'api_server', agent: 'agent-shared', user_id: 'ou_manager' },
      { id: 'teammate-session', profile: 'owner_profile', source: 'api_server', agent: 'agent-shared', user_id: 'ou_teammate' },
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: {},
      get: (name: string) => name.toLowerCase() === 'x-hermes-agent-id' ? 'agent-shared' : '',
      state: {
        user: { id: 3, role: 'admin', openid: 'ou_manager', profile: 'feishu_manager' },
      },
      body: null,
    }
    await mod.list(ctx)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(localListSessionsByAgentMock).toHaveBeenCalledWith('agent-shared', {
      userId: undefined,
      source: undefined,
      limit: 2000,
    })
    expect(ctx.body.sessions.map((session: any) => session.id)).toEqual(['manager-session', 'teammate-session'])
  })

  it('does not promote a share probe that is readable but lacks an explicit manager role', async () => {
    process.env.HERMES_RUN_BROKER_URL = 'http://broker.test'
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://broker.test/api/run-broker/agents/shared') {
        return new Response(JSON.stringify({ agents: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'http://broker.test/api/run-broker/agents/agent-shared/shares') {
        return new Response(JSON.stringify({ shares: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: {},
      get: (name: string) => name.toLowerCase() === 'x-hermes-agent-id' ? 'agent-shared' : '',
      state: {
        user: { id: 3, role: 'admin', openid: 'ou_manager', profile: 'feishu_manager' },
      },
      body: null,
    }
    await mod.list(ctx)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(localListSessionsByAgentMock).not.toHaveBeenCalled()
    expect(ctx.body.sessions).toEqual([])
    expect(loggerWarnMock).toHaveBeenCalledWith(
      { agentId: 'agent-shared', actorRole: '' },
      '[sessions] Run Broker share manager probe returned no manager role',
    )
  })

  it('lists all agent sessions for a shared manager agent', async () => {
    process.env.HERMES_RUN_BROKER_URL = 'http://broker.test'
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('http://broker.test/api/run-broker/agents/shared')
      return new Response(JSON.stringify({
        agents: [{ agent_id: 'agent-shared', role: 'manager' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    localListSessionsByAgentMock.mockReturnValue([
      { id: 'manager-session', profile: 'owner_profile', source: 'api_server', agent: 'agent-shared', user_id: 'ou_manager' },
      { id: 'teammate-session', profile: 'owner_profile', source: 'api_server', agent: 'agent-shared', user_id: 'ou_teammate' },
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: {},
      get: (name: string) => name.toLowerCase() === 'x-hermes-agent-id' ? 'agent-shared' : '',
      state: {
        user: { id: 3, role: 'admin', openid: 'ou_manager', profile: 'feishu_manager' },
      },
      body: null,
    }
    await mod.list(ctx)

    expect(localListSessionsByAgentMock).toHaveBeenCalledWith('agent-shared', {
      userId: undefined,
      source: undefined,
      limit: 2000,
    })
    expect(ctx.body.sessions.map((session: any) => session.id)).toEqual(['manager-session', 'teammate-session'])
  })

  it('rejects a shared viewer reading a teammate session by id', async () => {
    stubSharedAgentRole('viewer')
    localGetSessionDetailMock.mockReturnValue(sharedAgentSession({
      id: 'teammate-session',
      messages: [{ id: 1, session_id: 'teammate-session', role: 'user', content: 'secret', timestamp: 1 }],
    }))

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = sharedAgentCtx('ou_viewer', {
      params: { id: 'teammate-session' },
      query: { humanOnly: 'false' },
    })
    await mod.getConversationMessages(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Profile "owner_profile" is not available for this user' })
  })

  it('lets a shared viewer rename their own shared-agent session', async () => {
    stubSharedAgentRole('viewer')
    getSessionMock.mockReturnValue(sharedAgentSession({
      id: 'own-session',
      user_id: 'ou_viewer',
    }))
    localRenameSessionMock.mockReturnValue(true)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = sharedAgentCtx('ou_viewer', {
      params: { id: 'own-session' },
      request: { body: { title: '  My shared run  ' } },
    })
    await mod.rename(ctx)

    expect(localRenameSessionMock).toHaveBeenCalledWith('own-session', 'My shared run')
    expect(ctx.body).toEqual({ ok: true })
  })

  it('rejects a shared viewer mutating a teammate session by id', async () => {
    stubSharedAgentRole('viewer')
    getSessionMock.mockReturnValue(sharedAgentSession({ id: 'teammate-session' }))

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const renameCtx: any = sharedAgentCtx('ou_viewer', {
      params: { id: 'teammate-session' },
      request: { body: { title: 'Nope' } },
    })
    await mod.rename(renameCtx)

    expect(renameCtx.status).toBe(403)
    expect(localRenameSessionMock).not.toHaveBeenCalled()

    const modelCtx: any = sharedAgentCtx('ou_viewer', {
      params: { id: 'teammate-session' },
      request: { body: { model: 'gpt-5', provider: 'openai' } },
    })
    await mod.setModel(modelCtx)

    expect(modelCtx.status).toBe(403)
    expect(localUpdateSessionMock).not.toHaveBeenCalled()
  })

  it('lets a shared manager update teammate session metadata', async () => {
    stubSharedAgentRole('manager')
    getSessionMock.mockReturnValue(sharedAgentSession({ id: 'teammate-session' }))
    localRenameSessionMock.mockReturnValue(true)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const renameCtx: any = sharedAgentCtx('ou_manager', {
      params: { id: 'teammate-session' },
      request: { body: { title: '  Reviewed  ' } },
    })
    await mod.rename(renameCtx)

    const workspaceCtx: any = sharedAgentCtx('ou_manager', {
      params: { id: 'teammate-session' },
      request: { body: { workspace: '/tmp/project' } },
    })
    await mod.setWorkspace(workspaceCtx)

    const modelCtx: any = sharedAgentCtx('ou_manager', {
      params: { id: 'teammate-session' },
      request: { body: { model: 'gpt-5.1', provider: 'openai' } },
    })
    await mod.setModel(modelCtx)

    expect(localRenameSessionMock).toHaveBeenCalledWith('teammate-session', 'Reviewed')
    expect(localUpdateSessionMock).toHaveBeenCalledWith('teammate-session', { workspace: '/tmp/project' })
    expect(localUpdateSessionMock).toHaveBeenCalledWith('teammate-session', {
      model: 'gpt-5.1',
      provider: 'openai',
      workspace: '/tmp/hermes-test/owner_profile/workspace',
    })
    expect(renameCtx.body).toEqual({ ok: true })
    expect(workspaceCtx.body).toEqual({ ok: true })
    expect(modelCtx.body).toEqual({ ok: true })
  })

  it('lists workspace run changes for an accessible session without patch bodies', async () => {
    getSessionMock.mockReturnValue({
      id: 'session-diff',
      profile: 'travel',
      source: 'coding_agent',
    })
    listWorkspaceRunChangesForSessionMock.mockReturnValue([{
      change_id: 'change-1',
      session_id: 'session-diff',
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
        session_id: 'session-diff',
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
      }],
    }])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'session-diff' }, query: {}, body: null }
    await mod.listWorkspaceRunChanges(ctx)

    expect(listWorkspaceRunChangesForSessionMock).toHaveBeenCalledWith('session-diff')
    expect(ctx.body).toEqual({
      changes: [expect.objectContaining({
        change_id: 'change-1',
        files: [expect.not.objectContaining({ patch: expect.anything() })],
      })],
    })
  })

  it('returns one workspace run change summary for an accessible session', async () => {
    getSessionMock.mockReturnValue({ id: 'session-diff', profile: 'travel' })
    getWorkspaceRunChangeMock.mockReturnValue({
      change_id: 'change-1',
      session_id: 'session-diff',
      run_id: 'run-1',
      files: [],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'session-diff', changeId: 'change-1' }, query: {}, body: null }
    await mod.getWorkspaceRunChange(ctx)

    expect(getWorkspaceRunChangeMock).toHaveBeenCalledWith('session-diff', 'change-1')
    expect(ctx.body).toEqual({
      change: expect.objectContaining({
        change_id: 'change-1',
        session_id: 'session-diff',
      }),
    })
  })

  it('returns workspace run change file patch details for an accessible session', async () => {
    getSessionMock.mockReturnValue({ id: 'session-diff', profile: 'travel' })
    getWorkspaceRunChangeFileMock.mockReturnValue({
      id: 7,
      change_id: 'change-1',
      session_id: 'session-diff',
      path: 'src/app.ts',
      change_type: 'modified',
      additions: 2,
      deletions: 1,
      patch: '@@ -1 +1 @@',
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'session-diff', changeId: 'change-1', fileId: '7' }, query: {}, body: null }
    await mod.getWorkspaceRunChangeFile(ctx)

    expect(getWorkspaceRunChangeFileMock).toHaveBeenCalledWith('session-diff', 'change-1', 7)
    expect(ctx.body).toEqual({
      file: expect.objectContaining({
        id: 7,
        patch: '@@ -1 +1 @@',
      }),
    })
  })

  it('rejects a shared viewer reading teammate workspace run changes', async () => {
    stubSharedAgentRole('viewer')
    getSessionMock.mockReturnValue(sharedAgentSession({ id: 'teammate-session' }))

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = sharedAgentCtx('ou_viewer', {
      params: { id: 'teammate-session' },
      query: {},
    })
    await mod.listWorkspaceRunChanges(ctx)

    expect(ctx.status).toBe(403)
    expect(listWorkspaceRunChangesForSessionMock).not.toHaveBeenCalled()
  })

  it('returns 404 for workspace run change reads when the session or file is missing', async () => {
    getSessionMock.mockReturnValue(null)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const missingSessionCtx: any = { params: { id: 'missing-session' }, query: {}, body: null }
    await mod.listWorkspaceRunChanges(missingSessionCtx)

    expect(missingSessionCtx.status).toBe(404)
    expect(missingSessionCtx.body).toEqual({ error: 'Session not found' })
    expect(listWorkspaceRunChangesForSessionMock).not.toHaveBeenCalled()

    getSessionMock.mockReturnValue({ id: 'session-diff', profile: 'travel' })
    getWorkspaceRunChangeFileMock.mockReturnValue(null)
    const missingFileCtx: any = { params: { id: 'session-diff', changeId: 'change-1', fileId: '7' }, query: {}, body: null }
    await mod.getWorkspaceRunChangeFile(missingFileCtx)

    expect(missingFileCtx.status).toBe(404)
    expect(missingFileCtx.body).toEqual({ error: 'Workspace run change file not found' })
  })

  it('lists workspace-internal symlink folders and rejects external symlink folders', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-folder-picker-'))
    const previousWorkspaceBase = process.env.WORKSPACE_BASE
    try {
      const base = join(root, 'base')
      const internalTarget = join(base, 'real-folder')
      const externalTarget = join(root, 'external-folder')
      mkdirSync(join(internalTarget, 'child'), { recursive: true })
      mkdirSync(join(externalTarget, 'secret-child'), { recursive: true })
      symlinkSync(internalTarget, join(base, 'inside-link'), 'dir')
      symlinkSync(externalTarget, join(base, 'outside-link'), 'dir')
      process.env.WORKSPACE_BASE = base

      const mod = await import('../../packages/server/src/controllers/hermes/sessions')
      const rootCtx: any = { query: {}, body: null }
      await mod.listWorkspaceFolders(rootCtx)

      expect(rootCtx.body.folders.map((folder: any) => folder.name)).toEqual(['inside-link', 'real-folder'])

      const insideCtx: any = { query: { path: 'inside-link' }, body: null }
      await mod.listWorkspaceFolders(insideCtx)
      expect(insideCtx.body.folders.map((folder: any) => folder.name)).toEqual(['child'])

      const outsideCtx: any = { query: { path: 'outside-link' }, body: null }
      await mod.listWorkspaceFolders(outsideCtx)
      expect(outsideCtx.status).toBe(403)
      expect(outsideCtx.body).toEqual({ error: 'Access denied' })
    } finally {
      if (previousWorkspaceBase === undefined) delete process.env.WORKSPACE_BASE
      else process.env.WORKSPACE_BASE = previousWorkspaceBase
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lets a shared manager delete teammate sessions', async () => {
    stubSharedAgentRole('manager')
    getSessionMock.mockReturnValue(sharedAgentSession({ id: 'teammate-session', profile: 'travel' }))
    getExactSessionDetailFromDbWithProfileMock.mockResolvedValue({ id: 'teammate-session', messages: [] })
    deleteHermesSessionForProfileMock.mockResolvedValue(true)
    localDeleteSessionMock.mockReturnValue(true)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const removeCtx: any = sharedAgentCtx('ou_manager', {
      params: { id: 'teammate-session' },
    })
    await mod.remove(removeCtx)

    const batchCtx: any = sharedAgentCtx('ou_manager', {
      request: { body: { sessions: [{ id: 'teammate-session', profile: 'travel' }] } },
    })
    await mod.batchRemove(batchCtx)

    expect(deleteHermesSessionForProfileMock).toHaveBeenCalledWith('teammate-session', 'travel')
    expect(localDeleteSessionMock).toHaveBeenCalledWith('teammate-session')
    expect(removeCtx.body).toMatchObject({ ok: true, deleted: true })
    expect(batchCtx.body).toMatchObject({ ok: true, deleted: 1, failed: 0 })
  })

  it('filters the single-chat session list when profile is explicitly provided', async () => {
    localListSessionsMock.mockReturnValue([])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: { profile: 'travel' },
      state: { profile: { name: 'default' } },
      body: null,
    }
    await mod.list(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith('travel', undefined, 2000)
  })

  it('filters chat-plane sessions by an explicitly selected authorized frontend profile', async () => {
    isChatPlaneRequestMock.mockReturnValue(true)
    listUserProfilesMock.mockReturnValue([{ profile_name: '123' }])
    localListSessionsMock.mockReturnValue([
      { id: 'agent-session', profile: '123', source: 'cli' },
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: { profile: '123' },
      state: {
        user: {
          id: 1,
          role: 'admin',
          profile: 'feishu_g41a5b5g',
          profiles: ['123'],
        },
      },
      body: null,
    }
    await mod.list(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith('123', undefined, 2000)
    expect(ctx.body.sessions).toEqual([expect.objectContaining({ id: 'agent-session', profile: '123' })])
  })

  it('does not silently fall back to the bound profile for an unauthorized chat-plane session filter', async () => {
    isChatPlaneRequestMock.mockReturnValue(true)
    listUserProfilesMock.mockReturnValue([{ profile_name: '123' }])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: { profile: 'secret' },
      state: {
        user: {
          id: 1,
          role: 'admin',
          profile: 'feishu_g41a5b5g',
          profiles: ['123'],
        },
      },
      body: null,
    }
    await mod.list(ctx)

    expect(localListSessionsMock).not.toHaveBeenCalled()
    expect(ctx.body.sessions).toEqual([])
  })

  it('lists only global-agent sessions when requested by source', async () => {
    localListSessionsMock.mockReturnValue([
      { id: 'global-1', profile: 'default', source: 'global_agent' },
      { id: 'chat-1', profile: 'default', source: 'cli' },
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: { source: 'global_agent' },
      state: {},
      body: null,
    }
    await mod.list(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith(undefined, 'global_agent', 2000)
    expect(ctx.body.sessions).toEqual([expect.objectContaining({ id: 'global-1', source: 'global_agent' })])
  })

  it('marks Hermes history sessions that already exist in the Web UI store', async () => {
    localListSessionsMock.mockReturnValue([{ id: 'cli-1', profile: 'travel' }])
    listSessionSummariesMock.mockResolvedValue([
      {
        id: 'cli-1',
        source: 'cli',
        model: 'gpt-5',
        title: 'Imported',
        started_at: 1,
        ended_at: null,
        last_active: 2,
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
        preview: '',
      },
      {
        id: 'cli-2',
        source: 'cli',
        model: 'gpt-5',
        title: 'History only',
        started_at: 1,
        ended_at: null,
        last_active: 2,
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
        preview: '',
      },
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { profile: 'travel' }, state: {}, body: null }

    await mod.listHermesSessions(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith('travel', undefined, 2000, { includeArchived: true })
    expect(listSessionSummariesMock).toHaveBeenCalledWith(undefined, 2000, 'travel')
    expect(ctx.body.sessions).toEqual([
      expect.objectContaining({ id: 'cli-1', profile: 'travel', webui_imported: true }),
      expect.objectContaining({ id: 'cli-2', profile: 'travel', webui_imported: false }),
    ])
  })

  it('includes archived and local-only coding-agent sessions in History with local archive state winning', async () => {
    localListSessionsMock.mockReturnValue([
      {
        id: 'cli-1',
        profile: 'travel',
        source: 'cli',
        agent: 'hermes',
        model: 'local-model',
        title: 'Local archived import',
        started_at: 1,
        ended_at: null,
        last_active: 4,
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
        preview: 'local',
        is_archived: true,
      },
      {
        id: 'codex-local',
        profile: 'travel',
        source: 'coding_agent',
        agent: 'codex',
        agent_mode: 'scoped',
        agent_session_id: 'codex-agent-session',
        model: 'gpt-5',
        title: 'Codex local only',
        started_at: 2,
        ended_at: null,
        last_active: 5,
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
        preview: 'codex',
        is_archived: false,
      },
    ])
    listSessionSummariesMock.mockResolvedValue([
      {
        id: 'cli-1',
        source: 'cli',
        model: 'state-model',
        title: 'State row',
        started_at: 1,
        ended_at: null,
        last_active: 3,
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
        preview: 'state',
      },
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { profile: 'travel' }, state: {}, body: null }

    await mod.listHermesSessions(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith('travel', undefined, 2000, { includeArchived: true })
    expect(ctx.body.sessions).toEqual([
      expect.objectContaining({
        id: 'cli-1',
        profile: 'travel',
        webui_imported: true,
        is_archived: true,
      }),
      expect.objectContaining({
        id: 'codex-local',
        profile: 'travel',
        source: 'coding_agent',
        agent: 'codex',
        agent_session_id: 'codex-agent-session',
        webui_imported: true,
        is_archived: false,
      }),
    ])
  })

  it('keeps archived local-only api_server sessions visible in History', async () => {
    localListSessionsMock.mockReturnValue([
      {
        id: 'archived-webui',
        profile: 'travel',
        source: 'api_server',
        title: 'Archived WebUI chat',
        is_archived: true,
      },
    ])
    listSessionSummariesMock.mockResolvedValue([])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { profile: 'travel' }, state: {}, body: null }

    await mod.listHermesSessions(ctx)

    expect(ctx.body.sessions).toEqual([
      expect.objectContaining({
        id: 'archived-webui',
        source: 'api_server',
        is_archived: true,
        webui_imported: true,
      }),
    ])
  })

  it('applies History source filters to local-only rows', async () => {
    localListSessionsMock.mockReturnValue([
      { id: 'cli-local', profile: 'travel', source: 'cli', is_archived: false },
      { id: 'codex-local', profile: 'travel', source: 'coding_agent', is_archived: false },
    ])
    listSessionSummariesMock.mockResolvedValue([])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { profile: 'travel', source: 'cli' }, state: {}, body: null }

    await mod.listHermesSessions(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith('travel', 'cli', 2000, { includeArchived: true })
    expect(ctx.body.sessions.map((session: any) => session.id)).toEqual(['cli-local'])
  })

  it('lists only actor History sessions for a shared editor agent', async () => {
    stubSharedAgentRole('editor')
    localListSessionsByAgentMock.mockReturnValue([
      sharedAgentSession({
        id: 'own-archived-session',
        user_id: 'ou_editor',
        is_archived: true,
      }),
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = sharedAgentCtx('ou_editor', {
      query: {},
      get: (name: string) => name.toLowerCase() === 'x-hermes-agent-id' ? 'agent-shared' : '',
    })
    await mod.listHermesSessions(ctx)

    expect(localListSessionsByAgentMock).toHaveBeenCalledWith('agent-shared', {
      userId: 'ou_editor',
      source: undefined,
      limit: 2000,
      includeArchived: true,
    })
    expect(localListSessionsMock).not.toHaveBeenCalled()
    expect(ctx.body.sessions.map((session: any) => session.id)).toEqual(['own-archived-session'])
  })

  it('lists all History sessions for a shared manager agent', async () => {
    stubSharedAgentRole('manager')
    localListSessionsByAgentMock.mockReturnValue([
      sharedAgentSession({ id: 'manager-archived-session', user_id: 'ou_manager', is_archived: true }),
      sharedAgentSession({ id: 'teammate-archived-session', user_id: 'ou_teammate', is_archived: true }),
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = sharedAgentCtx('ou_manager', {
      query: {},
      get: (name: string) => name.toLowerCase() === 'x-hermes-agent-id' ? 'agent-shared' : '',
    })
    await mod.listHermesSessions(ctx)

    expect(localListSessionsByAgentMock).toHaveBeenCalledWith('agent-shared', {
      userId: undefined,
      source: undefined,
      limit: 2000,
      includeArchived: true,
    })
    expect(ctx.body.sessions.map((session: any) => session.id)).toEqual(['manager-archived-session', 'teammate-archived-session'])
  })

  it('lists all History sessions for an owner agent resolved by the share probe', async () => {
    process.env.HERMES_RUN_BROKER_URL = 'http://broker.test'
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://broker.test/api/run-broker/agents/shared') {
        return new Response(JSON.stringify({ agents: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'http://broker.test/api/run-broker/agents/agent-shared/shares') {
        return new Response(JSON.stringify({ actor_role: 'owner', shares: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    localListSessionsByAgentMock.mockReturnValue([
      sharedAgentSession({ id: 'owner-archived-session', user_id: 'ou_owner', is_archived: true }),
      sharedAgentSession({ id: 'teammate-archived-session', user_id: 'ou_teammate', is_archived: true }),
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = sharedAgentCtx('ou_owner', {
      query: {},
      get: (name: string) => name.toLowerCase() === 'x-hermes-agent-id' ? 'agent-shared' : '',
    })
    await mod.listHermesSessions(ctx)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(localListSessionsByAgentMock).toHaveBeenCalledWith('agent-shared', {
      userId: undefined,
      source: undefined,
      limit: 2000,
      includeArchived: true,
    })
    expect(ctx.body.sessions.map((session: any) => session.id)).toEqual(['owner-archived-session', 'teammate-archived-session'])
  })

  it('does not fall back to profile History rows for an unshared teammate agent request', async () => {
    process.env.HERMES_RUN_BROKER_URL = 'http://broker.test'
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://broker.test/api/run-broker/agents/shared') {
        return new Response(JSON.stringify({ agents: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'http://broker.test/api/run-broker/agents/agent-shared/shares') {
        return new Response('{}', { status: 403, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    localListSessionsMock.mockReturnValue([
      sharedAgentSession({ id: 'profile-fallback-session', is_archived: true }),
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = sharedAgentCtx('ou_teammate', {
      query: {},
      get: (name: string) => name.toLowerCase() === 'x-hermes-agent-id' ? 'agent-shared' : '',
    })
    await mod.listHermesSessions(ctx)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(localListSessionsByAgentMock).not.toHaveBeenCalled()
    expect(localListSessionsMock).not.toHaveBeenCalled()
    expect(ctx.body.sessions).toEqual([])
  })

  it('archives and unarchives sessions through async session ACL', async () => {
    getSessionMock.mockReturnValue({
      id: 'local-session',
      profile: 'travel',
      source: 'api_server',
      is_archived: false,
    })
    localSetSessionArchivedMock.mockReturnValue(true)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const archiveCtx: any = {
      params: { id: 'local-session' },
      state: { user: { id: 1, role: 'admin', profile: 'travel' } },
      body: null,
    }
    await mod.archiveSession(archiveCtx)

    const unarchiveCtx: any = {
      params: { id: 'local-session' },
      state: { user: { id: 1, role: 'admin', profile: 'travel' } },
      body: null,
    }
    await mod.unarchiveSession(unarchiveCtx)

    expect(localSetSessionArchivedMock).toHaveBeenCalledWith('local-session', true)
    expect(localSetSessionArchivedMock).toHaveBeenCalledWith('local-session', false)
    expect(archiveCtx.body).toEqual({ ok: true, archived: true })
    expect(unarchiveCtx.body).toEqual({ ok: true, archived: false })
  })

  it('rejects a shared viewer archiving a teammate shared-agent session', async () => {
    stubSharedAgentRole('viewer')
    getSessionMock.mockReturnValue(sharedAgentSession({ id: 'teammate-session' }))

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = sharedAgentCtx('ou_viewer', {
      params: { id: 'teammate-session' },
    })
    await mod.archiveSession(ctx)

    expect(ctx.status).toBe(403)
    expect(localSetSessionArchivedMock).not.toHaveBeenCalled()
  })

  it('rejects a shared editor archiving a teammate shared-agent session', async () => {
    stubSharedAgentRole('editor')
    getSessionMock.mockReturnValue(sharedAgentSession({ id: 'teammate-session' }))

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = sharedAgentCtx('ou_editor', {
      params: { id: 'teammate-session' },
    })
    await mod.archiveSession(ctx)

    expect(ctx.status).toBe(403)
    expect(localSetSessionArchivedMock).not.toHaveBeenCalled()
  })

  it('lets a shared manager archive and unarchive teammate shared-agent sessions', async () => {
    stubSharedAgentRole('manager')
    getSessionMock.mockReturnValue(sharedAgentSession({ id: 'teammate-session' }))
    localSetSessionArchivedMock.mockReturnValue(true)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const archiveCtx: any = sharedAgentCtx('ou_manager', {
      params: { id: 'teammate-session' },
    })
    await mod.archiveSession(archiveCtx)

    const unarchiveCtx: any = sharedAgentCtx('ou_manager', {
      params: { id: 'teammate-session' },
    })
    await mod.unarchiveSession(unarchiveCtx)

    expect(localSetSessionArchivedMock).toHaveBeenCalledWith('teammate-session', true)
    expect(localSetSessionArchivedMock).toHaveBeenCalledWith('teammate-session', false)
    expect(archiveCtx.body).toEqual({ ok: true, archived: true })
    expect(unarchiveCtx.body).toEqual({ ok: true, archived: false })
  })

  it('searches all account-accessible single-chat sessions unless profile is explicit', async () => {
    localSearchSessionsMock.mockReturnValue([
      { id: 'global-1', profile: 'default', source: 'global_agent' },
      { id: 'chat-1', profile: 'default', source: 'cli' },
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: { q: 'docker', limit: '10' },
      state: { profile: { name: 'travel' } },
      body: null,
    }
    await mod.search(ctx)

    expect(localSearchSessionsMock).toHaveBeenCalledWith(undefined, 'docker', 10)
    expect(ctx.body.results).toEqual([
      expect.objectContaining({ id: 'global-1', source: 'global_agent' }),
      expect.objectContaining({ id: 'chat-1', source: 'cli' }),
    ])
  })

  it('searches only global-agent sessions when requested by source', async () => {
    localSearchSessionsMock.mockReturnValue([
      { id: 'global-1', profile: 'default', source: 'global_agent' },
      { id: 'chat-1', profile: 'default', source: 'cli' },
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: { q: 'docker', source: 'global_agent', limit: '10' },
      state: {},
      body: null,
    }
    await mod.search(ctx)

    expect(localSearchSessionsMock).toHaveBeenCalledWith(undefined, 'docker', 10)
    expect(ctx.body.results).toEqual([expect.objectContaining({ id: 'global-1', source: 'global_agent' })])
  })

  it('propagates local session store errors for conversation summaries', async () => {
    localListSessionsMock.mockImplementation(() => {
      throw new Error('db unavailable')
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { humanOnly: 'false' }, body: null }
    await expect(mod.listConversations(ctx)).rejects.toThrow('db unavailable')
  })

  it('gets conversation messages from the local session store', async () => {
    localGetSessionDetailMock.mockReturnValue({
      id: 'root',
      messages: [
        { id: 1, session_id: 'root', role: 'user', content: 'hello', timestamp: 1 },
        { id: 2, session_id: 'root', role: 'command', content: '/usage', timestamp: 2 },
      ],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'root' }, query: { humanOnly: 'true' }, body: null }
    await mod.getConversationMessages(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('root')
    expect(getConversationDetailMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({
      session_id: 'root',
      messages: [{ id: 1, session_id: 'root', role: 'user', content: 'hello', timestamp: 1 }],
      visible_count: 1,
      thread_session_count: 1,
    })
  })

  it('returns expert metadata from paginated local conversation detail', async () => {
    localGetSessionDetailPaginatedMock.mockReturnValue({
      session: {
        id: 'expert-session',
        profile: 'default',
        source: 'api_server',
        model: 'custom:litellm-sre/tencent-',
        title: '资源投放',
        started_at: 1,
        ended_at: null,
        last_active: 2,
        message_count: 1,
        input_tokens: 10,
        output_tokens: 20,
        expert_id: 'keep-resource-delivery',
        expert_label: '资源投放专家',
        expert_avatar: '/api/hermes/plugin-assets/keep-resource-delivery/expert.png',
      },
      messages: [{ id: 1, session_id: 'expert-session', role: 'assistant', content: 'ok', timestamp: 2 }],
      total: 1,
      offset: 0,
      limit: 150,
      hasMore: false,
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'expert-session' }, query: {}, state: {}, body: null }
    await mod.getConversationMessagesPaginated(ctx)

    expect(localGetSessionDetailPaginatedMock).toHaveBeenCalledWith('expert-session', 0, 150)
    expect(ctx.body.session).toEqual(expect.objectContaining({
      id: 'expert-session',
      expert_id: 'keep-resource-delivery',
      expert_label: '资源投放专家',
      expert_avatar: '/api/hermes/plugin-assets/keep-resource-delivery/expert.png',
    }))
  })

  it('treats missing conversation message arrays as empty', async () => {
    localGetSessionDetailMock.mockReturnValue({
      id: 'root',
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'root' }, query: { humanOnly: 'false' }, body: null }
    await mod.getConversationMessages(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('root')
    expect(ctx.body).toEqual({
      session_id: 'root',
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
    })
  })

  it('returns 404 when local conversation detail is missing', async () => {
    localGetSessionDetailMock.mockReturnValue(null)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'root' }, query: { humanOnly: 'false' }, body: null }
    await mod.getConversationMessages(ctx)

    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: 'Conversation not found' })
  })

  it('prefers local session detail for Hermes history detail when available', async () => {
    localGetSessionDetailMock.mockReturnValue({
      id: 'cli-1',
      source: 'cli',
      title: 'Local complete',
      messages: [
        { id: 1, session_id: 'cli-1', role: 'user', content: 'local full message', timestamp: 1 },
      ],
    })
    getSessionDetailFromDbMock.mockResolvedValue({
      id: 'cli-1',
      source: 'cli',
      title: 'Hermes incomplete',
      messages: [],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'cli-1' }, body: null }
    await mod.getHermesSession(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('cli-1')
    expect(getSessionDetailFromDbMock).not.toHaveBeenCalled()
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(ctx.body.session).toMatchObject({
      id: 'cli-1',
      title: 'Local complete',
      messages: [{ content: 'local full message' }],
    })
  })

  it('falls back to Hermes state.db when local history detail is missing', async () => {
    localGetSessionDetailMock.mockReturnValue(null)
    getSessionDetailFromDbMock.mockResolvedValue({
      id: 'hermes-1',
      source: 'cli',
      title: 'Hermes detail',
      messages: [
        { id: 1, session_id: 'hermes-1', role: 'user', content: 'from hermes', timestamp: 1 },
      ],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'hermes-1' }, body: null }
    await mod.getHermesSession(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('hermes-1')
    expect(getSessionDetailFromDbMock).toHaveBeenCalledWith('hermes-1')
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(ctx.body.session).toMatchObject({
      id: 'hermes-1',
      title: 'Hermes detail',
      messages: [{ content: 'from hermes' }],
    })
  })

  it('reads Hermes history detail from the requested profile database', async () => {
    localGetSessionDetailMock.mockReturnValue(null)
    getSessionDetailFromDbWithProfileMock.mockResolvedValue({
      id: 'travel-session',
      source: 'cli',
      title: 'Travel detail',
      messages: [
        { id: 1, session_id: 'travel-session', role: 'user', content: 'from travel', timestamp: 1 },
      ],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'travel-session' }, query: { profile: 'travel' }, body: null }
    await mod.getHermesSession(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('travel-session')
    expect(getSessionDetailFromDbWithProfileMock).toHaveBeenCalledWith('travel-session', 'travel')
    expect(getSessionDetailFromDbMock).not.toHaveBeenCalled()
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(ctx.body.session).toMatchObject({
      id: 'travel-session',
      profile: 'travel',
      title: 'Travel detail',
      messages: [{ content: 'from travel' }],
    })
  })

  it('does not return api_server sessions from the Hermes history detail endpoint', async () => {
    localGetSessionDetailMock.mockReturnValue({
      id: 'api-1',
      source: 'api_server',
      title: 'API Server',
      messages: [{ id: 1, session_id: 'api-1', role: 'user', content: 'local api', timestamp: 1 }],
    })
    getSessionDetailFromDbMock.mockResolvedValue(null)
    getSessionMock.mockResolvedValue(null)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'api-1' }, body: null }
    await mod.getHermesSession(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('api-1')
    expect(getSessionDetailFromDbMock).toHaveBeenCalledWith('api-1')
    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: 'Session not found' })
  })

  it('returns native state.db usage analytics for the requested period', async () => {
    const today = new Date().toISOString().slice(0, 10)
    getLocalUsageStatsMock.mockReturnValue({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 2,
      cache_write_tokens: 1,
      reasoning_tokens: 3,
      sessions: 1,
      by_model: [
        { model: 'local-model', input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 1, reasoning_tokens: 3, sessions: 1 },
      ],
      by_day: [
        { date: today, input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 1, sessions: 1, errors: 0, cost: 0 },
      ],
    })
    getUsageStatsFromDbMock.mockResolvedValue({
      input_tokens: 20,
      output_tokens: 10,
      cache_read_tokens: 4,
      cache_write_tokens: 2,
      reasoning_tokens: 6,
      sessions: 2,
      cost: 0.02,
      total_api_calls: 7,
      by_model: [
        { model: 'hermes-model', input_tokens: 20, output_tokens: 10, cache_read_tokens: 4, cache_write_tokens: 2, reasoning_tokens: 6, sessions: 2 },
      ],
      by_day: [
        { date: today, input_tokens: 20, output_tokens: 10, cache_read_tokens: 4, cache_write_tokens: 2, sessions: 2, errors: 0, cost: 0.02 },
      ],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { days: '2' }, body: null }
    await mod.usageStats(ctx)

    expect(getLocalUsageStatsMock).not.toHaveBeenCalled()
    expect(getUsageStatsFromDbMock).toHaveBeenCalledWith(2)
    expect(ctx.body).toMatchObject({
      total_input_tokens: 20,
      total_output_tokens: 10,
      total_cache_read_tokens: 4,
      total_cache_write_tokens: 2,
      total_reasoning_tokens: 6,
      total_sessions: 2,
      total_cost: 0.02,
      total_api_calls: 7,
      period_days: 2,
    })
    expect(ctx.body.model_usage).toEqual([
      { model: 'hermes-model', input_tokens: 20, output_tokens: 10, cache_read_tokens: 4, cache_write_tokens: 2, reasoning_tokens: 6, sessions: 2 },
    ])
    expect(ctx.body.daily_usage.find((row: any) => row.date === today)).toMatchObject({
      input_tokens: 20,
      output_tokens: 10,
      cache_read_tokens: 4,
      cache_write_tokens: 2,
      sessions: 2,
      cost: 0.02,
    })
  })

  it('loads usage analytics from the request-scoped profile state database', async () => {
    getUsageStatsFromDbMock.mockResolvedValue({
      input_tokens: 12,
      output_tokens: 6,
      cache_read_tokens: 3,
      cache_write_tokens: 1,
      reasoning_tokens: 2,
      sessions: 1,
      cost: 0.01,
      total_api_calls: 4,
      by_model: [
        { model: 'research-model', input_tokens: 12, output_tokens: 6, cache_read_tokens: 3, cache_write_tokens: 1, reasoning_tokens: 2, sessions: 1 },
      ],
      by_day: [],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { days: '2' }, state: { profile: { name: 'research' } }, body: null }
    await mod.usageStats(ctx)

    expect(getUsageStatsFromDbMock).toHaveBeenCalledWith(2, undefined, 'research')
    expect(ctx.body).toMatchObject({
      total_input_tokens: 12,
      total_output_tokens: 6,
      total_sessions: 1,
      total_cost: 0.01,
      total_api_calls: 4,
    })
    expect(ctx.body.model_usage).toEqual([
      { model: 'research-model', input_tokens: 12, output_tokens: 6, cache_read_tokens: 3, cache_write_tokens: 1, reasoning_tokens: 2, sessions: 1 },
    ])
  })

  it('keeps blank model usage as returned by state.db analytics', async () => {
    getLocalUsageStatsMock.mockReturnValue({
      input_tokens: 3,
      output_tokens: 1,
      cache_read_tokens: 2,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      sessions: 1,
      by_model: [
        { model: '', input_tokens: 3, output_tokens: 1, cache_read_tokens: 2, cache_write_tokens: 0, reasoning_tokens: 0, sessions: 1 },
      ],
      by_day: [],
    })
    getUsageStatsFromDbMock.mockResolvedValue({
      input_tokens: 2,
      output_tokens: 1,
      cache_read_tokens: 1,
      cache_write_tokens: 1,
      reasoning_tokens: 0,
      sessions: 1,
      cost: 0,
      total_api_calls: 0,
      by_model: [
        { model: ' ', input_tokens: 2, output_tokens: 1, cache_read_tokens: 1, cache_write_tokens: 1, reasoning_tokens: 0, sessions: 1 },
      ],
      by_day: [],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { days: '2' }, body: null }
    await mod.usageStats(ctx)

    expect(ctx.body.model_usage).toEqual([
      { model: ' ', input_tokens: 2, output_tokens: 1, cache_read_tokens: 1, cache_write_tokens: 1, reasoning_tokens: 0, sessions: 1 },
    ])
  })

  it('sets a session model and provider in the local session store', async () => {
    getSessionMock.mockReturnValue({ id: 'session-1' })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      params: { id: 'session-1' },
      request: { body: { model: 'grok-4', provider: 'xai' } },
      body: null,
    }
    await mod.setModel(ctx)

    expect(localCreateSessionMock).not.toHaveBeenCalled()
    expect(localUpdateSessionMock).toHaveBeenCalledWith('session-1', {
      model: 'grok-4',
      provider: 'xai',
      workspace: '/tmp/hermes-test/default/workspace',
    })
    expect(bridgeSwitchSessionModelMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ ok: true })
  })

  it('notifies a loaded agent bridge session after storing the session model', async () => {
    bridgeGetRuntimeStateMock.mockReturnValue({ ready: true, running: true, endpoint: 'ipc:///tmp/hermes-agent-bridge.sock' })
    bridgeSwitchSessionModelMock.mockResolvedValue({
      ok: true,
      session_id: 'session-1',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      loaded: true,
      switched: true,
    })
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'travel' })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      params: { id: 'session-1' },
      request: { body: { model: 'claude-sonnet-4-6', provider: 'claude-oauth' } },
      body: null,
    }
    await mod.setModel(ctx)

    expect(localUpdateSessionMock).toHaveBeenCalledWith('session-1', {
      model: 'claude-sonnet-4-6',
      provider: 'claude-oauth',
      workspace: '/tmp/hermes-test/travel/workspace',
    })
    expect(bridgeSwitchSessionModelMock).toHaveBeenCalledWith(
      'session-1',
      'claude-sonnet-4-6',
      'anthropic',
      'travel',
    )
    expect(ctx.body).toEqual({ ok: true })
  })

  it('stores a coding agent session model without stopping the runner or notifying the Hermes bridge', async () => {
    bridgeGetRuntimeStateMock.mockReturnValue({ ready: true, running: true, endpoint: 'ipc:///tmp/hermes-agent-bridge.sock' })
    getSessionMock.mockReturnValue({
      id: 'codex-session',
      profile: 'default',
      source: 'coding_agent',
      agent: 'codex',
      model: 'old-model',
      provider: 'openrouter',
      agent_native_session_id: 'old-native-thread',
      workspace: '/tmp/original-workspace',
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      params: { id: 'codex-session' },
      request: { body: { model: 'gpt-5.5', provider: 'openai-codex' } },
      body: null,
    }
    await mod.setModel(ctx)

    expect(localUpdateSessionMock).toHaveBeenCalledWith('codex-session', {
      model: 'gpt-5.5',
      provider: 'openai-codex',
      agent_native_session_id: '',
    })
    expect(codingAgentRunManagerMock.stop).not.toHaveBeenCalled()
    expect(bridgeSwitchSessionModelMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ ok: true })
  })

  it('deletes a current-profile Hermes history session even when no local Web UI session exists', async () => {
    getActiveProfileNameMock.mockReturnValue('travel')
    getSessionMock.mockReturnValue(null)
    getExactSessionDetailFromDbWithProfileMock.mockResolvedValue({ id: 'history-only', messages: [] })
    deleteHermesSessionForProfileMock.mockResolvedValue(true)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'history-only' }, body: null }
    await mod.remove(ctx)

    expect(getExactSessionDetailFromDbWithProfileMock).toHaveBeenCalledWith('history-only', 'travel')
    expect(deleteHermesSessionForProfileMock).toHaveBeenCalledWith('history-only', 'travel')
    expect(localDeleteSessionMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({
      ok: true,
      deleted: false,
      hermes: { attempted: true, deleted: true, profile: 'travel', error: undefined },
    })
  })

  it('deletes a local coding-agent session without invoking Hermes CLI deletion', async () => {
    getSessionMock.mockReturnValue({
      id: 'codex-session',
      profile: 'default',
      source: 'coding_agent',
    })
    localDeleteSessionMock.mockReturnValue(true)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'codex-session' }, body: null }
    await mod.remove(ctx)

    expect(codingAgentRunManagerMock.stop).toHaveBeenCalledWith('codex-session', { reportClosed: false })
    expect(getExactSessionDetailFromDbWithProfileMock).not.toHaveBeenCalled()
    expect(deleteHermesSessionForProfileMock).not.toHaveBeenCalled()
    expect(localDeleteSessionMock).toHaveBeenCalledWith('codex-session')
    expect(ctx.body).toEqual({
      ok: true,
      deleted: true,
      hermes: { attempted: false, deleted: false, profile: 'default' },
    })
  })

  it('batch deletes sessions from their requested profiles', async () => {
    listUserProfilesMock.mockReturnValue([{ profile_name: 'default' }, { profile_name: 'travel' }])
    getSessionMock.mockImplementation((id: string) => ({
      id,
      profile: id === 'travel-session' ? 'travel' : 'default',
    }))
    getExactSessionDetailFromDbWithProfileMock.mockResolvedValue({ id: 'matched', messages: [] })
    deleteHermesSessionForProfileMock.mockResolvedValue(true)
    localDeleteSessionMock.mockReturnValue(true)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      request: {
        body: {
          sessions: [
            { id: 'default-session', profile: 'default' },
            { id: 'travel-session', profile: 'travel' },
          ],
        },
      },
      state: {
        user: { id: 1, role: 'admin' },
      },
      body: null,
    }
    await mod.batchRemove(ctx)

    expect(getExactSessionDetailFromDbWithProfileMock).toHaveBeenCalledWith('default-session', 'default')
    expect(getExactSessionDetailFromDbWithProfileMock).toHaveBeenCalledWith('travel-session', 'travel')
    expect(deleteHermesSessionForProfileMock).toHaveBeenCalledWith('default-session', 'default')
    expect(deleteHermesSessionForProfileMock).toHaveBeenCalledWith('travel-session', 'travel')
    expect(localDeleteSessionMock).toHaveBeenCalledWith('default-session')
    expect(localDeleteSessionMock).toHaveBeenCalledWith('travel-session')
    expect(ctx.body).toMatchObject({ ok: true, deleted: 2, failed: 0, hermesDeleted: 2 })
  })

  it('batch deletes local coding-agent sessions without invoking Hermes CLI deletion', async () => {
    getSessionMock.mockReturnValue({
      id: 'codex-session',
      profile: 'default',
      source: 'coding_agent',
    })
    localDeleteSessionMock.mockReturnValue(true)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      request: {
        body: {
          sessions: [{ id: 'codex-session', profile: 'default' }],
        },
      },
      body: null,
    }
    await mod.batchRemove(ctx)

    expect(codingAgentRunManagerMock.stop).toHaveBeenCalledWith('codex-session', { reportClosed: false })
    expect(getExactSessionDetailFromDbWithProfileMock).not.toHaveBeenCalled()
    expect(deleteHermesSessionForProfileMock).not.toHaveBeenCalled()
    expect(localDeleteSessionMock).toHaveBeenCalledWith('codex-session')
    expect(ctx.body).toMatchObject({ ok: true, deleted: 1, failed: 0, hermesDeleted: 0 })
  })

  it('imports a Hermes session into the local Web UI store', async () => {
    const hermesDetail = {
      id: 'cli-1',
      source: 'cli',
      user_id: null,
      model: 'gpt-5',
      title: 'CLI run',
      started_at: 100,
      ended_at: 200,
      end_reason: null,
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: null,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: '',
      preview: 'hello',
      last_active: 200,
      thread_session_count: 1,
      messages: [
        { id: 1, session_id: 'cli-1', role: 'user', content: 'hello', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 100, token_count: null, finish_reason: null, reasoning: null },
        { id: 2, session_id: 'cli-1', role: 'assistant', content: 'hi', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 101, token_count: null, finish_reason: null, reasoning: null, reasoning_details: { text: 'ok' } },
        { id: 3, session_id: 'cli-1', role: 'assistant', content: '', tool_call_id: null, tool_calls: [{ id: 'call-1', function: { name: 'read_file', arguments: { path: 'README.md' } } }], tool_name: null, timestamp: 102, token_count: null, finish_reason: 'tool_calls', reasoning: null },
        { id: 4, session_id: 'cli-1', role: 'tool', content: { ok: true }, tool_call_id: 'call-1', tool_calls: null, tool_name: 'read_file', timestamp: 103, token_count: null, finish_reason: null, reasoning: null },
        { id: 5, session_id: 'cli-1', role: 'tool', content: 'orphan', tool_call_id: null, tool_calls: null, tool_name: 'bad_tool', timestamp: 104, token_count: null, finish_reason: null, reasoning: null },
        { id: 6, session_id: 'cli-1', role: 'system', content: 'drop me', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 105, token_count: null, finish_reason: null, reasoning: null },
      ],
    }
    localGetSessionDetailMock.mockReturnValueOnce(null).mockReturnValueOnce({ ...hermesDetail, profile: 'travel' })
    getSessionDetailFromDbWithProfileMock.mockResolvedValue(hermesDetail)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'cli-1' }, query: { profile: 'travel' }, state: {}, body: null }

    await mod.importHermesSession(ctx)

    expect(getSessionDetailFromDbWithProfileMock).toHaveBeenCalledWith('cli-1', 'travel')
    expect(localCreateSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'cli-1',
      profile: 'travel',
      source: 'cli',
      model: 'gpt-default',
      provider: 'openai',
      title: 'CLI run',
    }))
    expect(localUpdateSessionMock).toHaveBeenCalledWith('cli-1', expect.objectContaining({
      source: 'cli',
      model: 'gpt-default',
      provider: 'openai',
    }))
    expect(localAddMessagesMock).toHaveBeenCalledWith([
      expect.objectContaining({ session_id: 'cli-1', role: 'user', content: 'hello', tool_calls: null }),
      expect.objectContaining({ session_id: 'cli-1', role: 'assistant', content: 'hi', reasoning_details: '{"text":"ok"}' }),
      expect.objectContaining({
        session_id: 'cli-1',
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
      }),
      expect.objectContaining({ session_id: 'cli-1', role: 'tool', content: '{"ok":true}', tool_call_id: 'call-1', tool_name: 'read_file' }),
    ])
    expect(localUpdateSessionStatsMock).toHaveBeenCalledWith('cli-1')
    expect(localUpdateSessionMock.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      last_active: expect.any(Number),
    }))
    expect(localUpdateSessionMock.mock.calls.at(-1)?.[1].last_active).toBeGreaterThan(200)
    expect(ctx.body).toMatchObject({ ok: true, imported: true })
  })

  describe('exportSession', () => {
    it('returns session as JSON download with correct headers (full mode)', async () => {
      const sessionData = { id: 'abc-123', title: 'Test Session', messages: [{ id: 1, role: 'user', content: 'hello' }] }
      localGetSessionDetailMock.mockReturnValue(sessionData)

      const mod = await import('../../packages/server/src/controllers/hermes/sessions')
      const setMock = vi.fn()
      const ctx: any = { params: { id: 'abc-123' }, query: {}, set: setMock, body: null }

      await mod.exportSession(ctx)

      expect(localGetSessionDetailMock).toHaveBeenCalledWith('abc-123')
      expect(setMock).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('abc-123'))
      expect(setMock).toHaveBeenCalledWith('Content-Type', 'application/json')
      expect(ctx.status).toBeUndefined()
      expect(JSON.parse(ctx.body)).toMatchObject({ id: 'abc-123', title: 'Test Session' })
    })

    it('returns full TXT export', async () => {
      const sessionData = {
        id: 'txt-123',
        title: 'Text Export',
        messages: [
          { id: 1, role: 'user', content: 'hello', timestamp: 1700000000 },
          { id: 2, role: 'assistant', content: 'hi', timestamp: 1700000001 },
        ],
      }
      localGetSessionDetailMock.mockReturnValue(sessionData)

      const mod = await import('../../packages/server/src/controllers/hermes/sessions')
      const setMock = vi.fn()
      const ctx: any = { params: { id: 'txt-123' }, query: { mode: 'full', ext: 'txt' }, set: setMock, body: null }

      await mod.exportSession(ctx)

      expect(setMock).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8')
      expect(ctx.body).toContain('# Text Export')
      expect(ctx.body).toContain('[user]')
      expect(ctx.body).toContain('hello')
      expect(ctx.body).toContain('[assistant]')
      expect(ctx.body).toContain('hi')
    })

    it('returns 404 when session not found', async () => {
      localGetSessionDetailMock.mockReturnValue(null)
      getSessionMock.mockResolvedValue(null)

      const mod = await import('../../packages/server/src/controllers/hermes/sessions')
      const ctx: any = { params: { id: 'not-found' }, query: {}, set: vi.fn(), body: null }

      await mod.exportSession(ctx)

      expect(ctx.status).toBe(404)
      expect(ctx.body).toEqual({ error: 'Session not found' })
    })

    it('falls back to CLI when DB query fails', async () => {
      const sessionData = { id: 'cli-123', title: 'CLI Session', messages: [] }
      localGetSessionDetailMock.mockReturnValue(sessionData)

      const mod = await import('../../packages/server/src/controllers/hermes/sessions')
      const setMock = vi.fn()
      const ctx: any = { params: { id: 'cli-123' }, query: {}, set: setMock, body: null }

      await mod.exportSession(ctx)

      expect(localGetSessionDetailMock).toHaveBeenCalledWith('cli-123')
      expect(JSON.parse(ctx.body)).toMatchObject({ id: 'cli-123' })
    })
  })
})
