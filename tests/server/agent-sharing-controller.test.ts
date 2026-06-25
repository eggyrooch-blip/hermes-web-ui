import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('agent sharing controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('proxies owner share grants to the Run Broker with the verified Feishu actor', async () => {
    process.env.HERMES_RUN_BROKER_URL = 'http://broker.test'
    process.env.HERMES_RUN_BROKER_KEY = 'broker-key'
    vi.resetModules()
    const fetchMock = vi.fn(async (url: string, options: any) => {
      expect(url).toBe('http://broker.test/api/run-broker/agents/agent-shared/shares')
      expect(options.method).toBe('POST')
      expect(options.headers.Authorization).toBe('Bearer broker-key')
      expect(options.headers['X-Hermes-Owner-Open-Id']).toBe('ou_owner')
      expect(JSON.parse(options.body)).toEqual({
        grantee_open_id: 'ou_editor',
        role: 'editor',
      })
      return new Response(JSON.stringify({
        share: {
          agent_id: 'agent-shared',
          grantee_open_id: 'ou_editor',
          role: 'editor',
          status: 'active',
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { grantShare } = await import('../../packages/server/src/controllers/hermes/agents')
    const ctx: any = {
      params: { agentId: 'agent-shared' },
      state: { user: { openid: 'ou_owner' } },
      request: { body: { granteeOpenId: 'ou_editor', role: 'editor' } },
      status: 200,
      body: undefined,
    }

    await grantShare(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.share.role).toBe('editor')
  })

  it('forwards canonical Feishu actor identity and grantee lookup payloads to the Run Broker', async () => {
    process.env.HERMES_RUN_BROKER_URL = 'http://broker.test'
    process.env.HERMES_RUN_BROKER_KEY = 'broker-key'
    process.env.FEISHU_APP_ID = 'cli_web'
    vi.resetModules()
    const fetchMock = vi.fn(async (url: string, options: any) => {
      expect(url).toBe('http://broker.test/api/run-broker/agents/agent-shared/shares')
      expect(options.method).toBe('POST')
      expect(options.headers.Authorization).toBe('Bearer broker-key')
      expect(options.headers['X-Hermes-Owner-Open-Id']).toBe('ou_owner')
      expect(options.headers['X-Hermes-Actor-Provider']).toBe('feishu')
      expect(options.headers['X-Hermes-Actor-Tenant-Key']).toBe('tenant_a')
      expect(options.headers['X-Hermes-Actor-App-Id']).toBe('cli_web')
      expect(options.headers['X-Hermes-Actor-User-Id']).toBe('u_owner')
      expect(options.headers['X-Hermes-Actor-Display-Name']).toBe('Owner User')
      expect(options.headers['X-Hermes-Actor-Avatar-Url']).toBe('https://example.test/owner.png')
      expect(options.headers['X-Hermes-Actor-Email']).toBe('owner@example.test')
      expect(JSON.parse(options.body)).toEqual({
        grantee: {
          provider: 'feishu',
          type: 'email',
          value: 'editor@example.test',
        },
        role: 'manager',
      })
      return new Response(JSON.stringify({
        share: {
          share_id: 'shr_123',
          grantee_principal_id: 'prn_editor',
          role: 'manager',
          status: 'active',
          principal: {
            provider: 'feishu',
            display_name: 'Editor User',
            avatar_url: 'https://example.test/editor.png',
            email: 'editor@example.test',
            user_id: 'u_editor',
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { grantShare } = await import('../../packages/server/src/controllers/hermes/agents')
    const ctx: any = {
      params: { agentId: 'agent-shared' },
      state: {
        user: {
          openid: 'ou_owner',
          userId: 'u_owner',
          tenantKey: 'tenant_a',
          appId: 'cli_web',
          name: 'Owner User',
          avatarUrl: 'https://example.test/owner.png',
          email: 'owner@example.test',
        },
      },
      request: {
        body: {
          grantee: {
            provider: 'feishu',
            type: 'email',
            value: 'editor@example.test',
          },
          role: 'manager',
        },
      },
      status: 200,
      body: undefined,
    }

    await grantShare(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.share.grantee_principal_id).toBe('prn_editor')
  })

  it('encodes non-ASCII Feishu actor names before adding broker headers', async () => {
    process.env.HERMES_RUN_BROKER_URL = 'http://broker.test'
    process.env.HERMES_RUN_BROKER_KEY = 'broker-key'
    process.env.FEISHU_APP_ID = 'cli_web'
    vi.resetModules()
    const fetchMock = vi.fn(async (_url: string, options: any) => {
      expect(() => new Headers(options.headers)).not.toThrow()
      expect(options.headers['X-Hermes-Actor-Display-Name']).toBeUndefined()
      expect(options.headers['X-Hermes-Actor-Display-Name-Encoded']).toBe(encodeURIComponent('孙可'))
      return new Response(JSON.stringify({ shares: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { listShares } = await import('../../packages/server/src/controllers/hermes/agents')
    const ctx: any = {
      params: { agentId: 'agent-shared' },
      state: {
        user: {
          openid: 'ou_owner',
          userId: 'u_owner',
          tenantKey: 'tenant_a',
          appId: 'cli_web',
          name: '孙可',
          avatarUrl: 'https://example.test/owner.png',
          email: 'owner@example.test',
        },
      },
      status: 200,
      body: undefined,
    }

    await listShares(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.shares).toEqual([])
  })

  it('derives actor principal headers for legacy Feishu sessions without userId in the cookie', async () => {
    process.env.HERMES_RUN_BROKER_URL = 'http://broker.test'
    process.env.HERMES_RUN_BROKER_KEY = 'broker-key'
    process.env.FEISHU_APP_ID = 'cli_web'
    vi.resetModules()
    const fetchMock = vi.fn(async (_url: string, options: any) => {
      expect(options.headers).toMatchObject({
        'X-Hermes-Owner-Open-Id': 'ou_owner',
        'X-Hermes-Actor-Provider': 'feishu',
        'X-Hermes-Actor-Tenant-Key': 'cli_web',
        'X-Hermes-Actor-App-Id': 'cli_web',
        'X-Hermes-Actor-User-Id': 'g41a5b5g',
        'X-Hermes-Actor-Display-Name-Encoded': encodeURIComponent('孙可'),
      })
      expect(JSON.parse(options.body)).toEqual({
        grantee: { provider: 'feishu', type: 'user_id', value: 'ee966643' },
        role: 'viewer',
      })
      return new Response(JSON.stringify({ share: { grantee_principal_id: 'prn_ee966643', role: 'viewer' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { grantShare } = await import('../../packages/server/src/controllers/hermes/agents')
    const ctx: any = {
      params: { agentId: 'webui:ou_owner:123' },
      state: { user: { openid: 'ou_owner', profile: 'feishu_g41a5b5g', name: '孙可' } },
      request: { body: { grantee: { provider: 'feishu', type: 'user_id', value: 'ee966643' }, role: 'viewer' } },
      status: 200,
      body: undefined,
    }

    await grantShare(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.share.grantee_principal_id).toBe('prn_ee966643')
  })
})
