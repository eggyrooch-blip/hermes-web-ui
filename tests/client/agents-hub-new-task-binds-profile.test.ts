// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zh from '@/i18n/locales/zh'

const OWNER = 'ou_11111111111111110000000000000001'

const profilesState = vi.hoisted(() => ({
  profiles: [] as any[],
  activeProfileName: 'sunke' as string | null,
  loading: false,
  switchProfile: vi.fn(async (name: string) => {
    profilesState.activeProfileName = name
    return true
  }),
  fetchProfiles: vi.fn(async () => {}),
}))
const chatState = vi.hoisted(() => ({
  newChat: vi.fn(() => ({ id: 'sess-1' })),
  agentSwitching: false,
}))
const routerState = vi.hoisted(() => ({ push: vi.fn(async () => {}) }))

vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => profilesState }))
vi.mock('@/stores/hermes/chat', () => ({ useChatStore: () => chatState }))
// AgentCard's model InlinePick pulls in the app store (model catalog), the
// profile-scoped model API (whose client module drags the real router in),
// and naive-ui's message hook — all unrelated to what this suite asserts.
vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({
    modelGroups: [],
    profileModelGroups: [],
    isModelVisible: () => true,
    displayModelName: (model: string) => model,
    loadModels: vi.fn(async () => {}),
  }),
}))
vi.mock('@/api/hermes/system', () => ({ updateDefaultModelForProfile: vi.fn(async () => {}) }))
vi.mock('naive-ui', () => ({
  NSpin: { name: 'NSpin', props: ['show'], template: '<div><slot /></div>' },
  useMessage: () => ({ error: vi.fn(), success: vi.fn() }),
}))
vi.mock('vue-router', () => ({
  useRouter: () => routerState,
  useRoute: () => ({ params: {}, query: {} }),
  createRouter: vi.fn(),
  createWebHashHistory: vi.fn(),
}))
// AgentsView imports AgentDetailView for its embedded mode; stub it so the test
// stays on the list and does not drag in the real router module.
vi.mock('@/views/hermes/AgentDetailView.vue', () => ({
  default: { name: 'AgentDetailView', props: ['agentName', 'embedded'], template: '<div class="stub-detail" />' },
}))
vi.mock('@/components/hermes/profiles/ProfileAvatar.vue', () => ({
  default: { name: 'ProfileAvatar', props: ['name', 'avatar', 'size'], template: '<span class="stub-avatar" />' },
}))
vi.mock('@/components/hermes/profiles/ProfileCreateModal.vue', () => ({
  default: { name: 'ProfileCreateModal', template: '<div class="stub-create-modal" />' },
}))

import AgentsView from '@/views/hermes/AgentsView.vue'

const i18n = createI18n({ legacy: false, locale: 'zh', fallbackLocale: 'zh', messages: { zh } })

function profile(over: Record<string, unknown>) {
  return { active: false, model: '—', alias: '', ...over } as any
}

// Shaped like prod: personal identity, self-built agents, named group, a group
// whose display_label fell back to the chat id, and one shared agent.
const FIXTURE = [
  profile({ name: 'sunke', kind: 'user' }),
  profile({ name: 'webui_c84d5851f3c0_coder_c84a9e3ad1', kind: 'agent', displayLabel: 'coder' }),
  profile({ name: 'webui_c84d5851f3c0_kehugenzong_830478d9b1', kind: 'agent', displayLabel: 'kehugenzong' }),
  profile({ name: 'feishu_group_8ec050fb3255_703fc51f7d272a1f', kind: 'group', displayLabel: `${OWNER}-IT&SEC 安全共建群` }),
  profile({ name: 'feishu_group_e1b71bb649bb_53a248a333c72a5b', kind: 'group', displayLabel: `${OWNER}-智能体先锋队` }),
  profile({ name: 'feishu_group_21034461c594_e5df580756fa42f2', kind: 'group', displayLabel: `${OWNER}-oc_ffffffffffffffff0000000000000001` }),
  profile({ name: 'shared_agent_x', kind: 'agent', displayLabel: '别人的 agent', shareRole: 'viewer' }),
]

function mountView() {
  return mount(AgentsView, { global: { plugins: [i18n], stubs: { NSpin: { template: '<div><slot /></div>' } } } })
}

