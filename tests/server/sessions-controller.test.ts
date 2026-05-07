import { beforeEach, describe, expect, it, vi } from 'vitest'

const listConversationSummariesFromDbMock = vi.fn()
const getConversationDetailFromDbMock = vi.fn()
const listConversationSummariesMock = vi.fn()
const getConversationDetailMock = vi.fn()
const listSessionSummariesMock = vi.fn()
const searchSessionSummariesMock = vi.fn()
const getSessionDetailFromDbMock = vi.fn()
const getUsageStatsFromDbMock = vi.fn()
const listSessionsMock = vi.fn()
const getSessionMock = vi.fn()
const getGroupChatServerMock = vi.fn()
const getLocalUsageStatsMock = vi.fn()
const getActiveProfileNameMock = vi.fn()
const loggerWarnMock = vi.fn()
const getCompressionSnapshotMock = vi.fn()

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
  listSessions: listSessionsMock,
  getSession: getSessionMock,
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  listSessionSummaries: listSessionSummariesMock,
  searchSessionSummaries: searchSessionSummariesMock,
  getSessionDetailFromDb: getSessionDetailFromDbMock,
  getUsageStatsFromDb: getUsageStatsFromDbMock,
}))

// Mock useLocalSessionStore to return false so we test the CLI path
vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  useLocalSessionStore: () => false,
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

vi.mock('../../packages/server/src/services/gateway-bootstrap', () => ({
  getGatewayManagerInstance: () => null,
}))

