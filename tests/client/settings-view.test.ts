// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const isUserModeMock = vi.hoisted(() => vi.fn(() => false))
const fetchSettingsMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  isUserMode: isUserModeMock,
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => ({
    loading: false,
    saving: false,
    fetchSettings: fetchSettingsMock,
  }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<any>('naive-ui')
  return {
    ...actual,
    NTabs: { template: '<div><slot /></div>' },
    NTabPane: { template: '<section><slot /></section>' },
    NSpin: { template: '<div><slot /></div>' },
  }
})

vi.mock('@/components/hermes/settings/AccountSettings.vue', () => ({
  default: { template: '<div>AccountSettings</div>' },
}))
vi.mock('@/components/hermes/settings/DisplaySettings.vue', () => ({
  default: { template: '<div>DisplaySettings</div>' },
}))
vi.mock('@/components/hermes/settings/AgentSettings.vue', () => ({
  default: { template: '<div>AgentSettings</div>' },
}))
vi.mock('@/components/hermes/settings/MemorySettings.vue', () => ({
  default: { template: '<div>MemorySettings</div>' },
}))
vi.mock('@/components/hermes/settings/SessionSettings.vue', () => ({
  default: { template: '<div>SessionSettings</div>' },
}))
vi.mock('@/components/hermes/settings/PrivacySettings.vue', () => ({
  default: { template: '<div>PrivacySettings</div>' },
}))
vi.mock('@/components/hermes/settings/ModelSettings.vue', () => ({
  default: { template: '<div>ModelSettings</div>' },
}))
vi.mock('@/components/hermes/settings/VoiceSettings.vue', () => ({
  default: { template: '<div>VoiceSettings</div>' },
}))

import SettingsView from '@/views/hermes/SettingsView.vue'

describe('SettingsView user mode', () => {
  beforeEach(() => {
    isUserModeMock.mockReturnValue(false)
    fetchSettingsMock.mockClear()
  })

  it('hides account and model settings in chat plane user mode', () => {
    isUserModeMock.mockReturnValue(true)

    const wrapper = mount(SettingsView)

    expect(wrapper.text()).toContain('settings.userMode.title')
    expect(wrapper.text()).toContain('settings.userMode.description')
    expect(wrapper.text()).toContain('DisplaySettings')
    expect(wrapper.text()).toContain('AgentSettings')
    expect(wrapper.text()).toContain('MemorySettings')
    expect(wrapper.text()).not.toContain('AccountSettings')
    expect(wrapper.text()).not.toContain('ModelSettings')
  })

  it('keeps account and model settings outside chat plane user mode', () => {
    const wrapper = mount(SettingsView)

    expect(wrapper.text()).toContain('AccountSettings')
    expect(wrapper.text()).toContain('ModelSettings')
  })
})
