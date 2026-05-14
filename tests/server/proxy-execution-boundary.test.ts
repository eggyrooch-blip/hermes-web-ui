import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/services/gateway-bootstrap', () => ({
  getGatewayManagerInstance: () => ({
    getUpstream: () => 'http://127.0.0.1:8655',
    getApiKey: () => null,
  }),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { config } from '../../packages/server/src/config'
import { proxy } from '../../packages/server/src/routes/hermes/proxy-handler'

function createMockCtx(overrides: Record<string, any> = {}) {
  const ctx: any = {
    path: '/v1/responses',
    method: 'POST',
    req: { method: 'POST' },
    request: { body: { input: 'hello' } },
    query: {},
    search: '',
    headers: {},
    state: { user: { openid: 'ou_test', profile: 'sunke', role: 'user' } },
    status: 200,
    set: vi.fn(),
    body: null,
    res: { on: vi.fn(), off: vi.fn(), removeListener: vi.fn(), write: vi.fn(), end: vi.fn() },
    ...overrides,
  }
  ctx.get = (name: string) => {
    const match = Object.entries(ctx.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
    const value = match?.[1]
    return Array.isArray(value) ? value[0] : value || ''
  }
  return ctx
}

describe('Hermes proxy execution boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    config.webPlane = 'chat'
  })

  it('blocks chat-plane POST /v1/responses instead of proxying agent execution to profile apiserver', async () => {
    const ctx = createMockCtx()

    await proxy(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({
      error: {
        message: 'Executable Hermes runs must go through the multitenancy sandbox path',
        code: 'sandbox_required',
      },
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('still allows chat-plane read-only response retrieval through the proxy', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ id: 'resp_1' }),
    })
    const ctx = createMockCtx({
      path: '/v1/responses/resp_1',
      method: 'GET',
      req: { method: 'GET' },
      request: { body: undefined },
    })

    await proxy(ctx)

    expect(ctx.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledOnce()
  })
})
