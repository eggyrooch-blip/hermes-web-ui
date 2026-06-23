// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const openSessionSearchMock = vi.hoisted(() => vi.fn())
const fetchCurrentUserMock = vi.hoisted(() => vi.fn())
const mockAppStore = vi.hoisted(() => ({
  sidebarOpen: true,
  sidebarCollapsed: false,
  connected: true,
  serverVersion: 'test',
  latestVersion: '',
  updateAvailable: false,
  clientOutdated: false,
  updating: false,
  toggleSidebar: vi.fn(),
  toggleSidebarCollapsed: vi.fn(),
  closeSidebar: vi.fn(),
  doUpdate: vi.fn(),
  reloadClient: vi.fn(),
}))
const mockProfilesStore = vi.hoisted(() => ({
  currentUser: null as Record<string, any> | null,
  activeProfileName: 'feishu_user_a',
  setBoundProfile: vi.fn(),
  setCurrentUser: vi.fn(),
}))

vi.mock('@/composables/useSessionSearch', () => ({
  useSessionSearch: () => ({
    openSessionSearch: openSessionSearchMock,
  }),
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => mockAppStore,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => mockProfilesStore,
}))

vi.mock('@/api/auth', () => ({
  fetchCurrentUser: fetchCurrentUserMock,
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    useRoute: () => ({ name: 'hermes.chat' }),
    useRouter: () => ({ push: vi.fn(), hasRoute: () => true }),
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
  createI18n: () => ({
    global: { locale: { value: 'en' }, setLocaleMessage: vi.fn() },
  }),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isDark: false }),
}))

vi.mock('/logo.png', () => ({
  default: 'logo.png',
}))

vi.mock('@/components/layout/ProfileSelector.vue', () => ({
  default: { name: 'ProfileSelector', template: '<div />' },
}))

vi.mock('@/components/layout/ModelSelector.vue', () => ({
  default: { name: 'ModelSelector', template: '<div />' },
}))

vi.mock('@/components/layout/LanguageSwitch.vue', () => ({
  default: { name: 'LanguageSwitch', template: '<div />' },
}))

vi.mock('@/components/layout/ThemeSwitch.vue', () => ({
  default: { name: 'ThemeSwitch', template: '<div />' },
}))

vi.mock('@/components/common/RouteLinkItem.vue', () => ({
  default: {
    name: 'RouteLinkItem',
    props: ['to', 'active'],
    template: '<a class="route-link-item" :class="{ active }" href="#"><slot /></a>',
  },
}))

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<any>('naive-ui')
  return {
    ...actual,
    useMessage: () => ({
      success: vi.fn(),
      error: vi.fn(),
    }),
    NButton: {
      template: '<button v-bind="$attrs"><slot /></button>',
    },
    NSelect: {
      template: '<div />',
    },
  }
})

import AppSidebar from '@/components/layout/AppSidebar.vue'

function makeToken(payload: Record<string, unknown>): string {
  const b64 = (obj: Record<string, unknown>) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `header.${b64(payload)}.sig`
}

