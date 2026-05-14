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
import { run } from '../../packages/server/src/controllers/hermes/jobs'

function createMockCtx(overrides: Record<string, any> = {}) {
  const ctx: any = {
    req: { method: 'POST' },
    request: { body: {} },
    params: { id: 'abc123abc123' },
    query: {},
    search: '',
    headers: {},
    state: { user: { openid: 'ou_test', profile: 'sunke', role: 'user' } },
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

describe('Hermes jobs execution boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    config.webPlane = 'chat'
  })

  it('blocks chat-plane manual job run instead of executing through profile apiserver', async () => {
    const ctx = createMockCtx()

    await run(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({
      error: {
        message: 'Manual job execution must go through the multitenancy sandbox path',
        code: 'sandbox_required',
      },
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
