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
  useRouter: () => ({ replace: mockReplace }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NTabs: {
    props: ['value'],
    emits: ['update:value'],
    template: '<div class="tabs"><slot /></div>',
  },
  NTabPane: {
    props: ['name', 'tab'],
    template: '<section class="tab-pane" :data-name="name"><span class="tab-label">{{ tab }}</span><slot /></section>',
  },
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

import SettingsView from '@/views/hermes/SettingsView.vue'

describe('SettingsView enterprise surface gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRoute.query = {}
    mockIsStoredSuperAdmin.mockReturnValue(false)
  })

  it('hides account and operations settings from non-super-admin users', () => {
    const wrapper = mount(SettingsView)

    expect(wrapper.text()).not.toContain('settings.tabs.account')
    expect(wrapper.text()).not.toContain('settings.tabs.users')
    expect(wrapper.text()).not.toContain('settings.tabs.agent')
    expect(wrapper.text()).not.toContain('settings.tabs.models')
    expect(wrapper.text()).not.toContain('settings.tabs.voice')
    expect(wrapper.text()).not.toContain('AccountSettings')
    expect(wrapper.text()).not.toContain('GatewayAutoStartSettings')
    expect(wrapper.text()).toContain('settings.tabs.display')
    expect(wrapper.text()).toContain('settings.tabs.session')
    expect(wrapper.text()).toContain('settings.tabs.privacy')
  })

  it('keeps enterprise settings visible for super-admin users', () => {
    mockIsStoredSuperAdmin.mockReturnValue(true)

    const wrapper = mount(SettingsView)

    expect(wrapper.text()).toContain('settings.tabs.account')
    expect(wrapper.text()).toContain('settings.tabs.users')
    expect(wrapper.text()).toContain('settings.tabs.agent')
    expect(wrapper.text()).toContain('settings.tabs.models')
    expect(wrapper.text()).toContain('settings.tabs.voice')
    expect(wrapper.text()).toContain('AccountSettings')
    expect(wrapper.text()).toContain('GatewayAutoStartSettings')
  })
})