describe('session conversations controller', () => {
  beforeEach(() => {
    vi.resetModules()
    listConversationSummariesFromDbMock.mockReset()
    getConversationDetailFromDbMock.mockReset()
    listConversationSummariesMock.mockReset()
    getConversationDetailMock.mockReset()
    listSessionSummariesMock.mockReset()
    searchSessionSummariesMock.mockReset()
    getSessionDetailFromDbMock.mockReset()
    getUsageStatsFromDbMock.mockReset()
    listSessionsMock.mockReset()
    getSessionMock.mockReset()
    getGroupChatServerMock.mockReset()
    getGroupChatServerMock.mockReturnValue(null)
    getLocalUsageStatsMock.mockReset()
    getActiveProfileNameMock.mockReset()
    getActiveProfileNameMock.mockReturnValue('default')
    loggerWarnMock.mockReset()
    delete process.env.HERMES_WEB_PLANE
    getCompressionSnapshotMock.mockReset()
  })

  it('prefers the DB-backed conversations summary path', async () => {
    listConversationSummariesFromDbMock.mockResolvedValue([{ id: 'db-conversation' }])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { humanOnly: 'true', limit: '5' }, body: null }
    await mod.listConversations(ctx)

    expect(listConversationSummariesFromDbMock).toHaveBeenCalledWith({ source: undefined, humanOnly: true, limit: 5 })
    expect(listConversationSummariesMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ sessions: [{ id: 'db-conversation' }] })
  })

  it('falls back to the CLI-export conversations summary path when the DB query fails', async () => {
    listConversationSummariesFromDbMock.mockRejectedValue(new Error('db unavailable'))
    listConversationSummariesMock.mockResolvedValue([{ id: 'fallback-conversation' }])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { humanOnly: 'false' }, body: null }
    await mod.listConversations(ctx)

    expect(loggerWarnMock).toHaveBeenCalled()
    expect(listConversationSummariesMock).toHaveBeenCalledWith({ source: undefined, humanOnly: false, limit: undefined })
    expect(ctx.body).toEqual({ sessions: [{ id: 'fallback-conversation' }] })
  })

  it('prefers the DB-backed conversation detail path', async () => {
    getConversationDetailFromDbMock.mockResolvedValue({ session_id: 'root', messages: [], visible_count: 0, thread_session_count: 1 })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'root' }, query: { humanOnly: 'true' }, body: null }
    await mod.getConversationMessages(ctx)

    expect(getConversationDetailFromDbMock).toHaveBeenCalledWith('root', { source: undefined, humanOnly: true })
    expect(getConversationDetailMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ session_id: 'root', messages: [], visible_count: 0, thread_session_count: 1 })
  })

  it('falls back to the CLI-export conversation detail path when the DB query throws', async () => {
    getConversationDetailFromDbMock.mockRejectedValue(new Error('db unavailable'))
    getConversationDetailMock.mockResolvedValue({ session_id: 'root', messages: [{ id: 1 }], visible_count: 1, thread_session_count: 1 })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'root' }, query: { humanOnly: 'false' }, body: null }
    await mod.getConversationMessages(ctx)

    expect(loggerWarnMock).toHaveBeenCalled()
    expect(getConversationDetailMock).toHaveBeenCalledWith('root', { source: undefined, humanOnly: false })
    expect(ctx.body).toEqual({ session_id: 'root', messages: [{ id: 1 }], visible_count: 1, thread_session_count: 1 })
  })

  it('lists Hermes sessions from the request-bound profile in chat plane', async () => {
    process.env.HERMES_WEB_PLANE = 'chat'
    listSessionSummariesMock.mockResolvedValue([{ id: 'bound-session', source: 'feishu' }])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: {},
      state: { user: { openid: 'ou_test', profile: 'g41a5b5g', role: 'user' } },
      get: () => '',
      body: null,
    }
    await mod.listHermesSessions(ctx)

    expect(listSessionSummariesMock).toHaveBeenCalledWith(undefined, 2000, 'g41a5b5g')
    expect(listSessionsMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ sessions: [{ id: 'bound-session', source: 'feishu' }] })
  })

  it('keeps API Server chat sessions visible in chat-plane history', async () => {
    process.env.HERMES_WEB_PLANE = 'chat'
    listSessionSummariesMock.mockResolvedValue([
      { id: 'web-chat', source: 'api_server' },
      { id: 'feishu-chat', source: 'feishu' },
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: {},
      state: { user: { openid: 'ou_test', profile: 'g41a5b5g', role: 'user' } },
      get: () => '',
      body: null,
    }
    await mod.listHermesSessions(ctx)

    expect(listSessionSummariesMock).toHaveBeenCalledWith(undefined, 2000, 'g41a5b5g')
    expect(ctx.body).toEqual({
      sessions: [
        { id: 'web-chat', source: 'api_server' },
        { id: 'feishu-chat', source: 'feishu' },
      ],
    })
  })

  it('does not fall back to active-profile CLI sessions for chat-plane Hermes history', async () => {
    process.env.HERMES_WEB_PLANE = 'chat'
    listSessionSummariesMock.mockRejectedValue(new Error('bound state missing'))

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: {},
      state: { user: { openid: 'ou_test', profile: 'g41a5b5g', role: 'user' } },
      get: () => '',
      body: null,
    }
    await mod.listHermesSessions(ctx)

    expect(listSessionsMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ sessions: [] })
  })

  it('loads Hermes session detail from the request-bound profile in chat plane', async () => {
    process.env.HERMES_WEB_PLANE = 'chat'
    getSessionDetailFromDbMock.mockResolvedValue({ id: 'bound-session', source: 'feishu', messages: [] })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      params: { id: 'bound-session' },
      state: { user: { openid: 'ou_test', profile: 'g41a5b5g', role: 'user' } },
      get: () => '',
      body: null,
    }
    await mod.getHermesSession(ctx)

    expect(getSessionDetailFromDbMock).toHaveBeenCalledWith('bound-session', 'g41a5b5g')
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ session: { id: 'bound-session', source: 'feishu', messages: [] } })
  })

  it('loads API Server chat session detail in chat-plane history', async () => {
    process.env.HERMES_WEB_PLANE = 'chat'
    getSessionDetailFromDbMock.mockResolvedValue({ id: 'web-chat', source: 'api_server', messages: [] })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      params: { id: 'web-chat' },
      state: { user: { openid: 'ou_test', profile: 'g41a5b5g', role: 'user' } },
      get: () => '',
      body: null,
    }
    await mod.getHermesSession(ctx)

    expect(getSessionDetailFromDbMock).toHaveBeenCalledWith('web-chat', 'g41a5b5g')
    expect(ctx.body).toEqual({ session: { id: 'web-chat', source: 'api_server', messages: [] } })
  })

  it('searches Hermes sessions in the request-bound profile in chat plane', async () => {
    process.env.HERMES_WEB_PLANE = 'chat'
    searchSessionSummariesMock.mockResolvedValue([{ id: 'match', source: 'webui' }])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: { q: 'hello', source: 'webui', limit: '7' },
      state: { user: { openid: 'ou_test', profile: 'g41a5b5g', role: 'user' } },
      get: () => '',
      body: null,
    }
    await mod.search(ctx)

    expect(searchSessionSummariesMock).toHaveBeenCalledWith('hello', 'webui', 7, 'g41a5b5g')
    expect(ctx.body).toEqual({ results: [{ id: 'match', source: 'webui' }] })
  })

  it('merges native state.db usage analytics with local Web UI usage for the requested period', async () => {
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
    const ctx: any = { query: { days: '2' }, state: {}, get: () => '', body: null }
    await mod.usageStats(ctx)

    expect(getLocalUsageStatsMock).toHaveBeenCalledWith('default', 2)
    expect(getUsageStatsFromDbMock).toHaveBeenCalledWith(2, expect.any(Number), undefined, false)
    expect(ctx.body).toMatchObject({
      total_input_tokens: 30,
      total_output_tokens: 15,
      total_cache_read_tokens: 6,
      total_cache_write_tokens: 3,
      total_reasoning_tokens: 9,
      total_sessions: 3,
      total_cost: 0.02,
      total_api_calls: 7,
      period_days: 2,
    })
    expect(ctx.body.model_usage).toEqual([
      { model: 'hermes-model', input_tokens: 20, output_tokens: 10, cache_read_tokens: 4, cache_write_tokens: 2, reasoning_tokens: 6, sessions: 2 },
      { model: 'local-model', input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 1, reasoning_tokens: 3, sessions: 1 },
    ])
    expect(ctx.body.daily_usage.find((row: any) => row.date === today)).toMatchObject({
      input_tokens: 30,
      output_tokens: 15,
      cache_read_tokens: 6,
      cache_write_tokens: 3,
      sessions: 3,
      cost: 0.02,
    })
  })

  it('includes API Server usage from the request-bound profile in chat plane', async () => {
    process.env.HERMES_WEB_PLANE = 'chat'
    getLocalUsageStatsMock.mockReturnValue({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      sessions: 0,
      by_model: [],
      by_day: [],
    })
    getUsageStatsFromDbMock.mockResolvedValue({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      sessions: 2,
      cost: 0.12,
      total_api_calls: 3,
      by_model: [
        { model: 'glm-5.1', input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, sessions: 2 },
      ],
      by_day: [],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: { days: '30' },
      state: { user: { openid: 'ou_test', profile: 'g41a5b5g', role: 'user' } },
      get: () => '',
      body: null,
    }
    await mod.usageStats(ctx)

    expect(getLocalUsageStatsMock).toHaveBeenCalledWith('g41a5b5g', 30)
    expect(getUsageStatsFromDbMock).toHaveBeenCalledWith(30, expect.any(Number), 'g41a5b5g', true)
    expect(ctx.body).toMatchObject({
      total_input_tokens: 100,
      total_output_tokens: 50,
      total_sessions: 2,
      total_cost: 0,
    })
  })

  describe('exportSession', () => {
    it('returns session as JSON download with correct headers (full mode)', async () => {
      const sessionData = { id: 'abc-123', title: 'Test Session', messages: [{ id: 1, role: 'user', content: 'hello' }] }
      getSessionDetailFromDbMock.mockResolvedValue(sessionData)

      const mod = await import('../../packages/server/src/controllers/hermes/sessions')
      const setMock = vi.fn()
      const ctx: any = { params: { id: 'abc-123' }, query: {}, set: setMock, body: null }

      await mod.exportSession(ctx)

      expect(getSessionDetailFromDbMock).toHaveBeenCalledWith('abc-123')
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
      getSessionDetailFromDbMock.mockResolvedValue(sessionData)

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
      getSessionDetailFromDbMock.mockResolvedValue(null)
      getSessionMock.mockResolvedValue(null)

      const mod = await import('../../packages/server/src/controllers/hermes/sessions')
      const ctx: any = { params: { id: 'not-found' }, query: {}, set: vi.fn(), body: null }

      await mod.exportSession(ctx)

      expect(ctx.status).toBe(404)
      expect(ctx.body).toEqual({ error: 'Session not found' })
    })

    it('falls back to CLI when DB query fails', async () => {
      const sessionData = { id: 'cli-123', title: 'CLI Session', messages: [] }
      getSessionDetailFromDbMock.mockRejectedValue(new Error('db unavailable'))
      getSessionMock.mockResolvedValue(sessionData)

      const mod = await import('../../packages/server/src/controllers/hermes/sessions')
      const setMock = vi.fn()
      const ctx: any = { params: { id: 'cli-123' }, query: {}, set: setMock, body: null }

      await mod.exportSession(ctx)

      expect(getSessionMock).toHaveBeenCalledWith('cli-123')
      expect(JSON.parse(ctx.body)).toMatchObject({ id: 'cli-123' })
    })
  })
})
