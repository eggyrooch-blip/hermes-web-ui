// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useProfilesStore } from '@/stores/hermes/profiles'

const openSessionSearchMock = vi.hoisted(() => vi.fn())
const pushMock = vi.hoisted(() => vi.fn())
const replaceMock = vi.hoisted(() => vi.fn())
const getAuthModeMock = vi.hoisted(() => vi.fn(() => 'token'))
const getWebPlaneMock = vi.hoisted(() => vi.fn(() => 'both'))
const isUserModeMock = vi.hoisted(() => vi.fn(() => false))
const setRuntimeModeMock = vi.hoisted(() => vi.fn())
const fetchCurrentUserMock = vi.hoisted(() => vi.fn())
const appStoreMock = vi.hoisted(() => ({
  sidebarOpen: true,
  sidebarCollapsed: false,
  connected: true,
  serverVersion: 'test',
  toggleSidebar: vi.fn(),
  closeSidebar: vi.fn(),
  toggleSidebarCollapsed: vi.fn(),
  checkConnection: vi.fn(),
}))
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

vi.mock('@/composables/useSessionSearch', () => ({
  useSessionSearch: () => ({
    openSessionSearch: openSessionSearchMock,
  }),
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => appStoreMock,
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    useRoute: () => ({ name: 'hermes.chat' }),
    useRouter: () => ({ push: pushMock, replace: replaceMock }),
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isDark: false }),
}))

vi.mock('@/api/client', () => ({
  getAuthMode: getAuthModeMock,
  getWebPlane: getWebPlaneMock,
  isUserMode: isUserModeMock,
  setRuntimeMode: setRuntimeModeMock,
}))

vi.mock('@/api/auth', () => ({
  fetchCurrentUser: fetchCurrentUserMock,
}))

vi.mock('/logo.png', () => ({
  default: 'logo.png',
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
      template: '<button><slot /></button>',
    },
    NSelect: {
      template: '<div />',
    },
  }
})

import AppSidebar from '@/components/layout/AppSidebar.vue'

