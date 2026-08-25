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

  it('renders the KippiesWork wordmark in the sidebar brand link', () => {
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

    const logoLink = wrapper.find('.sidebar-logo')
    expect(logoLink.exists()).toBe(true)
    // The logo is the design's finished combination mark, shipped as FOUR
    // bitmaps: mascot and wordmark are separate images (so the mascot can be
    // resized without dragging the lettering with it), each with a light and a
    // dark copy, since the ink is baked into the pixels. It replaced a merged
    // SVG outline of the wordmark alone.
    //
    // All four are in the DOM on purpose: the theme swap is a CSS rule
    // (`.kwlogo-l` / `.kwlogo-d`) rather than a JS pick, so the first frame is
    // already right instead of flashing the light logo in dark mode.
    const imgs = logoLink.findAll('img')
    expect(imgs).toHaveLength(4)
    expect(imgs.filter((i) => i.classes().includes('kwlogo-l'))).toHaveLength(2)
    expect(imgs.filter((i) => i.classes().includes('kwlogo-d'))).toHaveLength(2)
    // One accessible name for the whole logo, not four.
    expect(imgs.filter((i) => i.attributes('alt'))).toHaveLength(1)
    expect(imgs[0].attributes('alt')).toBe('KippiesWork')
    expect(imgs.slice(1).every((i) => i.attributes('aria-hidden') === 'true')).toBe(true)
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
    expect(wrapper.text()).toContain('sidebar.files')
    expect(wrapper.text()).not.toContain('sidebar.expert')
    expect(wrapper.text()).not.toContain('sidebar.jobs')
    expect(wrapper.text()).not.toContain('sidebar.connectors')
    expect(wrapper.findComponent({ name: 'ThemeSwitch' }).exists()).toBe(false)
    expect(wrapper.find('.status-indicator').exists()).toBe(false)
    expect(wrapper.find('.version-info').exists()).toBe(false)
    expect(wrapper.find('.update-btn').exists()).toBe(false)
    expect(wrapper.find('.sidebar-return-tab').exists()).toBe(true)
  })

  it('uses a Keep icon-font glyph for the files nav item', () => {
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

    const filesItem = wrapper
      .findAll('.route-link-item')
      .find(item => item.text().includes('sidebar.files'))

    expect(filesItem).toBeTruthy()
    // Icons come from the Keep icon font (494 glyphs); the design system does
    // not allow hand-rolled SVG or Unicode stand-ins for them.
    expect(filesItem?.find('i.kp-icon-font').classes()).toContain('kp_ic_line_drawer')
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
    expect(wrapper.text()).toContain('sidebar.files')
    expect(wrapper.text()).not.toContain('sidebar.expert')
    expect(wrapper.text()).not.toContain('sidebar.jobs')
    expect(wrapper.text()).not.toContain('sidebar.connectors')
    expect(wrapper.findComponent({ name: 'ThemeSwitch' }).exists()).toBe(false)
  })

  it('no longer carries the pages that moved into 设置 tabs', async () => {
    localStorage.setItem('hermes_api_key', makeToken({ username: 'sunke', role: 'super_admin' }))

    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
          teleport: true,
        },
      },
    })

    // 2026-08-18: 看板/记忆/用量/技能用量 and the whole 群系统 group are tabs
    // inside 设置 now, so the product has a single sidebar. Their old paths
    // still resolve — the router redirects each one to its tab.
    expect(wrapper.text()).not.toContain('sidebar.plugins')
    expect(wrapper.text()).not.toContain('sidebar.mcp')
    expect(wrapper.text()).not.toContain('sidebar.codingAgents')
    expect(wrapper.text()).not.toContain('sidebar.devices')
    expect(wrapper.text()).not.toContain('sidebar.kanban')
    expect(wrapper.text()).not.toContain('sidebar.memory')
    expect(wrapper.text()).not.toContain('sidebar.skillsUsage')

    expect(wrapper.text()).toContain('sidebar.files')
    // Expert / skills / connectors are now sections behind one market entry,
    // not three rail rows; automation stays a primary rail entry.
    expect(wrapper.text()).toContain('sidebar.market')
    expect(wrapper.text()).toContain('sidebar.marketHint')
    expect(wrapper.text()).toContain('sidebar.jobs')
    expect(wrapper.text()).not.toContain('sidebar.expert')
    // The theme control moved into the UserMenu (prototype): appearance is a
    // KpThemeSeg row, plus language for super-admins, behind the account row.
    await wrapper.get('[data-testid="app-sidebar-user-trigger"]').trigger('click')
    expect(wrapper.findComponent({ name: 'KpThemeSeg' }).exists()).toBe(true)
    expect(wrapper.text()).toContain('language.label')
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
    // The redundant profile id is no longer rendered in the sidebar user card.
    expect(wrapper.text()).not.toContain('sunke')
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
          // Sign-out now lives in the teleported UserMenu; stub the teleport
          // so the menu renders in-tree for the wrapper to reach.
          teleport: true,
        },
      },
    })

    await wrapper.get('[data-testid="app-sidebar-user-trigger"]').trigger('click')
    await wrapper.get('[data-testid="user-menu-logout"]').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/feishu/logout', expect.objectContaining({
      credentials: 'same-origin',
      method: 'POST',
    }))
    expect(localStorage.getItem('hermes_auth_mode')).toBeNull()
    expect(localStorage.getItem('hermes_api_key')).toBeNull()
    expect(reloadMock).toHaveBeenCalledOnce()
  })

  it('keeps group folding active when collapsed', async () => {
    // The folding groups are admin-only, so this needs a super-admin session.
    localStorage.setItem('hermes_api_key', makeToken({ username: 'sunke', role: 'super_admin' }))
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

    // One folding group left — operations. The market used to be a second
    // fold; it is now a single flat entry whose three sections are tabs on the
    // page it opens.
    const toggles = wrapper.findAll('.nav-group-toggle')
    expect(toggles.map(node => node.text())).toEqual(['sidebar.groupSystem'])

    // Folding stays functional while collapsed: the group is open by default
    // and the toggle closes it. (The subgroup is hidden by CSS in the rail;
    // the `open` class is the state the animation keys off.)
    const opsGroup = wrapper.findAll('.nav-subgroup')[0]
    expect(opsGroup.classes()).toContain('open')

    await toggles[0].trigger('click')
    expect(wrapper.findAll('.nav-subgroup')[0].classes()).not.toContain('open')
  })
})
