// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const mockIsStoredSuperAdmin = vi.hoisted(() => vi.fn())
const mockReplace = vi.hoisted(() => vi.fn())
const mockRoute = vi.hoisted(() => ({
  query: {} as Record<string, unknown>,
}))
const mockSettingsStore = vi.hoisted(() => ({
  loading: false,
  saving: false,
  fetchSettings: vi.fn(),
}))
const mockProfilesStore = vi.hoisted(() => ({
  activeProfileName: 'sunke',
  profiles: [{ name: 'sunke' }],
  fetchProfiles: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  isStoredSuperAdmin: mockIsStoredSuperAdmin,
}))

vi.mock('vue-router', () => ({
  useRoute: () => mockRoute,
  useRouter: () => ({ replace: mockReplace, push: vi.fn() }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NSpin: {
    props: ['show', 'description'],
    template: '<div class="spin"><slot /></div>',
  },
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => mockSettingsStore,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => mockProfilesStore,
}))

vi.mock('@/components/hermes/settings/AccountSettings.vue', () => ({
  default: { name: 'AccountSettings', template: '<div>AccountSettings</div>' },
}))
vi.mock('@/components/hermes/settings/UserManagementSettings.vue', () => ({
  default: { name: 'UserManagementSettings', template: '<div>UserManagementSettings</div>' },
}))
vi.mock('@/components/hermes/settings/DisplaySettings.vue', () => ({
  default: { name: 'DisplaySettings', template: '<div>DisplaySettings</div>' },
}))
vi.mock('@/components/hermes/settings/AgentSettings.vue', () => ({
  default: { name: 'AgentSettings', template: '<div>AgentSettings</div>' },
}))
vi.mock('@/components/hermes/settings/GatewayAutoStartSettings.vue', () => ({
  default: { name: 'GatewayAutoStartSettings', template: '<div>GatewayAutoStartSettings</div>' },
}))
vi.mock('@/components/hermes/settings/MemorySettings.vue', () => ({
  default: { name: 'MemorySettings', template: '<div>MemorySettings</div>' },
}))
vi.mock('@/components/hermes/settings/CompressionSettings.vue', () => ({
  default: { name: 'CompressionSettings', template: '<div>CompressionSettings</div>' },
}))
vi.mock('@/components/hermes/settings/SessionSettings.vue', () => ({
  default: { name: 'SessionSettings', template: '<div>SessionSettings</div>' },
}))
vi.mock('@/components/hermes/settings/PrivacySettings.vue', () => ({
  default: { name: 'PrivacySettings', template: '<div>PrivacySettings</div>' },
}))
vi.mock('@/components/hermes/settings/ModelSettings.vue', () => ({
  default: { name: 'ModelSettings', template: '<div>ModelSettings</div>' },
}))
vi.mock('@/components/hermes/settings/VoiceSettings.vue', () => ({
  default: { name: 'VoiceSettings', template: '<div>VoiceSettings</div>' },
}))
vi.mock('@/components/hermes/settings/UsageSettings.vue', () => ({
  default: { name: 'UsageSettings', template: '<div>UsageSettings</div>' },
}))
vi.mock('@/components/hermes/settings/SkillListSettings.vue', () => ({
  default: { name: 'SkillListSettings', props: ['kind'], template: '<div>SkillListSettings:{{ kind }}</div>' },
}))
vi.mock('@/components/hermes/settings/MyTasksSettings.vue', () => ({
  default: { name: 'MyTasksSettings', template: '<div>MyTasksSettings</div>' },
}))
vi.mock('@/components/kippies/KpEmptyState.vue', () => ({
  default: { name: 'KpEmptyState', props: ['title', 'body'], template: '<div>KpEmptyState:{{ title }}</div>' },
}))

import SettingsView from '@/views/hermes/SettingsView.vue'

function railLabels(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('.settings-rail-row').map(row => row.text())
}

describe('SettingsView enterprise surface gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRoute.query = {}
    mockIsStoredSuperAdmin.mockReturnValue(false)
  })

  it('hides account and operations settings from non-super-admin users', () => {
    const wrapper = mount(SettingsView)

    const labels = railLabels(wrapper)
    expect(labels).not.toContain('settings.tabs.account')
    expect(labels).not.toContain('settings.tabs.users')
    expect(labels).not.toContain('settings.tabs.agent')
    expect(labels).not.toContain('settings.tabs.models')
    expect(labels).not.toContain('settings.tabs.voice')
    expect(wrapper.text()).not.toContain('AccountSettings')
    expect(wrapper.text()).not.toContain('GatewayAutoStartSettings')

    // Prototype tabs stay visible for everyone.
    expect(labels).toContain('settings.tabs.usage')
    expect(labels).toContain('settings.tabs.general')
    expect(labels).toContain('settings.tabs.created')
    expect(labels).toContain('settings.tabs.installed')
    expect(labels).toContain('settings.tabs.downloads')
    expect(labels).toContain('settings.tabs.tasks')
    expect(labels).toContain('settings.tabs.session')
    expect(labels).toContain('settings.tabs.privacy')

    // Pages that moved in from the old management sidebar are admin-only and
    // must not leak into a regular user's rail.
    expect(labels).not.toContain('sidebar.channels')
    expect(labels).not.toContain('sidebar.logs')
    expect(labels).not.toContain('sidebar.mcp')
    expect(labels).not.toContain('sidebar.devices')

    // …but the non-admin ones do show.
    expect(labels).toContain('sidebar.kanban')
    expect(labels).toContain('sidebar.memory')
    expect(labels).toContain('sidebar.skillsUsage')

    // Non-admin default pane is 用量 — now the full UsageView page.
    expect(wrapper.find('.settings-pane__page').exists()).toBe(true)
  })

  it('keeps enterprise settings visible for super-admin users', async () => {
    mockIsStoredSuperAdmin.mockReturnValue(true)

    const wrapper = mount(SettingsView)

    const labels = railLabels(wrapper)
    expect(labels).toContain('settings.tabs.account')
    expect(labels).toContain('settings.tabs.users')
    expect(labels).toContain('settings.tabs.agent')
    expect(labels).toContain('settings.tabs.models')
    expect(labels).toContain('settings.tabs.voice')

    // Prototype order: 账号信息 first and it is the admin default pane.
    expect(labels[0]).toBe('settings.tabs.account')
    expect(wrapper.text()).toContain('AccountSettings')

    // Panes mount on demand — switching to 代理 reveals the gateway block.
    const agentRow = wrapper.findAll('.settings-rail-row')
      .find(row => row.text() === 'settings.tabs.agent')
    expect(agentRow).toBeTruthy()
    await agentRow!.trigger('click')
    expect(wrapper.text()).toContain('AgentSettings')
    expect(wrapper.text()).toContain('GatewayAutoStartSettings')
  })

  it('folds the legacy display/memory deep links into 通用', () => {
    mockRoute.query = { tab: 'display' }
    const wrapper = mount(SettingsView)
    expect(wrapper.text()).toContain('DisplaySettings')
  })
})
