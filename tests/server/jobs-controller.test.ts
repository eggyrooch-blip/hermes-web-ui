import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/services/gateway-bootstrap', () => ({
  getGatewayManagerInstance: () => ({
    getUpstream: () => 'http://127.0.0.1:8642',
    getApiKey: () => null,
  }),
}))

const getSessionMock = vi.hoisted(() => vi.fn())
// Partial mock: only getSession is stubbed — the controller (and the M-0
// executor path) still needs the module's other exports.
vi.mock('../../packages/server/src/db/hermes/session-store', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getSession: getSessionMock }
})

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// M-0 executor targeting: let the chat-plane profile resolver accept the owned
// agent profile without a real multitenancy SQLite DB in the test env.
vi.mock('../../packages/server/src/services/hermes/agent-ownership', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    ownerOwnsProfile: (openid: string, profileName: string) =>
      openid === 'ou_test_owner_a' && profileName === 'agent_prof',
  }
})

import { config } from '../../packages/server/src/config'
import { create, list, run, update } from '../../packages/server/src/controllers/hermes/jobs'

function createMockCtx(overrides: Record<string, any> = {}) {
  const ctx: any = {
    req: { method: 'PATCH' },
    request: { body: { name: 'renamed' } },
    params: { id: 'abc123abc123' },
    query: {},
    search: '',
    headers: {},
    state: {},
    status: 200,
    set: vi.fn(),
    body: null,
    ...overrides,
  }
  ctx.get = (name: string) => {
    const match = Object.entries(ctx.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
    const value = match?.[1]
    return Array.isArray(value) ? value[0] : value || ''
  }
  return ctx
}

describe('Hermes jobs controller proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    config.webPlane = 'both'
    config.webuiJobsBroker = false
    config.runBrokerUrl = ''
    config.runBrokerKey = ''
  })

  it('passes through upstream validation status and body instead of masking it as 502', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ error: 'Prompt must be ≤ 5000 characters' }),
    })

    const ctx = createMockCtx()
    await update(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Prompt must be ≤ 5000 characters' })
    expect(ctx.set).toHaveBeenCalledWith('Content-Type', 'application/json')
  })

  it('keeps real proxy connection failures as 502', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))

    const ctx = createMockCtx()
    await update(ctx)

    expect(ctx.status).toBe(502)
    expect(ctx.body).toEqual({ error: { message: 'Proxy error: ECONNREFUSED' } })
  })

  it('binds chat-plane job creation to the Feishu user and defaults delivery to Feishu', async () => {
    config.webPlane = 'chat'
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({
        job: {
          id: 'job1',
          name: 'user_a smoke',
          deliver: 'feishu',
          owner_open_id: 'ou_test_owner_a',
          owner_profile: 'user_a',
        },
      }),
    })

    const ctx = createMockCtx({
      req: { method: 'POST' },
      request: {
        body: {
          name: 'user_a smoke',
          schedule: '*/5 * * * *',
          prompt: 'ping',
          deliver: 'origin',
          owner_open_id: 'spoofed',
          profile: 'other',
        },
      },
      params: {},
      state: { user: { openid: 'ou_test_owner_a', profile: 'user_a', role: 'user' } },
    })

    await create(ctx)

    const [, options] = mockFetch.mock.calls[0]
    expect(options.headers['X-Hermes-Feishu-OpenId']).toBe('ou_test_owner_a')
    expect(JSON.parse(options.body)).toMatchObject({
      name: 'user_a smoke',
      schedule: '*/5 * * * *',
      prompt: 'ping',
      deliver: 'feishu',
      owner_open_id: 'ou_test_owner_a',
      owner_profile: 'user_a',
    })
    expect(JSON.parse(options.body).profile).toBeUndefined()
  })

  it('uses the multitenancy broker for chat-plane job creation when enabled', async () => {
    config.webPlane = 'chat'
    config.webuiJobsBroker = true
    config.runBrokerUrl = 'http://127.0.0.1:8766'
    config.runBrokerKey = 'broker-secret'
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({
        job: {
          id: 'job1',
          name: 'user_a smoke',
          deliver: 'feishu',
          owner_open_id: 'ou_test_owner_a',
          owner_profile: 'user_a',
        },
      }),
    })

    const ctx = createMockCtx({
      req: { method: 'POST' },
      request: {
        body: {
          name: 'user_a smoke',
          schedule: '*/5 * * * *',
          prompt: 'ping',
          deliver: 'origin',
          owner_open_id: 'spoofed',
          profile: 'other',
          api_key: 'secret',
        },
      },
      params: {},
      state: { user: { openid: 'ou_test_owner_a', profile: 'user_a', role: 'user' } },
    })

    await create(ctx)

    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8766/api/run-broker/jobs')
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer broker-secret',
      'X-Hermes-Profile': 'user_a',
      'X-Hermes-User-Key': 'ou_test_owner_a',
    })
    expect(JSON.parse(options.body)).toMatchObject({
      name: 'user_a smoke',
      schedule: '*/5 * * * *',
      prompt: 'ping',
      deliver: 'feishu',
      owner_open_id: 'ou_test_owner_a',
      owner_profile: 'user_a',
    })
    expect(JSON.parse(options.body).profile).toBeUndefined()
    expect(JSON.parse(options.body).api_key).toBeUndefined()
  })

  it('forwards the per-job model spec but strips provider/base_url on chat plane', async () => {
    config.webPlane = 'chat'
    config.webuiJobsBroker = true
    config.runBrokerUrl = 'http://127.0.0.1:8766'
    config.runBrokerKey = 'broker-secret'
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({
        job: { id: 'job3', model: 'custom:litellm-sre/deepseek-v4-flash' },
      }),
    })

    const ctx = createMockCtx({
      req: { method: 'POST' },
      request: {
        body: {
          name: 'cheap digest',
          schedule: '0 9 * * *',
          prompt: 'ping',
          model: 'custom:litellm-sre/deepseek-v4-flash',
          provider: 'forged-provider',
          base_url: 'http://evil.example',
        },
      },
      params: {},
      state: { user: { openid: 'ou_test_owner_a', profile: 'user_a', role: 'user' } },
    })

    await create(ctx)

    const [, options] = mockFetch.mock.calls[0]
    const body = JSON.parse(options.body)
    expect(body.model).toBe('custom:litellm-sre/deepseek-v4-flash')
    expect(body.provider).toBeUndefined()
    expect(body.base_url).toBeUndefined()
  })

  it('forwards expert_id and the ?profile= executor target to the broker (M-0)', async () => {
    // The scheduled-entry admission reads the source session before proxying;
    // this M-0 case is a plain executor create with no source session.
    getSessionMock.mockReturnValue(null)
    config.webPlane = 'chat'
    config.webuiJobsBroker = true
    config.runBrokerUrl = 'http://127.0.0.1:8766'
    config.runBrokerKey = 'broker-secret'
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({
        job: { id: 'job2', agent_id: 'agent-1', expert_id: 'hr-expert' },
      }),
    })

    const ctx = createMockCtx({
      req: { method: 'POST' },
      request: {
        body: {
          name: 'agent task',
          schedule: '*/5 * * * *',
          prompt: 'ping',
          expert_id: 'hr-expert',
          token: 'must-drop',
        },
      },
      params: {},
      query: { profile: 'agent_prof' },
      search: '?profile=agent_prof',
      state: { user: { openid: 'ou_test_owner_a', profile: 'user_a', role: 'user' } },
    })

    await create(ctx)

    const [url, options] = mockFetch.mock.calls[0]
    // The profile selector is consumed into the trusted header, not forwarded.
    expect(url).toBe('http://127.0.0.1:8766/api/run-broker/jobs')
    expect(options.headers).toMatchObject({
      'X-Hermes-Profile': 'agent_prof',
      'X-Hermes-User-Key': 'ou_test_owner_a',
    })
    const body = JSON.parse(options.body)
    // expert_id is NOT in CHAT_PLANE_BODY_BLOCKLIST — it must survive the BFF.
    expect(body.expert_id).toBe('hr-expert')
    expect(body.token).toBeUndefined()
    expect(body.owner_profile).toBe('agent_prof')
  })

  it('lists chat-plane jobs through the multitenancy broker without profile selectors', async () => {
    config.webPlane = 'chat'
    config.webuiJobsBroker = true
    config.runBrokerUrl = 'http://127.0.0.1:8766'
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ jobs: [] }),
    })

    const ctx = createMockCtx({
      req: { method: 'GET' },
      search: '?profile=other&token=secret&include_disabled=true',
      state: { user: { openid: 'ou_test_owner_a', profile: 'user_a', role: 'user' } },
    })

    await list(ctx)

    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8766/api/run-broker/jobs?include_disabled=true')
    expect(options.headers).toMatchObject({
      'X-Hermes-Profile': 'user_a',
      'X-Hermes-User-Key': 'ou_test_owner_a',
    })
  })

  it('routes chat-plane manual job runs through the multitenancy broker when enabled', async () => {
    config.webPlane = 'chat'
    config.webuiJobsBroker = true
    config.runBrokerUrl = 'http://127.0.0.1:8766'
    config.runBrokerKey = 'broker-secret'
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({
        job: {
          id: 'abc123abc123',
          state: 'scheduled',
          next_run_at: '2026-05-20T07:00:00Z',
        },
        queued: true,
      }),
    })

    const ctx = createMockCtx({
      req: { method: 'POST' },
      request: { body: {} },
      params: { id: 'abc123abc123' },
      state: { user: { openid: 'ou_test_owner_a', profile: 'user_a', role: 'user' } },
    })

    await run(ctx)

    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8766/api/run-broker/jobs/abc123abc123/run')
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer broker-secret',
      'X-Hermes-Profile': 'user_a',
      'X-Hermes-User-Key': 'ou_test_owner_a',
    })
    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({
      job: {
        id: 'abc123abc123',
        state: 'scheduled',
        next_run_at: '2026-05-20T07:00:00Z',
      },
      queued: true,
    })
  })

  it('binds scheduled expert creation to the trusted session and strips forged fields', async () => {
    config.webPlane = 'chat'
    config.webuiJobsBroker = true
    config.runBrokerUrl = 'http://127.0.0.1:8766'
    config.runBrokerKey = 'broker-secret'
    getSessionMock.mockReturnValue({
      id: 'session-expert',
      user_id: 'ou_test_owner_a',
      profile: 'user_a',
      source: 'cli',
      expert_id: 'keep-resource-delivery',
    })
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ job: { id: 'job1' } }),
    })
    const ctx = createMockCtx({
      req: { method: 'POST' },
      request: { body: {
        name: 'Daily delivery',
        schedule: '0 9 * * *',
        prompt: 'check queue',
        deliver: 'local',
        source_session_id: 'session-expert',
        expert_id: 'keep-resource-delivery',
        idempotency_key: 'schedule-key-1',
        owner_open_id: 'ou_victim',
        owner_profile: 'victim',
        profile: 'victim',
        source_app: 'cli_forged',
      } },
      params: {},
      state: { user: { openid: 'ou_test_owner_a', profile: 'user_a', role: 'user' } },
    })

    await create(ctx)

    const [, options] = mockFetch.mock.calls[0]
    expect(options.headers).toMatchObject({
      'X-Hermes-Owner-Open-Id': 'ou_test_owner_a',
      'X-Hermes-Profile': 'user_a',
      'X-Hermes-User-Key': 'ou_test_owner_a',
    })
    expect(JSON.parse(options.body)).toEqual({
      name: 'Daily delivery',
      schedule: '0 9 * * *',
      prompt: 'check queue',
      deliver: 'feishu',
      expert_id: 'keep-resource-delivery',
      idempotency_key: 'schedule-key-1',
    })
  })
})
