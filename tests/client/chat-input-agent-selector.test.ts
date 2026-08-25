// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zh from '@/i18n/locales/zh'

const OWNER = 'ou_11111111111111110000000000000001'

const profilesState = vi.hoisted(() => ({
  profiles: [] as any[],
  activeProfileName: 'sunke' as string | null,
  switchProfile: vi.fn(async (name: string) => {
    profilesState.activeProfileName = name
    return true
  }),
  fetchProfiles: vi.fn(async () => {}),
}))
const chatState = vi.hoisted(() => ({
  newChat: vi.fn(() => ({ id: 'sess-new' })),
  sessionProfileFilter: null as string | null,
  loadSessions: vi.fn(async () => {}),
  agentSwitching: false,
}))
const routerState = vi.hoisted(() => ({ push: vi.fn(async () => {}) }))

vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => profilesState }))
vi.mock('@/stores/hermes/chat', () => ({ useChatStore: () => chatState }))
vi.mock('vue-router', () => ({ useRouter: () => routerState, useRoute: () => ({ params: {} }) }))
vi.mock('@/components/hermes/profiles/ProfileAvatar.vue', () => ({
  default: { name: 'ProfileAvatar', props: ['name', 'avatar', 'size'], template: '<span class="stub-avatar" />' },
}))

import AgentPicker from '@/components/hermes/agents/AgentPicker.vue'

const i18n = createI18n({ legacy: false, locale: 'zh', fallbackLocale: 'zh', messages: { zh } })

function profile(over: Record<string, unknown>) {
  return { active: false, model: '—', alias: '', ...over } as any
}

const FIXTURE = [
  profile({ name: 'sunke', kind: 'user' }),
  profile({ name: 'webui_c84d5851f3c0_coder_c84a9e3ad1', kind: 'agent', displayLabel: 'coder' }),
  profile({ name: 'feishu_group_e1b71bb649bb_53a248a333c72a5b', kind: 'group', displayLabel: `${OWNER}-智能体先锋队` }),
]

function mountPicker() {
  return mount(AgentPicker, { global: { plugins: [i18n] }, attachTo: document.body })
}

