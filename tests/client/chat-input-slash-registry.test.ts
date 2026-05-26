// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shallowMount, flushPromises } from '@vue/test-utils'

const chatStoreMock = vi.hoisted(() => ({
  activeSession: null as any,
  isStreaming: false,
  isAborting: false,
  setAutoPlaySpeech: vi.fn(),
  sendMessage: vi.fn(),
  stopStreaming: vi.fn(),
}))

const appStoreMock = vi.hoisted(() => ({
  selectedModel: 'default-model',
  selectedProvider: 'default-provider',
}))

const profilesStoreMock = vi.hoisted(() => ({
  activeProfileName: 'owner_sync_profile',
}))

const fetchSlashCommandsMock = vi.hoisted(() => vi.fn())

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => chatStoreMock,
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => appStoreMock,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStoreMock,
}))

vi.mock('@/api/hermes/sessions', () => ({
  fetchContextLength: vi.fn(() => Promise.resolve(200000)),
}))

vi.mock('@/api/hermes/model-context', () => ({
  setModelContext: vi.fn(),
}))

vi.mock('@/api/hermes/slash', () => ({
  fetchSlashCommands: fetchSlashCommandsMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NButton: {
    template: '<button type="button" @click="$emit(\'click\', $event)"><slot /><slot name="icon" /></button>',
  },
  NTooltip: {
    template: '<span><slot name="trigger" /><slot /></span>',
  },
  NSwitch: {
    template: '<input type="checkbox" />',
  },
  NModal: {
    props: ['show'],
    template: '<div v-if="show"><slot /><slot name="footer" /></div>',
  },
  NInputNumber: {
    template: '<input />',
  },
  useMessage: () => ({
    error: vi.fn(),
    success: vi.fn(),
  }),
}))

import ChatInput from '@/components/hermes/chat/ChatInput.vue'

describe('ChatInput slash registry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    fetchSlashCommandsMock.mockResolvedValue({
      ok: true,
      commands: [
        {
          name: 'clear',
          slash: '/clear',
          title: 'Clear conversation',
          description: 'Clear the current chat transcript.',
          source: 'local',
          type: 'local',
          category: 'Chat',
        },
        {
          name: 'kep-prd-analysis',
          slash: '/kep-prd-analysis',
          title: 'KEP PRD Analysis',
          description: 'PRD analysis helper',
          source: 'skill',
          type: 'skill',
          category: 'Keep',
        },
      ],
    })
  })

  it('loads and renders slash suggestions when the user starts a command', async () => {
    const wrapper = shallowMount(ChatInput)
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/')
    await textarea.trigger('input')
    await flushPromises()

    expect(fetchSlashCommandsMock).toHaveBeenCalledWith('owner_sync_profile')
    expect(wrapper.text()).toContain('/clear')
    expect(wrapper.text()).toContain('/kep-prd-analysis')
    expect(wrapper.text()).toContain('PRD analysis helper')
  })

  it('inserts the selected command and still sends slash text through the normal chat path', async () => {
    const wrapper = shallowMount(ChatInput)
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/kep')
    await textarea.trigger('input')
    await flushPromises()
    await wrapper.find('[data-testid="slash-suggestion-kep-prd-analysis"]').trigger('click')

    expect((textarea.element as HTMLTextAreaElement).value).toBe('/kep-prd-analysis ')

    await textarea.setValue('/kep-prd-analysis 请分析这个 PRD')
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: false, isComposing: false })

    expect(chatStoreMock.sendMessage).toHaveBeenCalledWith('/kep-prd-analysis 请分析这个 PRD', undefined)
  })

  it('supports keyboard selection without sending the message early', async () => {
    const wrapper = shallowMount(ChatInput)
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/')
    await textarea.trigger('input')
    await flushPromises()
    await textarea.trigger('keydown', { key: 'ArrowDown' })
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: false, isComposing: false })

    expect(chatStoreMock.sendMessage).not.toHaveBeenCalled()
    expect((textarea.element as HTMLTextAreaElement).value).toBe('/kep-prd-analysis ')
  })

  it('dismisses slash suggestions with Escape until the input changes', async () => {
    const wrapper = shallowMount(ChatInput)
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/')
    await textarea.trigger('input')
    await flushPromises()
    expect(wrapper.find('[data-testid="slash-suggestion-clear"]').exists()).toBe(true)

    await textarea.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-testid="slash-suggestion-clear"]').exists()).toBe(false)

    await textarea.setValue('/k')
    await textarea.trigger('input')
    await flushPromises()
    expect(wrapper.find('[data-testid="slash-suggestion-kep-prd-analysis"]').exists()).toBe(true)
  })

  it('sends an unknown slash command as normal user text', async () => {
    const wrapper = shallowMount(ChatInput)
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/unknown do not scan paths')
    await textarea.trigger('input')
    await flushPromises()
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: false, isComposing: false })

    expect(chatStoreMock.sendMessage).toHaveBeenCalledWith('/unknown do not scan paths', undefined)
  })

  it('keeps slash suggestions above the message list stacking context', () => {
    const source = readFileSync(
      `${process.cwd()}/packages/client/src/components/hermes/chat/ChatInput.vue`,
      'utf8',
    )

    expect(source).toMatch(/\.chat-input-area\s*\{[^}]*position:\s*relative;/s)
    expect(source).toMatch(/\.chat-input-area\s*\{[^}]*z-index:\s*30;/s)
    expect(source).toMatch(/\.slash-suggestions\s*\{[^}]*z-index:\s*20;/s)
  })
})
