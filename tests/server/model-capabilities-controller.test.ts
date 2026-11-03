import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockReadAppConfig, mockBuildModelGroups } = vi.hoisted(() => ({
  mockReadAppConfig: vi.fn(),
  mockBuildModelGroups: vi.fn(),
}))

vi.mock('../../packages/server/src/services/app-config', () => ({
  readAppConfig: mockReadAppConfig,
  writeAppConfig: vi.fn(),
}))

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  readConfigYaml: vi.fn(() => ({})),
  readConfigYamlForProfile: vi.fn(async () => ({})),
  updateConfigYaml: vi.fn(),
  updateConfigYamlForProfile: vi.fn(),
  fetchProviderModels: vi.fn(async () => []),
  buildModelGroups: mockBuildModelGroups,
  PROVIDER_ENV_MAP: {},
}))

vi.mock('../../packages/server/src/shared/providers', () => ({
  buildProviderModelMap: vi.fn(() => ({})),
  PROVIDER_PRESETS: [],
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveEnvPath: vi.fn(() => '/tmp/hermes-test/.env'),
  getActiveAuthPath: vi.fn(() => '/tmp/hermes-test/auth.json'),
  getActiveProfileName: vi.fn(() => 'feishu_user_a'),
  getProfileDir: vi.fn(() => '/tmp/hermes-test'),
  getHermesBaseDir: vi.fn(() => '/tmp/hermes-test'),
  listProfileNamesFromDisk: vi.fn(() => ['feishu_user_a']),
}))

vi.mock('../../packages/server/src/services/request-context', () => ({
  getRequestProfileDir: vi.fn(() => '/tmp/hermes-test'),
  isChatPlaneRequest: vi.fn(() => false),
}))

vi.mock('../../packages/server/src/services/hermes/agent-ownership', () => ({
  ownerOwnsProfile: vi.fn(() => true),
}))

vi.mock('../../packages/server/src/services/hermes/custom-providers-compat', () => ({
  getCompatibleCustomProviders: vi.fn(() => []),
}))

vi.mock('../../packages/server/src/services/hermes/copilot-models', () => ({
  getCopilotModelsDetailed: vi.fn(async () => []),
  resolveCopilotOAuthToken: vi.fn(async () => ''),
}))

vi.mock('../../packages/server/src/services/hermes/model-catalog-cache', () => ({
  getCachedProviderModels: vi.fn(() => null),
  readProviderModelCatalogCache: vi.fn(async () => ({})),
  refreshConfiguredProviderModelCatalogs: vi.fn(async () => undefined),
  writeProviderModelCatalogEntry: vi.fn(async () => undefined),
}))

vi.mock('../../packages/server/src/db', () => ({ getDb: vi.fn() }))
vi.mock('../../packages/server/src/db/hermes/schemas', () => ({ MODEL_CONTEXT_TABLE: 'model_context' }))
vi.mock('../../packages/server/src/db/hermes/users-store', () => ({ listUserProfiles: vi.fn(() => []) }))

import { getAvailable } from '../../packages/server/src/controllers/hermes/models'

type ResponseGroup = {
  provider: string
  models: string[]
  model_meta?: Record<string, { capabilities?: string[] }>
}

describe('available-models capability passthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadAppConfig.mockResolvedValue({})
    mockBuildModelGroups.mockReturnValue({
      default: 'glm-4.6',
      default_provider: 'zai',
      groups: [{
        provider: 'zai',
        models: [
          { id: 'claude-sonnet-5' },
          { id: 'gpt-5.6-terra' },
          { id: 'glm-5v-turbo' },
          { id: 'glm-4.6' },
          { id: 'deepseek-v4-flash' },
        ],
      }],
    })
  })

  function createCtx() {
    return {
      query: { profile: 'feishu_user_a' },
      state: { user: { id: 1, role: 'super_admin' } },
      get: () => '',
      status: 200,
      body: undefined as any,
    }
  }

  it('annotates each model group with capabilities from the static table', async () => {
    const ctx = createCtx()

    await getAvailable(ctx)

    const group = (ctx.body.groups as ResponseGroup[]).find(candidate => candidate.provider === 'zai')
    expect(group?.model_meta).toEqual({
      'claude-sonnet-5': { capabilities: ['vision', 'reasoning'] },
      'gpt-5.6-terra': { capabilities: ['reasoning'] },
      'glm-5v-turbo': { capabilities: ['vision'] },
      'glm-4.6': { capabilities: ['reasoning'] },
    })
    // Unknown models stay out of model_meta entirely (no badge, no payload cost).
    expect(group?.model_meta?.['deepseek-v4-flash']).toBeUndefined()
  })

  it('annotates the per-profile groups the selectors actually read', async () => {
    const ctx = createCtx()

    await getAvailable(ctx)

    const profileGroup = (ctx.body.profiles[0].groups as ResponseGroup[])[0]
    expect(profileGroup.model_meta?.['claude-sonnet-5']).toEqual({ capabilities: ['vision', 'reasoning'] })
  })

  it('leaves the routing fields of the response untouched', async () => {
    const ctx = createCtx()

    await getAvailable(ctx)

    expect(ctx.body.default).toBe('glm-4.6')
    expect(ctx.body.default_provider).toBe('zai')
    expect((ctx.body.groups as ResponseGroup[])[0].models).toEqual([
      'claude-sonnet-5',
      'gpt-5.6-terra',
      'glm-5v-turbo',
      'glm-4.6',
      'deepseek-v4-flash',
    ])
  })
})