describe('session-level agent picker', () => {
  beforeEach(() => {
    profilesState.profiles = FIXTURE.map(p => ({ ...p }))
    profilesState.activeProfileName = 'sunke'
    profilesState.switchProfile.mockClear()
    chatState.newChat.mockClear()
    chatState.loadSessions.mockClear()
    chatState.sessionProfileFilter = null
    chatState.agentSwitching = false
    routerState.push.mockClear()
    document.body.innerHTML = ''
  })

  it('shows the active agent and opens a grouped list with the current one checked', async () => {
    const wrapper = mountPicker()
    expect(wrapper.get('[data-testid="agent-picker-trigger"]').text()).toContain('sunke')
    expect(wrapper.find('[data-testid="agent-picker-dropdown"]').exists()).toBe(false)

    await wrapper.get('[data-testid="agent-picker-trigger"]').trigger('click')
    const dropdown = wrapper.get('[data-testid="agent-picker-dropdown"]')
    expect(dropdown.text()).toContain('我的智能体')
    expect(dropdown.text()).toContain('群聊智能体')
    expect(dropdown.text()).toContain('智能体先锋队')
    // The add entry is now the header's icon button (prototype panel).
    expect(dropdown.find('[data-testid="agent-picker-add"]').exists()).toBe(true)
    expect(
      wrapper.get('[data-testid="agent-picker-option-sunke"]').find('.kp_ic_line_check').exists(),
    ).toBe(true)
  })

  it('shows the group name rather than the raw profile name', async () => {
    const wrapper = mountPicker()
    await wrapper.get('[data-testid="agent-picker-trigger"]').trigger('click')
    const option = wrapper.get('[data-testid="agent-picker-option-feishu_group_e1b71bb649bb_53a248a333c72a5b"]')
    expect(option.text()).toContain('智能体先锋队')
    expect(option.text()).not.toContain(OWNER)
  })

  // The Done line for P3: picking another agent must rebind the next message.
  it('selecting another agent switches the profile then starts a session bound to it', async () => {
    const wrapper = mountPicker()
    await wrapper.get('[data-testid="agent-picker-trigger"]').trigger('click')
    await wrapper.get('[data-testid="agent-picker-option-webui_c84d5851f3c0_coder_c84a9e3ad1"]').trigger('click')
    await Promise.resolve()
    await Promise.resolve()

    expect(profilesState.switchProfile).toHaveBeenCalledWith('webui_c84d5851f3c0_coder_c84a9e3ad1')
    expect(chatState.newChat).toHaveBeenCalledWith({ profile: 'webui_c84d5851f3c0_coder_c84a9e3ad1' })
    expect(
      profilesState.switchProfile.mock.invocationCallOrder[0],
    ).toBeLessThan(chatState.newChat.mock.invocationCallOrder[0])
    expect(wrapper.find('[data-testid="agent-picker-dropdown"]').exists()).toBe(false)
  })

  // The chat sidebar filters sessions by profile; leaving it on the old agent
  // showed the previous agent's sessions next to the new agent's composer.
  it('moves the session-list filter to the new agent when one is set', async () => {
    chatState.sessionProfileFilter = 'sunke'
    const wrapper = mountPicker()
    await wrapper.get('[data-testid="agent-picker-trigger"]').trigger('click')
    await wrapper.get('[data-testid="agent-picker-option-webui_c84d5851f3c0_coder_c84a9e3ad1"]').trigger('click')
    await Promise.resolve()
    await Promise.resolve()
    expect(chatState.sessionProfileFilter).toBe('webui_c84d5851f3c0_coder_c84a9e3ad1')
    expect(chatState.loadSessions).toHaveBeenCalledWith('webui_c84d5851f3c0_coder_c84a9e3ad1')
  })

  it('leaves an "all profiles" filter alone', async () => {
    chatState.sessionProfileFilter = null
    const wrapper = mountPicker()
    await wrapper.get('[data-testid="agent-picker-trigger"]').trigger('click')
    await wrapper.get('[data-testid="agent-picker-option-webui_c84d5851f3c0_coder_c84a9e3ad1"]').trigger('click')
    await Promise.resolve()
    await Promise.resolve()
    expect(chatState.sessionProfileFilter).toBeNull()
    expect(chatState.loadSessions).not.toHaveBeenCalled()
  })

  it('re-selecting the active agent does not churn the session', async () => {
    const wrapper = mountPicker()
    await wrapper.get('[data-testid="agent-picker-trigger"]').trigger('click')
    await wrapper.get('[data-testid="agent-picker-option-sunke"]').trigger('click')
    await Promise.resolve()
    expect(profilesState.switchProfile).not.toHaveBeenCalled()
    expect(chatState.newChat).not.toHaveBeenCalled()
  })

  it('does not create a session when the profile switch fails', async () => {
    profilesState.switchProfile.mockResolvedValueOnce(false)
    const wrapper = mountPicker()
    await wrapper.get('[data-testid="agent-picker-trigger"]').trigger('click')
    await wrapper.get('[data-testid="agent-picker-option-webui_c84d5851f3c0_coder_c84a9e3ad1"]').trigger('click')
    await Promise.resolve()

    expect(chatState.newChat).not.toHaveBeenCalled()
    expect(chatState.loadSessions).not.toHaveBeenCalled()
    expect(chatState.agentSwitching).toBe(false)
  })

  // The session must be rebound BEFORE the slower session-list reload, and the
  // composer must stay locked for the whole swap — otherwise Enter in that gap
  // sends through the old session under the new profile.
  it('rebinds the session before reloading the list and locks the composer throughout', async () => {
    chatState.sessionProfileFilter = 'sunke'
    const lockedDuringSwitch: boolean[] = []
    chatState.loadSessions.mockImplementationOnce(async () => {
      lockedDuringSwitch.push(chatState.agentSwitching)
    })
    const wrapper = mountPicker()
    await wrapper.get('[data-testid="agent-picker-trigger"]').trigger('click')
    await wrapper.get('[data-testid="agent-picker-option-webui_c84d5851f3c0_coder_c84a9e3ad1"]').trigger('click')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(
      chatState.newChat.mock.invocationCallOrder[0],
    ).toBeLessThan(chatState.loadSessions.mock.invocationCallOrder[0])
    expect(lockedDuringSwitch).toEqual([true])
    expect(chatState.agentSwitching).toBe(false)
  })

  it('routes "add agent" to the hub instead of switching anything', async () => {
    const wrapper = mountPicker()
    await wrapper.get('[data-testid="agent-picker-trigger"]').trigger('click')
    await wrapper.get('[data-testid="agent-picker-add"]').trigger('click')
    expect(routerState.push).toHaveBeenCalledWith({ name: 'hermes.agents' })
    expect(profilesState.switchProfile).not.toHaveBeenCalled()
  })

  it('closes on an outside click', async () => {
    const wrapper = mountPicker()
    await wrapper.get('[data-testid="agent-picker-trigger"]').trigger('click')
    expect(wrapper.find('[data-testid="agent-picker-dropdown"]').exists()).toBe(true)
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="agent-picker-dropdown"]').exists()).toBe(false)
  })

  it('hides sections that have no agents instead of rendering empty headers', async () => {
    profilesState.profiles = [profile({ name: 'sunke', kind: 'user' })]
    const wrapper = mountPicker()
    await wrapper.get('[data-testid="agent-picker-trigger"]').trigger('click')
    const text = wrapper.get('[data-testid="agent-picker-dropdown"]').text()
    expect(text).toContain('我的智能体')
    expect(text).not.toContain('群聊智能体')
    expect(text).not.toContain('共享给我的')
  })
})
