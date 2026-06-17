// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shallowMount, flushPromises } from '@vue/test-utils'

// Upstream rebaseline note:
// The fork's "owner-scoped slash registry" (server-driven /api/hermes/slash
// commands rendered into [data-testid="slash-suggestion-*"]) was replaced by
// upstream's client-side bridge-command registry. Slash suggestions now:
//   - only render for bridge/CLI sessions (activeSession.source === 'cli'),
//   - come from a hard-coded `bridgeCommands` list (no fetchSlashCommands call),
//   - render as `.slash-command-item` rows inside `.slash-command-dropdown`,
//   - and skills route through a separate `/skill` picker modal.
// These tests verify that surviving behavior against the upstream DOM.

const chatStoreMock = vi.hoisted(() => ({
  activeSession: { id: 's1', source: 'cli', profile: 'owner_sync_profile' } as any,
  activeSessionId: 's1',
  isStreaming: false,
  isAborting: false,
  setAutoPlaySpeech: vi.fn(),
  setSessionReasoningEffort: vi.fn(),
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

const fetchSkillsMock = vi.hoisted(() => vi.fn())

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

vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: fetchSkillsMock,
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
  NPopselect: {
    props: ['value', 'options'],
    template: '<div><slot /></div>',
  },
  useMessage: () => ({
    error: vi.fn(),
    success: vi.fn(),
  }),
}))

import ChatInput from '@/components/hermes/chat/ChatInput.vue'

// Find the rendered slash-command row whose name span reads `/<name>`.
function findCommandItem(wrapper: any, name: string) {
  return wrapper.findAll('.slash-command-item').find((item: any) =>
    item.find('.slash-command-name').text() === `/${name}`,
  )
}

describe('ChatInput slash registry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    chatStoreMock.activeSession = { id: 's1', source: 'cli', profile: 'owner_sync_profile' }
    chatStoreMock.activeSessionId = 's1'
    fetchSkillsMock.mockResolvedValue({ categories: [] })
  })

  it('renders client-side bridge slash suggestions when the user starts a command', async () => {
    const wrapper = shallowMount(ChatInput)
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/')
    await textarea.trigger('input')
    await flushPromises()

    // Suggestions are sourced from the in-component bridgeCommands list, not a fetch.
    expect(wrapper.find('.slash-command-dropdown').exists()).toBe(true)
    expect(wrapper.text()).toContain('/clear')
    expect(wrapper.text()).toContain('/compress')
  })

  it('inserts the selected command and still sends slash text through the normal chat path', async () => {
    const wrapper = shallowMount(ChatInput)
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/clea')
    await textarea.trigger('input')
    await flushPromises()

    const clearItem = findCommandItem(wrapper, 'clear')
    expect(clearItem).toBeTruthy()
    await clearItem!.trigger('mousedown')
    await flushPromises()

    expect((textarea.element as HTMLTextAreaElement).value).toBe('/clear ')

    await textarea.setValue('/clear --history')
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: false, isComposing: false })

    expect(chatStoreMock.sendMessage).toHaveBeenCalledWith('/clear --history', undefined)
  })

  it('supports keyboard selection without sending the message early', async () => {
    const wrapper = shallowMount(ChatInput)
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/')
    await textarea.trigger('input')
    await flushPromises()
    // Enter on the active (first) suggestion selects it instead of sending.
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: false, isComposing: false })
    await flushPromises()

    expect(chatStoreMock.sendMessage).not.toHaveBeenCalled()
    // First bridge command is `/usage`; selection inserts it with a trailing space.
    expect((textarea.element as HTMLTextAreaElement).value).toBe('/usage ')
  })

  it('dismisses slash suggestions with Escape until the input changes', async () => {
    const wrapper = shallowMount(ChatInput)
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/')
    await textarea.trigger('input')
    await flushPromises()
    expect(wrapper.find('.slash-command-dropdown').exists()).toBe(true)

    await textarea.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(wrapper.find('.slash-command-dropdown').exists()).toBe(false)

    await textarea.setValue('/comp')
    await textarea.trigger('input')
    await flushPromises()
    expect(findCommandItem(wrapper, 'compress')).toBeTruthy()
  })

  it('sends an unknown slash command as normal user text', async () => {
    const wrapper = shallowMount(ChatInput)
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/unknown do not scan paths')
    await textarea.trigger('input')
    await flushPromises()
    // A slash command with a space is not a registry query → dropdown stays closed.
    expect(wrapper.find('.slash-command-dropdown').exists()).toBe(false)
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: false, isComposing: false })

    expect(chatStoreMock.sendMessage).toHaveBeenCalledWith('/unknown do not scan paths', undefined)
  })

  it('keeps slash suggestions above the message list stacking context', () => {
    const source = readFileSync(
      `${process.cwd()}/packages/client/src/components/hermes/chat/ChatInput.vue`,
      'utf8',
    )

    // Upstream renders the dropdown as `.slash-command-dropdown`, absolutely
    // positioned with a stacking z-index so it overlays the message list.
    expect(source).toMatch(/\.slash-command-dropdown\s*\{[^}]*position:\s*absolute;/s)
    expect(source).toMatch(/\.slash-command-dropdown\s*\{[^}]*z-index:\s*20;/s)
  })
})
