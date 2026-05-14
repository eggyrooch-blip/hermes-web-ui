import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/services/gateway-bootstrap', () => ({
  getGatewayManagerInstance: () => ({
    getUpstream: () => 'http://127.0.0.1:8642',
    getApiKey: () => null,
  }),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { config } from '../../packages/server/src/config'
import { create, list, update } from '../../packages/server/src/controllers/hermes/jobs'

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
          name: 'sunke smoke',
          deliver: 'feishu',
          owner_open_id: 'ou_cf23e7c262afa4b7a006baa75f863ed5',
          owner_profile: 'sunke',
        },
      }),
    })

    const ctx = createMockCtx({
      req: { method: 'POST' },
      request: {
        body: {
          name: 'sunke smoke',
          schedule: '*/5 * * * *',
          prompt: 'ping',
          deliver: 'origin',
          owner_open_id: 'spoofed',
          profile: 'other',
        },
      },
      params: {},
      state: { user: { openid: 'ou_cf23e7c262afa4b7a006baa75f863ed5', profile: 'sunke', role: 'user' } },
    })

    await create(ctx)

    const [, options] = mockFetch.mock.calls[0]
    expect(options.headers['X-Hermes-Feishu-OpenId']).toBe('ou_cf23e7c262afa4b7a006baa75f863ed5')
    expect(JSON.parse(options.body)).toMatchObject({
      name: 'sunke smoke',
      schedule: '*/5 * * * *',
      prompt: 'ping',
      deliver: 'feishu',
      owner_open_id: 'ou_cf23e7c262afa4b7a006baa75f863ed5',
      owner_profile: 'sunke',
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
          name: 'sunke smoke',
          deliver: 'feishu',
          owner_open_id: 'ou_cf23e7c262afa4b7a006baa75f863ed5',
          owner_profile: 'sunke',
        },
      }),
    })

    const ctx = createMockCtx({
      req: { method: 'POST' },
      request: {
        body: {
          name: 'sunke smoke',
          schedule: '*/5 * * * *',
          prompt: 'ping',
          deliver: 'origin',
          owner_open_id: 'spoofed',
          profile: 'other',
          api_key: 'secret',
        },
      },
      params: {},
      state: { user: { openid: 'ou_cf23e7c262afa4b7a006baa75f863ed5', profile: 'sunke', role: 'user' } },
    })

    await create(ctx)

    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8766/api/run-broker/jobs')
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer broker-secret',
      'X-Hermes-Profile': 'sunke',
      'X-Hermes-User-Key': 'ou_cf23e7c262afa4b7a006baa75f863ed5',
    })
    expect(JSON.parse(options.body)).toMatchObject({
      name: 'sunke smoke',
      schedule: '*/5 * * * *',
      prompt: 'ping',
      deliver: 'feishu',
      owner_open_id: 'ou_cf23e7c262afa4b7a006baa75f863ed5',
      owner_profile: 'sunke',
    })
    expect(JSON.parse(options.body).profile).toBeUndefined()
    expect(JSON.parse(options.body).api_key).toBeUndefined()
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
      state: { user: { openid: 'ou_cf23e7c262afa4b7a006baa75f863ed5', profile: 'sunke', role: 'user' } },
    })

    await list(ctx)

    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8766/api/run-broker/jobs?include_disabled=true')
    expect(options.headers).toMatchObject({
      'X-Hermes-Profile': 'sunke',
      'X-Hermes-User-Key': 'ou_cf23e7c262afa4b7a006baa75f863ed5',
    })
  })
})