describe('agents hub', () => {
  beforeEach(() => {
    profilesState.profiles = FIXTURE.map(p => ({ ...p }))
    profilesState.activeProfileName = 'sunke'
    profilesState.switchProfile.mockClear()
    chatState.newChat.mockClear()
    chatState.agentSwitching = false
    routerState.push.mockClear()
  })

  // Prototype structure: the groups are segmented tabs, one on screen at a
  // time — so "exactly once" is asserted per tab and across the union.
  it('renders every profile exactly once across the three tabs', async () => {
    const wrapper = mountView()
    const ids: string[] = []
    for (const key of ['mine', 'group', 'shared'] as const) {
      await wrapper.get(`[data-testid="agents-tab-${key}"]`).trigger('click')
      ids.push(...wrapper.findAll('[data-testid^="agent-card-"]').map(card => card.attributes('data-testid')!))
    }
    expect(ids).toHaveLength(FIXTURE.length)
    expect(new Set(ids).size).toBe(FIXTURE.length)

    expect(wrapper.get('[data-testid="agents-section-count-mine"]').text()).toBe('3')
    expect(wrapper.get('[data-testid="agents-section-count-group"]').text()).toBe('3')
    expect(wrapper.get('[data-testid="agents-section-count-shared"]').text()).toBe('1')
  })

  it('shows group names, never the raw profile name or chat id', async () => {
    const wrapper = mountView()
    await wrapper.get('[data-testid="agents-tab-group"]').trigger('click')
    const text = wrapper.text()
    expect(text).toContain('IT&SEC 安全共建群')
    expect(text).toContain('智能体先锋队')
    expect(text).toContain('未命名群聊')
    expect(text).toContain('群名待同步')
    // The raw profile name lives only in the title tooltip and the detail
    // page; the openid prefix / bare chat id must never reach the user.
    expect(text).not.toContain(OWNER)
    expect(text).not.toContain('oc_ffffffffffffffff0000000000000001')
  })

  it('still groups correctly when the server merged no multitenancy metadata', () => {
    profilesState.profiles = [
      profile({ name: 'sunke' }),
      profile({ name: 'feishu_group_8ec050fb3255_703fc51f7d272a1f' }),
      profile({ name: 'webui_c84d5851f3c0_coder_c84a9e3ad1' }),
    ]
    const wrapper = mountView()
    expect(wrapper.get('[data-testid="agents-section-count-mine"]').text()).toBe('2')
    expect(wrapper.get('[data-testid="agents-section-count-group"]').text()).toBe('1')
  })

  it('renders an empty state (not an error) when nothing is shared with me', async () => {
    profilesState.profiles = [profile({ name: 'sunke', kind: 'user' })]
    const wrapper = mountView()
    expect(wrapper.get('[data-testid="agents-section-count-shared"]').text()).toBe('0')
    await wrapper.get('[data-testid="agents-tab-shared"]').trigger('click')
    expect(wrapper.text()).toContain('还没有共享给你的 agent')
  })

  // The Done line: "new task" must bind the clicked agent's profile.
  //
  // The hub deliberately does NOT create the session itself: ChatView's mount
  // runs loadSessions(), which replaces sessions[] with the server list and
  // would drop a purely local session. It hands the agent over on the route and
  // ChatView opens the chat after that load.
  it('new task switches to that agent and hands it to the chat view on the route', async () => {
    const wrapper = mountView()
    await wrapper.get('[data-testid="agent-new-task-webui_c84d5851f3c0_coder_c84a9e3ad1"]').trigger('click')
    await Promise.resolve()
    await Promise.resolve()

    expect(profilesState.switchProfile).toHaveBeenCalledWith('webui_c84d5851f3c0_coder_c84a9e3ad1')
    expect(routerState.push).toHaveBeenCalledWith({
      name: 'hermes.chat',
      query: { profile: 'webui_c84d5851f3c0_coder_c84a9e3ad1', new: '1' },
    })
    // Never locally — that session would not survive ChatView's load.
    expect(chatState.newChat).not.toHaveBeenCalled()

    // Order matters: the profile must be active BEFORE navigating, otherwise
    // the chat view loads sessions for the previous agent.
    expect(
      profilesState.switchProfile.mock.invocationCallOrder[0],
    ).toBeLessThan(routerState.push.mock.invocationCallOrder[0])
  })

  it('binds a group agent by its profile name, not its display name', async () => {
    const wrapper = mountView()
    await wrapper.get('[data-testid="agents-tab-group"]').trigger('click')
    await wrapper.get('[data-testid="agent-new-task-feishu_group_8ec050fb3255_703fc51f7d272a1f"]').trigger('click')
    await Promise.resolve()
    expect(routerState.push).toHaveBeenCalledWith({
      name: 'hermes.chat',
      query: { profile: 'feishu_group_8ec050fb3255_703fc51f7d272a1f', new: '1' },
    })
  })

  it('does not re-switch when the agent is already active', async () => {
    profilesState.activeProfileName = 'sunke'
    const wrapper = mountView()
    await wrapper.get('[data-testid="agent-new-task-sunke"]').trigger('click')
    await Promise.resolve()
    expect(profilesState.switchProfile).not.toHaveBeenCalled()
    expect(routerState.push).toHaveBeenCalledWith({
      name: 'hermes.chat',
      query: { profile: 'sunke', new: '1' },
    })
  })

  // Guards the window between switchProfile() and the session being rebound.
  it('flags agentSwitching while the swap is in flight and clears it after', async () => {
    const seen: boolean[] = []
    profilesState.switchProfile.mockImplementationOnce(async (name: string) => {
      seen.push(chatState.agentSwitching)
      profilesState.activeProfileName = name
      return true
    })
    const wrapper = mountView()
    await wrapper.get('[data-testid="agent-new-task-webui_c84d5851f3c0_coder_c84a9e3ad1"]').trigger('click')
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toEqual([true])
    expect(chatState.agentSwitching).toBe(false)
  })

  it('does not navigate when the profile switch fails', async () => {
    profilesState.switchProfile.mockResolvedValueOnce(false)
    const wrapper = mountView()
    await wrapper.get('[data-testid="agent-new-task-webui_c84d5851f3c0_coder_c84a9e3ad1"]').trigger('click')
    await Promise.resolve()

    expect(routerState.push).not.toHaveBeenCalled()
    expect(chatState.newChat).not.toHaveBeenCalled()
    expect(chatState.agentSwitching).toBe(false)
  })

  it('opens the detail page when the card body is clicked', async () => {
    const wrapper = mountView()
    await wrapper.get('[data-testid="agent-card-sunke"]').trigger('click')
    expect(routerState.push).toHaveBeenCalledWith({ name: 'hermes.agentDetail', params: { name: 'sunke' } })
    expect(chatState.newChat).not.toHaveBeenCalled()
  })
})
