import { afterEach, describe, expect, it, vi } from 'vitest'

describe('Feishu link preview BFF', () => {
  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('forwards only the trusted actor and selected owned profile to Run Broker', async () => {
    const upstream = {
      previews: [{
        kind: 'wiki',
        title: '跨租户规划',
        type_label: '知识库文档',
        url: 'https://acme.feishu.cn/wiki/token',
        status: 'resolved',
      }],
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(upstream), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    vi.doMock('../../packages/server/src/config', () => ({
      config: { runBrokerUrl: 'http://127.0.0.1:8766', runBrokerKey: 'broker-secret' },
    }))
    vi.doMock('../../packages/server/src/services/request-context', () => ({
      isChatPlaneRequest: vi.fn(() => true),
    }))
    vi.doMock('../../packages/server/src/services/hermes/agent-ownership', () => ({
      ownerOwnsProfile: vi.fn(() => true),
      resolveAccessibleProfileAgentId: vi.fn(() => 'agent-owner'),
    }))

    const { previewFeishuLinks } = await import('../../packages/server/src/controllers/hermes/link-previews')
    const ctx: any = {
      state: { user: { openid: 'ou_owner', profile: 'owner' } },
      request: {
        body: {
          profile_name: 'owner',
          owner: 'ou_forged',
          tenant: 'keep',
          urls: ['https://acme.feishu.cn/wiki/token'],
        },
      },
      status: 0,
      body: undefined,
    }

    await previewFeishuLinks(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual(upstream)
    const [target, init] = fetchMock.mock.calls[0]
    expect(String(target)).toBe('http://127.0.0.1:8766/api/run-broker/link-previews')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer broker-secret',
      'X-Hermes-Owner-Open-Id': 'ou_owner',
      'X-Hermes-Agent-Id': 'agent-owner',
    })
    expect(init.body).toBe(JSON.stringify({
      profile_name: 'owner',
      urls: ['https://acme.feishu.cn/wiki/token'],
    }))
  })

  it('fails closed before Broker access for another owner profile', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.doMock('../../packages/server/src/config', () => ({
      config: { runBrokerUrl: 'http://127.0.0.1:8766', runBrokerKey: 'broker-secret' },
    }))
    vi.doMock('../../packages/server/src/services/request-context', () => ({
      isChatPlaneRequest: vi.fn(() => true),
    }))
    vi.doMock('../../packages/server/src/services/hermes/agent-ownership', () => ({
      ownerOwnsProfile: vi.fn(() => false),
      resolveAccessibleProfileAgentId: vi.fn(),
    }))
    const { previewFeishuLinks } = await import('../../packages/server/src/controllers/hermes/link-previews')
    const ctx: any = {
      state: { user: { openid: 'ou_owner', profile: 'owner' } },
      request: { body: { profile_name: 'other', urls: ['https://acme.feishu.cn/wiki/token'] } },
    }

    await previewFeishuLinks(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'link preview identity unavailable' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps broker auth failures to unavailable instead of logging the browser out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })))
    vi.doMock('../../packages/server/src/config', () => ({
      config: { runBrokerUrl: 'http://127.0.0.1:8766', runBrokerKey: 'broker-secret' },
    }))
    vi.doMock('../../packages/server/src/services/request-context', () => ({ isChatPlaneRequest: vi.fn(() => true) }))
    vi.doMock('../../packages/server/src/services/hermes/agent-ownership', () => ({
      ownerOwnsProfile: vi.fn(() => true),
      resolveAccessibleProfileAgentId: vi.fn(() => 'agent-owner'),
    }))
    const { previewFeishuLinks } = await import('../../packages/server/src/controllers/hermes/link-previews')
    const ctx: any = {
      state: { user: { openid: 'ou_owner', profile: 'owner' } },
      request: { body: { profile_name: 'owner', urls: ['https://acme.feishu.cn/wiki/token'] } },
    }

    await previewFeishuLinks(ctx)

    expect(ctx.status).toBe(503)
  })

  it('drops broker preview items that were not requested or are malformed', async () => {
    const requested = 'https://acme.feishu.cn/wiki/token'
    const payload = { previews: [
      { kind: 'wiki', title: 'Valid', type_label: '知识库文档', url: requested, status: 'resolved' },
      { kind: 'wiki', title: 'Injected', type_label: '文档', url: 'javascript:alert(1)', status: 'resolved' },
      { kind: 'wiki', title: 'Bad status', type_label: '文档', url: requested, status: 'unknown' },
    ] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
    vi.doMock('../../packages/server/src/config', () => ({
      config: { runBrokerUrl: 'http://127.0.0.1:8766', runBrokerKey: 'broker-secret' },
    }))
    vi.doMock('../../packages/server/src/services/request-context', () => ({ isChatPlaneRequest: vi.fn(() => true) }))
    vi.doMock('../../packages/server/src/services/hermes/agent-ownership', () => ({
      ownerOwnsProfile: vi.fn(() => true),
      resolveAccessibleProfileAgentId: vi.fn(() => 'agent-owner'),
    }))
    const { previewFeishuLinks } = await import('../../packages/server/src/controllers/hermes/link-previews')
    const ctx: any = {
      state: { user: { openid: 'ou_owner', profile: 'owner' } },
      request: { body: { profile_name: 'owner', urls: [requested] } },
    }

    await previewFeishuLinks(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.previews).toEqual([payload.previews[0]])
  })
})
