// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const appStoreMock = vi.hoisted(() => ({
  selectedModel: 'default-model',
  selectedProvider: 'default-provider',
  modelGroups: [
    { provider: 'openai', label: 'OpenAI', models: ['gpt-5.4'] },
  ],
  customModels: {} as Record<string, string[]>,
  switchModel: vi.fn(),
}))

const chatStoreMock = vi.hoisted(() => ({
  activeSession: null as Record<string, any> | null,
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => appStoreMock,
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => chatStoreMock,
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
    chatStoreMock.activeSession = null
  })

  it('updates the profile default model from the sidebar selector', async () => {
    const wrapper = mount(ModelSelector)

    await wrapper.find('.model-trigger').trigger('click')
    await wrapper.find('.model-item').trigger('click')

    expect(appStoreMock.switchModel).toHaveBeenCalledWith('gpt-5.4', 'openai')
  })
})