describe('AppSidebar search entry', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    openSessionSearchMock.mockClear()
    pushMock.mockClear()
    replaceMock.mockClear()
    getAuthModeMock.mockReturnValue('token')
    getWebPlaneMock.mockReturnValue('both')
    isUserModeMock.mockReturnValue(false)
    appStoreMock.sidebarCollapsed = false
    appStoreMock.connected = true
    appStoreMock.checkConnection.mockClear()
    setRuntimeModeMock.mockClear()
    fetchCurrentUserMock.mockRejectedValue(new Error('not logged in'))
    fetchMock.mockReset()
  })

  it('opens the session search modal from the sidebar button', async () => {
    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [createPinia()],
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    const buttons = wrapper.findAll('button')
    const searchButton = buttons.find(node => node.text().includes('sidebar.search'))
    expect(searchButton).toBeTruthy()

    await searchButton!.trigger('click')
    expect(openSessionSearchMock).toHaveBeenCalledTimes(1)
  })

  it('does not show Web UI version, changelog, or browser update controls', () => {
    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [createPinia()],
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    expect(wrapper.text()).not.toContain('Hermes Web UI')
    expect(wrapper.find('a[href="https://github.com/EKKOLearnAI/hermes-web-ui"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('sidebar.updateVersion')
    expect(wrapper.text()).not.toContain('sidebar.changelog')
  })

  it('hides admin editing surfaces in chat plane user mode', () => {
    getWebPlaneMock.mockReturnValue('chat')
    isUserModeMock.mockReturnValue(true)

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [createPinia()],
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    expect(wrapper.text()).toContain('sidebar.jobs')
    expect(wrapper.text()).toContain('sidebar.skills')
    expect(wrapper.text()).toContain('sidebar.memory')
    expect(wrapper.text()).toContain('sidebar.files')
    expect(wrapper.text()).toContain('sidebar.usage')
    expect(wrapper.text()).toContain('sidebar.settings')
    expect(wrapper.text()).not.toContain('sidebar.channels')
    expect(wrapper.text()).not.toContain('sidebar.models')
    expect(wrapper.text()).not.toContain('sidebar.logs')
    expect(wrapper.text()).not.toContain('sidebar.gateways')
    expect(wrapper.text()).not.toContain('sidebar.profiles')
  })

  it('keeps the upstream model selector visible in chat plane user mode', () => {
    getWebPlaneMock.mockReturnValue('chat')
    isUserModeMock.mockReturnValue(true)

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [createPinia()],
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    expect(wrapper.find('model-selector-stub').exists()).toBe(true)
    expect(wrapper.find('profile-selector-stub').exists()).toBe(true)
  })

  it('shows only name and profile in the user identity card', () => {
    getWebPlaneMock.mockReturnValue('chat')
    isUserModeMock.mockReturnValue(true)
    appStoreMock.connected = false
    const pinia = createPinia()
    setActivePinia(pinia)
    const profilesStore = useProfilesStore(pinia)
    profilesStore.setBoundProfile('g41a5b5g', {
      openid: 'ou_cf23e7c262afa4b7a006baa75f863ed5',
      profile: 'g41a5b5g',
      role: 'user',
      name: '陈先生',
      avatarUrl: 'https://example.com/avatar.png',
    })

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [pinia],
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    expect(wrapper.text()).toContain('陈先生')
    expect(wrapper.text()).not.toContain('飞书 OAuth')
    expect(wrapper.text()).not.toContain('飞书登录')
    expect(wrapper.text()).toContain('g41a5b5g')
    expect(wrapper.text()).not.toContain('已锁定')
    expect(wrapper.text()).not.toContain('ou_cf23e')
    const card = wrapper.find('.sidebar-user')
    expect(card.find('.user-avatar').attributes('src')).toBe('https://example.com/avatar.png')
    expect(card.find('.user-status-dot.standby').exists()).toBe(true)
    expect(card.find('theme-switch-stub').exists()).toBe(true)
    expect(card.find('.card-logout-button').exists()).toBe(true)
    expect(card.find('.card-logout-button').text()).toBe('')
    expect(wrapper.find('.sidebar-footer .logout-item').exists()).toBe(false)
    expect(wrapper.find('.sidebar-footer .status-row').exists()).toBe(false)
    expect(card.find('language-switch-stub').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('sidebar.connected')
    expect(wrapper.text()).not.toContain('sidebar.disconnected')
  })

  it('renders the upstream profile selector in user mode for owner-scoped profiles', () => {
    getWebPlaneMock.mockReturnValue('chat')
    isUserModeMock.mockReturnValue(true)
    const pinia = createPinia()
    setActivePinia(pinia)
    const profilesStore = useProfilesStore(pinia)
    profilesStore.setBoundProfile('g41a5b5g', {
      openid: 'ou_cf23e7c262afa4b7a006baa75f863ed5',
      profile: 'g41a5b5g',
      role: 'user',
      name: '陈先生',
    })

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [pinia],
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    expect(wrapper.find('profile-selector-stub').exists()).toBe(true)
  })

  it('clears the Feishu OAuth session cookie on logout', async () => {
    getAuthModeMock.mockReturnValue('feishu-oauth-dev')
    getWebPlaneMock.mockReturnValue('chat')
    isUserModeMock.mockReturnValue(true)
    fetchMock.mockResolvedValue({ ok: true })
    localStorage.setItem('hermes_current_user', 'cached')

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [createPinia()],
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    const logoutButton = wrapper.find('.card-logout-button')
    expect(logoutButton.exists()).toBe(true)

    await logoutButton.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/feishu/logout', { method: 'POST' })
    expect(localStorage.getItem('hermes_current_user')).toBeNull()
    expect(setRuntimeModeMock).toHaveBeenCalledWith('feishu-oauth-dev', 'chat')
    expect(replaceMock).toHaveBeenCalledWith({ name: 'login' })
  })

  it('loads the bound Feishu profile without issuing a frontend wake request', async () => {
    getAuthModeMock.mockReturnValue('feishu-oauth-dev')
    getWebPlaneMock.mockReturnValue('chat')
    isUserModeMock.mockReturnValue(true)
    fetchCurrentUserMock.mockResolvedValue({
      openid: 'ou_bound',
      profile: 'g41a5b5g',
      role: 'user',
      name: '陈先生',
    })
    const pinia = createPinia()

    mount(AppSidebar, {
      global: {
        plugins: [pinia],
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    const profilesStore = useProfilesStore(pinia)
    expect(profilesStore.activeProfileName).toBe('g41a5b5g')
  })

  it('does not render the retired Feishu connector in the sidebar', async () => {
    getAuthModeMock.mockReturnValue('feishu-oauth-dev')
    getWebPlaneMock.mockReturnValue('chat')
    isUserModeMock.mockReturnValue(true)
    fetchCurrentUserMock.mockResolvedValue({
      openid: 'ou_bound',
      profile: 'g41a5b5g',
      role: 'user',
      name: '陈先生',
    })

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [createPinia()],
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.sidebar-integrations').exists()).toBe(false)
    expect(wrapper.find('.feishu-connector').exists()).toBe(false)
  })

  it('shows credentials in the Agent group navigation', async () => {
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

    const agentGroup = wrapper.findAll('.nav-group')[1]
    expect(agentGroup.text()).toContain('sidebar.credentials')

    const credentialsButton = agentGroup.findAll('.nav-item').find(node => node.text().includes('sidebar.credentials'))
    expect(credentialsButton).toBeTruthy()
    await credentialsButton!.trigger('click')

    expect(pushMock).toHaveBeenCalledWith({ name: 'hermes.credentials' })
  })

  it('uses short group labels and keeps group folding active when collapsed', async () => {
    appStoreMock.sidebarCollapsed = true
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
      'sidebar.groupConversationShort',
      'sidebar.groupAgentShort',
      'sidebar.groupMonitoringShort',
      'sidebar.groupSystemShort',
    ])

    const agentGroup = wrapper.findAll('.nav-group')[1]
    expect(agentGroup.find('.nav-group-items').attributes('style')).toBeUndefined()

    await agentGroup.find('.nav-group-label').trigger('click')
    expect(agentGroup.find('.nav-group-items').attributes('style')).toContain('display: none')
  })
})
