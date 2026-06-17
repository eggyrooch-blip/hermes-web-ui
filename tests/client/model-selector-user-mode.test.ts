// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

// Upstream ModelSelector reads model data from appStore.profileModelGroups
// (keyed by the active profile name) and resolves display names via
// appStore.displayModelName. It selects via appStore.switchModel(model, provider).
const appStoreMock = vi.hoisted(() => ({
  selectedModel: 'default-model',
  selectedProvider: 'default-provider',
  profileModelGroups: [
    {
      profile: 'default',
      default: 'gpt-5.4',
      default_provider: 'openai',
      groups: [
        { provider: 'openai', label: 'OpenAI', models: ['gpt-5.4'], model_meta: {} },
      ],
    },
  ],
  customModels: {} as Record<string, string[]>,
  displayModelName: (model: string) => model,
  getModelAlias: () => '',
  removeCustomModel: vi.fn(),
  reloadModels: vi.fn(),
  switchModel: vi.fn(),
}))

const profilesStoreMock = vi.hoisted(() => ({
  activeProfileName: 'default',
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => appStoreMock,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStoreMock,
}))

vi.mock('@/utils/providerLogo', () => ({
  getProviderLogo: () => ({ label: 'O', bg: '#111', fg: '#fff' }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NModal: {
    props: ['show'],
    template: '<div v-if="show" class="modal-stub"><slot /></div>',
  },
  NInput: {
    props: ['value', 'size', 'placeholder', 'clearable'],
    emits: ['update:value', 'keydown'],
    template: '<input class="input-stub" :value="value" @input="$emit(\'update:value\', $event.target.value)" />',
  },
  NSelect: {
    props: ['value', 'options', 'size'],
    emits: ['update:value'],
    template: '<select class="select-stub" :value="value" @change="$emit(\'update:value\', $event.target.value)"></select>',
  },
}))

import ModelSelector from '@/components/layout/ModelSelector.vue'

describe('ModelSelector user mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appStoreMock.selectedModel = 'default-model'
    appStoreMock.selectedProvider = 'default-provider'
    profilesStoreMock.activeProfileName = 'default'
  })

  it('updates the profile default model from the sidebar selector', async () => {
    const wrapper = mount(ModelSelector)

    await wrapper.find('.model-trigger').trigger('click')
    await wrapper.find('.model-item').trigger('click')

    expect(appStoreMock.switchModel).toHaveBeenCalledWith('gpt-5.4', 'openai')
  })
})
