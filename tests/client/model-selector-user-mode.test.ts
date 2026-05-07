// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const isUserModeMock = vi.hoisted(() => vi.fn(() => true))

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
  newChat: vi.fn(() => {
    chatStoreMock.activeSession = { id: 'session-1', model: undefined, provider: undefined }
  }),
  switchSessionModel: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  isUserMode: isUserModeMock,
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
    isUserModeMock.mockReturnValue(true)
    chatStoreMock.activeSession = null
  })

  it('creates a session-local selection instead of writing the default model when compact selector has no active session', async () => {
    const wrapper = mount(ModelSelector, {
      props: { variant: 'compact' },
    })

    await wrapper.find('.model-trigger').trigger('click')
    await wrapper.find('.model-item').trigger('click')

    expect(chatStoreMock.newChat).toHaveBeenCalledOnce()
    expect(chatStoreMock.switchSessionModel).toHaveBeenCalledWith('gpt-5.4', 'openai')
    expect(appStoreMock.switchModel).not.toHaveBeenCalled()
  })
})
