// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PluginsView from '@/views/hermes/PluginsView.vue'

const fetchPluginsMock = vi.hoisted(() => vi.fn())
const isStoredSuperAdminMock = vi.hoisted(() => vi.fn(() => false))
const profilesStoreMock = vi.hoisted(() => ({
  activeProfileName: 'feishu_user_a',
  profiles: [{ name: 'feishu_user_a' }],
  fetchProfiles: vi.fn(),
}))

vi.mock('@/api/hermes/plugins', () => ({
  fetchPlugins: fetchPluginsMock,
}))

vi.mock('@/api/client', () => ({
  isStoredSuperAdmin: isStoredSuperAdminMock,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStoreMock,
}))

vi.mock('@/utils/clipboard', () => ({
  copyToClipboard: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'plugins.capabilities.tools') return `tools:${params?.count}`
      if (key === 'plugins.capabilities.hooks') return `hooks:${params?.count}`
      if (key === 'plugins.capabilities.env') return `env:${params?.count}`
      return key
    },
    te: () => false,
  }),
}))

vi.mock('naive-ui', () => ({
  NAlert: { template: '<div><slot /></div>' },
  NButton: { template: '<button><slot /></button>' },
  NEmpty: { props: ['description'], template: '<div>{{ description }}</div>' },
  NInput: { template: '<input />' },
  NSelect: { template: '<div />' },
  NSpin: { template: '<div><slot /></div>' },
  NTag: { template: '<span><slot /></span>' },
  useMessage: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
}))

describe('PluginsView read-only mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isStoredSuperAdminMock.mockReturnValue(false)
    fetchPluginsMock.mockResolvedValue({
      plugins: [{
        key: 'sample-plugin',
        name: 'Sample Plugin',
        kind: 'plugin',
        source: 'user',
        configStatus: 'enabled',
        effectiveStatus: 'enabled',
        version: '1.0.0',
        description: 'Sample description',
        author: 'Hermes',
        path: '/Users/kite/.claude/plugins/sample-plugin',
        providesTools: ['sample_tool'],
        providesHooks: [],
        requiresEnv: [],
      }],
      warnings: [],
      metadata: {
        hermesAgentRoot: '/Users/kite/.hermes/hermes-agent',
        pythonExecutable: '/usr/bin/python3',
        cwd: '/Users/kite/code/hermes-web-ui',
        projectPluginsEnabled: true,
      },
    })
  })

  it('shows plugin inventory without exposing host paths or CLI commands to ordinary users', async () => {
    const wrapper = mount(PluginsView)
    await flushPromises()

    expect(wrapper.text()).toContain('sample-plugin')
    expect(wrapper.text()).toContain('tools:1')
    expect(wrapper.text()).not.toContain('/Users/kite/.claude/plugins/sample-plugin')
    expect(wrapper.text()).not.toContain('plugins.copyCommand')
    expect(wrapper.text()).not.toContain('/Users/kite/.hermes/hermes-agent')
  })
})
