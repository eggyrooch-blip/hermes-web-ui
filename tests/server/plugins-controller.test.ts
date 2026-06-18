import { beforeEach, describe, expect, it, vi } from 'vitest'

const listHermesPluginsMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/hermes/plugins', () => ({
  listHermesPlugins: listHermesPluginsMock,
}))

const sampleResponse = {
  plugins: [{
    key: 'demo',
    name: 'Demo',
    kind: 'standalone',
    source: 'user',
    configStatus: 'enabled',
    effectiveStatus: 'enabled',
    version: '1.0.0',
    description: 'Demo plugin',
    author: 'Hermes',
    path: '/Users/kite/.hermes/plugins/demo',
    providesTools: ['demo_tool'],
    providesHooks: [],
    requiresEnv: ['DEMO_SECRET'],
  }],
  warnings: ['user plugins at /Users/kite/.hermes/plugins: warning'],
  metadata: {
    hermesAgentRoot: '/Users/kite/code/hermes-agent',
    pythonExecutable: '/opt/homebrew/bin/python3',
    cwd: '/Users/kite/code/hermes-web-ui',
    projectPluginsEnabled: true,
  },
}

function createCtx(role = 'user') {
  return {
    state: {
      user: { role },
      profile: { name: 'test-profile' },
    },
    status: 200,
    body: null,
  } as any
}

describe('plugins controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listHermesPluginsMock.mockResolvedValue(structuredClone(sampleResponse))
  })

  it('redacts host-sensitive plugin inventory fields for ordinary users', async () => {
    const { list } = await import('../../packages/server/src/controllers/hermes/plugins')
    const ctx = createCtx('user')

    await list(ctx)

    expect(ctx.body).toEqual({
      plugins: [{
        key: 'demo',
        name: 'Demo',
        kind: 'standalone',
        source: 'user',
        configStatus: 'enabled',
        effectiveStatus: 'enabled',
        version: '1.0.0',
        description: 'Demo plugin',
        author: 'Hermes',
        providesTools: ['demo_tool'],
        providesHooks: [],
      }],
      warnings: [],
    })
  })

  it('keeps full plugin maintenance details for super-admin users', async () => {
    const { list } = await import('../../packages/server/src/controllers/hermes/plugins')
    const ctx = createCtx('super_admin')

    await list(ctx)

    expect(ctx.body).toEqual(sampleResponse)
  })
})