describe('AppSidebar navigation', () => {
  beforeEach(() => {
    localStorage.clear()
    openSessionSearchMock.mockClear()
    mockProfilesStore.currentUser = null
    mockProfilesStore.activeProfileName = 'feishu_user_a'
    mockProfilesStore.setBoundProfile.mockClear()
    mockProfilesStore.setCurrentUser.mockClear()
    fetchCurrentUserMock.mockReset()
    fetchCurrentUserMock.mockResolvedValue({
      name: '孙可',
      profile: 'sunke',
      avatarUrl: 'https://example.com/current-avatar.png',
    })
    mockAppStore.serverVersion = 'test'
    mockAppStore.latestVersion = ''
    mockAppStore.updateAvailable = false
    mockAppStore.clientOutdated = false
    mockAppStore.updating = false
    mockAppStore.sidebarCollapsed = false
    mockAppStore.reloadClient.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps page-sidebar-only actions out of the app sidebar', () => {
    mockAppStore.serverVersion = '0.6.15'
    mockAppStore.latestVersion = '0.6.17'
    mockAppStore.updateAvailable = true
    mockAppStore.clientOutdated = true
    ;(window as any).hermesDesktop = { isDesktop: true }
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    expect(wrapper.text()).not.toContain('sidebar.search')
    expect(wrapper.text()).not.toContain('sidebar.reloadClientVersion')
    expect(wrapper.text()).not.toContain('sidebar.updateVersion')
    expect(wrapper.text()).not.toContain('sidebar.versionManagement')
    expect(wrapper.text()).not.toContain('Studio v')
    expect(wrapper.text()).not.toContain('sidebar.channels')
    expect(wrapper.text()).not.toContain('sidebar.logs')
    expect(wrapper.text()).not.toContain('sidebar.devices')
    expect(wrapper.text()).not.toContain('sidebar.models')
    expect(wrapper.text()).not.toContain('sidebar.mcp')
    expect(wrapper.text()).not.toContain('sidebar.plugins')
    expect(wrapper.text()).not.toContain('sidebar.codingAgents')
    expect(wrapper.text()).toContain('sidebar.expert')
    expect(wrapper.text()).toContain('sidebar.jobs')
    expect(wrapper.text()).not.toContain('sidebar.connectors')
    expect(wrapper.findComponent({ name: 'ThemeSwitch' }).exists()).toBe(false)
    expect(wrapper.find('.status-indicator').exists()).toBe(false)
    expect(wrapper.find('.version-info').exists()).toBe(false)
    expect(wrapper.find('.update-btn').exists()).toBe(false)
    expect(wrapper.find('.sidebar-return-tab').exists()).toBe(true)
  })

  it.each([
    'feishu-oauth-dev',
    'trusted-feishu',
  ])('does not show admin nav from a stale super-admin JWT in %s mode', (authMode) => {
    localStorage.setItem('hermes_auth_mode', authMode)
    localStorage.setItem('hermes_api_key', makeToken({ username: 'sunke', role: 'super_admin' }))

    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    expect(wrapper.text()).not.toContain('sidebar.channels')
    expect(wrapper.text()).not.toContain('sidebar.logs')
    expect(wrapper.text()).not.toContain('sidebar.devices')
    expect(wrapper.text()).not.toContain('sidebar.models')
    expect(wrapper.text()).not.toContain('sidebar.mcp')
    expect(wrapper.text()).not.toContain('sidebar.plugins')
    expect(wrapper.text()).not.toContain('sidebar.codingAgents')
    expect(wrapper.text()).toContain('sidebar.expert')
    expect(wrapper.text()).toContain('sidebar.jobs')
    expect(wrapper.text()).not.toContain('sidebar.connectors')
    expect(wrapper.findComponent({ name: 'ThemeSwitch' }).exists()).toBe(false)
  })

  it('keeps plugin and MCP technical nav available for super-admins', () => {
    localStorage.setItem('hermes_api_key', makeToken({ username: 'sunke', role: 'super_admin' }))

    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    expect(wrapper.text()).toContain('sidebar.plugins')
    expect(wrapper.text()).toContain('sidebar.mcp')
    expect(wrapper.text()).toContain('sidebar.codingAgents')
    expect(wrapper.text()).toContain('sidebar.devices')
    expect(wrapper.text()).toContain('sidebar.expert')
    expect(wrapper.text()).toContain('sidebar.connectors')
    expect(wrapper.findComponent({ name: 'ThemeSwitch' }).exists()).toBe(true)
  })

  it('renders the Feishu authenticated user card with the Feishu avatar', () => {
    mockProfilesStore.currentUser = {
      name: '孙可',
      profile: 'sunke',
      avatarUrl: 'https://example.com/feishu-avatar.png',
    }

    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    const avatar = wrapper.get('img.user-avatar')
    expect(avatar.attributes('src')).toBe('https://example.com/feishu-avatar.png')
    expect(wrapper.text()).toContain('孙可')
    expect(wrapper.text()).toContain('sunke')
    expect(wrapper.find('.logout-username').exists()).toBe(false)
  })

  it('refreshes the Feishu user card from /api/auth/me even when a stale user was restored', async () => {
    mockProfilesStore.currentUser = {
      name: '旧用户',
      profile: 'old_profile',
      avatarUrl: 'https://example.com/old-avatar.png',
    }
    fetchCurrentUserMock.mockResolvedValueOnce({
      name: '孙可',
      profile: 'sunke',
      avatarUrl: 'https://example.com/feishu-avatar.png',
    })

    mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })
    await flushPromises()

    expect(fetchCurrentUserMock).toHaveBeenCalledOnce()
    expect(mockProfilesStore.setBoundProfile).toHaveBeenCalledWith('sunke', {
      name: '孙可',
      profile: 'sunke',
      avatarUrl: 'https://example.com/feishu-avatar.png',
    })
  })

  it('clears the Feishu session cookie on logout before reloading', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    const reloadMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('location', { ...window.location, reload: reloadMock })
    localStorage.setItem('hermes_auth_mode', 'feishu-oauth-dev')
    localStorage.setItem('hermes_api_key', makeToken({ username: 'sunke', role: 'super_admin' }))
    mockProfilesStore.currentUser = {
      name: '孙可',
      profile: 'sunke',
      avatarUrl: 'https://example.com/feishu-avatar.png',
    }
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    await wrapper.get('.card-logout-button').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/feishu/logout', expect.objectContaining({
      credentials: 'same-origin',
      method: 'POST',
    }))
    expect(localStorage.getItem('hermes_auth_mode')).toBeNull()
    expect(localStorage.getItem('hermes_api_key')).toBeNull()
    expect(reloadMock).toHaveBeenCalledOnce()
  })

  it('uses short group labels and keeps group folding active when collapsed', async () => {
    mockAppStore.sidebarCollapsed = true
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    expect(wrapper.classes()).toContain('collapsed')
    expect(wrapper.findAll('.nav-group-label span').map(node => node.text())).toEqual([
      'sidebar.groupAgentShort',
      'sidebar.groupMonitoringShort',
      'sidebar.groupSystemShort',
    ])

    const agentGroup = wrapper.findAll('.nav-group')[0]
    expect(agentGroup.find('.nav-group-items').attributes('style')).toBeUndefined()

    await agentGroup.find('.nav-group-label').trigger('click')
    expect(agentGroup.find('.nav-group-items').attributes('style')).toContain('display: none')
  })
})
