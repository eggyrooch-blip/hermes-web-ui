// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shallowMount, flushPromises } from '@vue/test-utils'

// Slash registry behavior (RESTORED after the upstream rebaseline regressed it):
//   - the `/` picker merges the in-component built-in `bridgeCommands` with the
//     PER-PROFILE skill/slash commands fetched from /api/hermes/slash (incl. each
//     skill's self-declared short commands, e.g. /strategy),
//   - it renders for ALL sessions (not only CLI/bridge sessions),
//   - rows render as `.slash-command-item` inside `.slash-command-dropdown`,
//   - a failed fetch degrades to built-ins (fail-soft), never blocking input,
//   - the separate `/skill` picker modal stays CLI-only (unchanged).

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
const fetchSlashCommandsMock = vi.hoisted(() => vi.fn())
const isStoredSuperAdminMock = vi.hoisted(() => vi.fn(() => false))

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

vi.mock('@/api/hermes/slash', () => ({
  fetchSlashCommands: fetchSlashCommandsMock,
}))

vi.mock('@/api/client', () => ({
  isStoredSuperAdmin: isStoredSuperAdminMock,
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
    fetchSlashCommandsMock.mockResolvedValue({
      ok: true,
      commands: [
        { name: 'strategy', slash: '/strategy', title: '投放策略', description: 'strategy alias', source: 'skill-alias', type: 'skill', category: '' },
        { name: 'kep-trevi-strategy-recommend', slash: '/kep-trevi-strategy-recommend', title: '策略', description: 'skill', source: 'skill', type: 'skill', category: '' },
      ],
    })
    isStoredSuperAdminMock.mockReturnValue(false)
  })

  it('merges built-in commands with per-profile skill/slash commands from the backend', async () => {
    const wrapper = shallowMount(ChatInput)
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/')
    await textarea.trigger('input')
    await flushPromises()

    expect(wrapper.find('.slash-command-dropdown').exists()).toBe(true)
    // built-ins still present
    expect(wrapper.text()).toContain('/clear')
    expect(wrapper.text()).toContain('/compress')
    // backend per-profile commands merged in (incl. skill short alias /strategy)
    expect(fetchSlashCommandsMock).toHaveBeenCalledWith('owner_sync_profile')
    expect(findCommandItem(wrapper, 'strategy')).toBeTruthy()
    expect(findCommandItem(wrapper, 'kep-trevi-strategy-recommend')).toBeTruthy()
  })

  it('shows skill commands for non-CLI (web) sessions too', async () => {
    chatStoreMock.activeSession = { id: 's2', source: 'web', profile: 'owner_sync_profile' } as any
    const wrapper = shallowMount(ChatInput)
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/')
    await textarea.trigger('input')
    await flushPromises()

    expect(wrapper.find('.slash-command-dropdown').exists()).toBe(true)
    expect(findCommandItem(wrapper, 'strategy')).toBeTruthy()
  })

  it('degrades to built-in commands when the backend fetch fails (fail-soft)', async () => {
    fetchSlashCommandsMock.mockRejectedValueOnce(new Error('boom'))
    const wrapper = shallowMount(ChatInput)
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/')
    await textarea.trigger('input')
    await flushPromises()

    expect(wrapper.find('.slash-command-dropdown').exists()).toBe(true)
    expect(findCommandItem(wrapper, 'clear')).toBeTruthy()  // built-ins survive
    expect(findCommandItem(wrapper, 'strategy')).toBeFalsy()
  })

  it('does not expose host-maintenance MCP reload to ordinary users', async () => {
    const wrapper = shallowMount(ChatInput)
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/reload')
    await textarea.trigger('input')
    await flushPromises()

    expect(wrapper.text()).not.toContain('/reload-mcp')
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
