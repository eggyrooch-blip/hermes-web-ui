import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

async function loadController() {
  vi.resetModules()
  process.env = {
    ...originalEnv,
    HERMES_RUN_BROKER_URL: 'http://broker.test',
    HERMES_RUN_BROKER_KEY: 'broker-key',
  }
  return import('../../packages/server/src/controllers/mcp-oauth-approval')
}

function context(user?: { openid?: string; profile?: string }, requestId = 'hma_request') {
  return {
    state: user ? { user } : {},
    request: {
      body: {
        request_id: requestId,
        profile_name: 'victim',
        subject_id: 'victim',
      },
    },
    params: { requestId },
    origin: 'http://webui.test',
    get: (name: string) => name.toLowerCase() === 'origin' ? 'http://webui.test' : '',
    is: (type: string) => type === 'application/json' ? 'application/json' : false,
    status: 200,
    body: undefined as unknown,
  } as any
}

describe('MCP OAuth WebUI approval', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    process.env = originalEnv
  })

  it('approves with only the verified session owner and profile', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        ok: true,
        redirect_url: 'http://127.0.0.1:7777/callback?code=redacted',
        access_token: 'must-not-cross',
      }),
    })
    const { approveMcpOAuth } = await loadController()
    const ctx = context({ openid: 'ou_alice', profile: 'alice' })
    await approveMcpOAuth(ctx)

    const [url, init] = fetchMock.mock.calls[0] as [string, any]
    expect(url).toBe('http://broker.test/api/run-broker/connectors/mcp-oauth/approve')
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer broker-key',
      'X-Hermes-Owner-Open-Id': 'ou_alice',
      'X-Hermes-Profile': 'alice',
    })
    expect(JSON.parse(init.body)).toEqual({ request_id: 'hma_request' })
    expect(ctx.body).toEqual({
      ok: true,
      redirect_url: 'http://127.0.0.1:7777/callback?code=redacted',
    })
    expect(JSON.stringify(ctx.body)).not.toContain('must-not-cross')
  })

  it('loads display-only client metadata before consent', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        client_id: 'cursor-local',
        client_name: 'Cursor',
        redirect_origin: 'http://127.0.0.1:7777',
        scopes: ['mcp:tools'],
        access_token: 'must-not-cross',
      }),
    })
    const { getMcpOAuthRequest } = await loadController()
    const ctx = context({ openid: 'ou_alice', profile: 'alice' })
    await getMcpOAuthRequest(ctx)

    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://broker.test/api/run-broker/connectors/mcp-oauth/requests/hma_request',
    )
    expect(ctx.body).toEqual({
      client_id: 'cursor-local',
      client_name: 'Cursor',
      redirect_origin: 'http://127.0.0.1:7777/',
      scopes: ['mcp:tools'],
    })
    expect(JSON.stringify(ctx.body)).not.toContain('must-not-cross')
  })

  it.each([
    ['cross-site', 'https://evil.test', 'application/json'],
    ['non-json', 'http://webui.test', 'text/plain'],
  ])('rejects %s consent before the broker boundary', async (_label, origin, contentType) => {
    const { approveMcpOAuth } = await loadController()
    const ctx = context({ openid: 'ou_alice', profile: 'alice' })
    ctx.get = () => origin
    ctx.is = () => contentType === 'application/json' ? 'application/json' : false
    await approveMcpOAuth(ctx)
    expect(ctx.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a non-http callback returned by the broker', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ ok: true, redirect_url: 'javascript:alert(1)' }),
    })
    const { approveMcpOAuth } = await loadController()
    const ctx = context({ openid: 'ou_alice', profile: 'alice' })
    await approveMcpOAuth(ctx)
    expect(ctx.status).toBe(502)
  })

  it('does not reflect an unexpected broker status', async () => {
    fetchMock.mockResolvedValue({ status: 418, ok: false, json: async () => ({}) })
    const { approveMcpOAuth } = await loadController()
    const ctx = context({ openid: 'ou_alice', profile: 'alice' })
    await approveMcpOAuth(ctx)
    expect(ctx.status).toBe(502)
  })

  it.each([
    ['missing user', undefined],
    ['missing owner', { profile: 'alice' }],
    ['missing profile', { openid: 'ou_alice' }],
  ])('fails closed for %s', async (_label, user) => {
    const { approveMcpOAuth } = await loadController()
    const ctx = context(user)
    await approveMcpOAuth(ctx)
    expect(ctx.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects malformed request ids before the broker boundary', async () => {
    const { approveMcpOAuth } = await loadController()
    for (const value of ['', 'not-a-request', `hma_${'x'.repeat(200)}`]) {
      const ctx = context({ openid: 'ou_alice', profile: 'alice' }, value)
      await approveMcpOAuth(ctx)
      expect(ctx.status).toBe(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
