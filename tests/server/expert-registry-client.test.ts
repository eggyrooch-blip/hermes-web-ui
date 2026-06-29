import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/config', () => ({
  config: { runBrokerUrl: 'http://broker.test', runBrokerKey: 'k-test' },
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const SERVICE = '../../packages/server/src/services/hermes/expert-registry-client'
const CONTROLLER = '../../packages/server/src/controllers/hermes/experts'

function mockImageResponse(body = new Uint8Array([1, 2, 3])) {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name: string) {
        const key = name.toLowerCase()
        if (key === 'content-type') return 'image/png'
        if (key === 'cache-control') return 'public, max-age=3600'
        return null
      },
    },
    arrayBuffer: async () => body.buffer,
  }
}

function mockCtx(params: Record<string, string>) {
  const headers: Record<string, string> = {}
  return {
    params,
    query: { profile: 'sunke' },
    state: { user: { openid: 'ou_1', profile: 'sunke', role: 'user' } },
    status: 200,
    body: undefined as any,
    get: vi.fn((name: string) => (name.toLowerCase() === 'x-hermes-profile' ? 'sunke' : '')),
    set: vi.fn((key: string, value: string) => {
      headers[key] = value
    }),
    headers,
  } as any
}

describe('expert registry client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rewrites broker plugin asset URLs to browser-loadable WebUI URLs', async () => {
    const { mapExpertRow } = await import(SERVICE)

    const row = mapExpertRow({
      id: 'kep',
      name: '资源投放专家',
      avatar: '/api/run-broker/plugin-assets/keep-resource-delivery/kep.png',
    })

    expect(row.avatar).toBe('/api/hermes/plugin-assets/keep-resource-delivery/kep.png')
  })

  it('does not rewrite nested broker asset paths that the WebUI route cannot proxy', async () => {
    const { mapExpertRow } = await import(SERVICE)

    const row = mapExpertRow({
      id: 'kep',
      name: '资源投放专家',
      avatar: '/api/run-broker/plugin-assets/keep-resource-delivery/nested/kep.png',
    })

    expect(row.avatar).toBe('/api/run-broker/plugin-assets/keep-resource-delivery/nested/kep.png')
  })

  it('fetchExpertCatalog returns rewritten avatar URLs and sends broker auth', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        profile_name: 'sunke',
        experts: [
          {
            id: 'kep',
            name: '资源投放专家',
            avatar: '/api/run-broker/plugin-assets/keep-resource-delivery/kep.png',
          },
        ],
      }),
    })
    const { fetchExpertCatalog } = await import(SERVICE)

    const result = await fetchExpertCatalog({ profileName: 'sunke', userKey: 'ou_1' })

    expect(result.experts[0].avatar).toBe('/api/hermes/plugin-assets/keep-resource-delivery/kep.png')
    const [url, init] = (globalThis.fetch as any).mock.calls[0]
    expect(url).toContain('/api/run-broker/experts')
    expect(url).toContain('profile_name=sunke')
    expect(url).toContain('user_key=ou_1')
    expect(init.headers.Authorization).toBe('Bearer k-test')
  })
})

describe('expert asset controller', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('proxies a registered broker image asset with server-side broker auth', async () => {
    ;(globalThis.fetch as any).mockResolvedValue(mockImageResponse())
    const { asset } = await import(CONTROLLER)
    const ctx = mockCtx({ pluginId: 'keep-resource-delivery', assetName: 'kep.png' })

    await asset(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.set).toHaveBeenCalledWith('Content-Type', 'image/png')
    expect(ctx.set).toHaveBeenCalledWith('Cache-Control', 'public, max-age=3600')
    expect(Buffer.isBuffer(ctx.body)).toBe(true)
    const [url, init] = (globalThis.fetch as any).mock.calls[0]
    expect(url).toBe('http://broker.test/api/run-broker/plugin-assets/keep-resource-delivery/kep.png?profile_name=sunke&user_key=ou_1')
    expect(init.headers.Authorization).toBe('Bearer k-test')
    expect(init.headers['X-Hermes-Profile']).toBe('sunke')
    expect(init.headers['X-Hermes-User-Key']).toBe('ou_1')
  })

  it('rejects unsafe asset path components before touching the broker', async () => {
    const { asset } = await import(CONTROLLER)
    const ctx = mockCtx({ pluginId: 'keep-resource-delivery', assetName: '../secret.png' })

    await asset(ctx)

    expect(ctx.status).toBe(404)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('rejects non-image broker responses', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/plain' },
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    })
    const { asset } = await import(CONTROLLER)
    const ctx = mockCtx({ pluginId: 'keep-resource-delivery', assetName: 'kep.png' })

    await asset(ctx)

    expect(ctx.status).toBe(502)
  })
})
