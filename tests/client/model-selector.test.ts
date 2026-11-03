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
  isProfileDefaultModel: vi.fn(() => false),
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
    appStoreMock.isProfileDefaultModel.mockImplementation(() => false)
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

  it('stars the default on the aggregate-fallback path, where profiles[] has no entry', async () => {
    appStoreMock.modelGroups = [{
      provider: 'zai',
      label: 'Z.ai',
      base_url: '',
      api_key: '',
      models: ['claude-sonnet-5', 'glm-4.6'],
    }]
    // profileModelGroups stays empty — the picker renders modelGroups, and the
    // store resolves ⭐ from the aggregate default.
    appStoreMock.isProfileDefaultModel.mockImplementation(
      (profile: string, model: string, provider: string) =>
        profile === 'feishu_user_a' && model === 'glm-4.6' && provider === 'zai',
    )

    const wrapper = mount(ModelSelector)
    await wrapper.get('.model-trigger').trigger('click')

    const rows = wrapper.findAll('.model-item')
    expect(rows).toHaveLength(2)
    expect(rows[0].findAll('.model-badge-cap').map(node => node.text())).toEqual([])
    expect(rows[1].findAll('.model-badge-cap').map(node => node.text())).toEqual(['⭐'])
    expect(appStoreMock.isProfileDefaultModel).toHaveBeenCalledWith('feishu_user_a', 'glm-4.6', 'zai')
  })

  it('renders capability badges from model_meta and stars the profile default', async () => {
    appStoreMock.isProfileDefaultModel.mockImplementation(
      (profile: string, model: string, provider: string) =>
        profile === 'feishu_user_a' && model === 'glm-4.6' && provider === 'zai',
    )
    appStoreMock.profileModelGroups = [{
      profile: 'feishu_user_a',
      default: 'glm-4.6',
      default_provider: 'zai',
      groups: [{
        provider: 'zai',
        label: 'Z.ai',
        base_url: '',
        api_key: '',
        models: ['claude-sonnet-5', 'glm-5v-turbo', 'glm-4.6', 'deepseek-v4-flash'],
        model_meta: {
          'claude-sonnet-5': { capabilities: ['vision', 'reasoning'] },
          'glm-5v-turbo': { capabilities: ['vision'] },
          'glm-4.6': { capabilities: ['reasoning'] },
        },
      }],
    }]

    const wrapper = mount(ModelSelector)
    await wrapper.get('.model-trigger').trigger('click')

    const rows = wrapper.findAll('.model-item')
    expect(rows).toHaveLength(4)

    const badges = (index: number) => rows[index].findAll('.model-badge-cap').map(node => node.text())
    expect(badges(0)).toEqual(['👁', '🧠'])
    expect(badges(1)).toEqual(['👁'])
    expect(badges(2)).toEqual(['🧠', '⭐'])
    expect(badges(3)).toEqual([])

    // The model name must stay in its own cell — badges never replace it.
    expect(rows[0].get('.model-item-name').text()).toBe('claude-sonnet-5')
  })
})
