// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ModelSelector from '@/components/layout/ModelSelector.vue'

const appStoreMock = vi.hoisted(() => ({
  profileModelGroups: [] as any[],
  modelGroups: [] as any[],
  selectedModel: '',
  selectedProvider: '',
  customModels: {} as Record<string, string[]>,
  reloadModels: vi.fn(),
  switchModel: vi.fn(),
  removeCustomModel: vi.fn(),
  displayModelName: vi.fn((model: string) => model),
  getModelAlias: vi.fn(() => ''),
}))

const profilesStoreMock = vi.hoisted(() => ({
  activeProfileName: 'feishu_user_a',
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => appStoreMock,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStoreMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'models.title': 'Model',
      'models.refresh': 'Refresh',
      'models.searchPlaceholder': 'Search models',
      'models.customModelPlaceholder': 'Custom model',
      'models.customModelHint': 'Enter a model id',
      'models.aliasCanonical': key,
    } as Record<string, string>)[key] || key,
  }),
}))

vi.mock('naive-ui', () => ({
  NInput: { template: '<input />' },
  NModal: { props: ['show'], template: '<div v-if="show"><slot /></div>' },
  NSelect: { template: '<select />' },
}))

describe('ModelSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appStoreMock.profileModelGroups = []
    appStoreMock.modelGroups = []
    appStoreMock.selectedModel = ''
    appStoreMock.selectedProvider = ''
    appStoreMock.customModels = {}
    appStoreMock.displayModelName.mockImplementation((model: string) => model)
  })

  it('falls back to aggregate model groups when the API has no profile groups', () => {
    appStoreMock.modelGroups = [{
      provider: 'custom:litellm-sre',
      label: 'LiteLLM SRE',
      base_url: 'https://litellm.example/v1',
      models: ['tencent-sonnet-4-6'],
      api_key: '',
    }]
    appStoreMock.selectedProvider = 'custom:litellm-sre'
    appStoreMock.selectedModel = 'custom:litellm-sre/tencent-sonnet-4-6'
    appStoreMock.customModels = {
      'custom:litellm-sre': ['custom:litellm-sre/tencent-sonnet-4-6'],
    }
    appStoreMock.displayModelName.mockImplementation((model: string) =>
      model === 'custom:litellm-sre/tencent-sonnet-4-6' ? 'Tencent Sonnet' : model,
    )

    const wrapper = mount(ModelSelector)

    expect(wrapper.get('.model-trigger').text()).toContain('Tencent Sonnet')
  })
})
