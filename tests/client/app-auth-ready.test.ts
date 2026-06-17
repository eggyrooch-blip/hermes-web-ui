// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

const routeState = vi.hoisted(() => ({ name: 'hermes.logs' as string }))
const authReadyBox = vi.hoisted(() => ({ ref: undefined as undefined | { value: boolean } }))
const routeContentReadyBox = vi.hoisted(() => ({ ref: undefined as undefined | { value: boolean } }))
const loadModelsMock = vi.hoisted(() => vi.fn())
const startHealthPollingMock = vi.hoisted(() => vi.fn())
const stopHealthPollingMock = vi.hoisted(() => vi.fn())

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
}))

vi.mock('@/router', async () => {
  const { ref } = await import('vue')
  const authNavigationReady = ref(false)
  const routeContentReady = ref(false)
  authReadyBox.ref = authNavigationReady
  routeContentReadyBox.ref = routeContentReady
  return {
    authNavigationReady,
    routeContentReady,
    default: { isReady: vi.fn(() => Promise.resolve()) },
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isDark: { value: false }, isComic: { value: false } }),
}))

vi.mock('@/styles/theme', () => ({
  getThemeOverrides: vi.fn(() => ({})),
}))

vi.mock('@/composables/useKeyboard', () => ({
  useKeyboard: vi.fn(),
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({
    nodeVersion: '24.0.0',
    sidebarOpen: true,
    loadModels: loadModelsMock,
    startHealthPolling: startHealthPollingMock,
    stopHealthPolling: stopHealthPollingMock,
    toggleSidebar: vi.fn(),
    closeSidebar: vi.fn(),
  }),
}))

vi.mock('@/components/layout/AppSidebar.vue', () => ({
  default: { template: '<aside data-test="app-sidebar" />' },
}))

vi.mock('@/components/layout/DesktopTitleBar.vue', () => ({
  default: { template: '<div data-test="desktop-titlebar" />' },
}))

vi.mock('@/components/hermes/chat/SessionSearchModal.vue', () => ({
  default: { template: '<div data-test="session-search" />' },
}))

vi.mock('@/components/auth/AuthEventListener.vue', () => ({
  default: { template: '<span data-test="auth-events" />' },
}))

vi.mock('@/components/auth/DefaultCredentialPrompt.vue', () => ({
  default: { template: '<div data-test="default-credential-prompt" />' },
}))

vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue')
  const passthrough = (name: string) => defineComponent({
    name,
    setup(_props, { slots }) {
      return () => h('div', { 'data-test': name }, slots.default?.())
    },
  })
  return {
    darkTheme: {},
    NConfigProvider: passthrough('n-config-provider'),
    NMessageProvider: passthrough('n-message-provider'),
    NDialogProvider: passthrough('n-dialog-provider'),
    NNotificationProvider: passthrough('n-notification-provider'),
  }
})

import App from '@/App.vue'

describe('App auth navigation readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    routeState.name = 'hermes.logs'
    if (authReadyBox.ref) authReadyBox.ref.value = false
    if (routeContentReadyBox.ref) routeContentReadyBox.ref.value = false
  })

  it('does not render protected chrome before auth navigation is settled', async () => {
    const wrapper = mount(App, {
      global: {
        stubs: {
          RouterView: { template: '<div data-test="router-view" />' },
        },
      },
    })

    expect(wrapper.find('[data-test="app-sidebar"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="router-view"]').exists()).toBe(false)
    expect(loadModelsMock).not.toHaveBeenCalled()
    expect(startHealthPollingMock).not.toHaveBeenCalled()
    expect(stopHealthPollingMock).toHaveBeenCalled()

    authReadyBox.ref!.value = true
    await nextTick()

    expect(wrapper.find('[data-test="app-sidebar"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="router-view"]').exists()).toBe(false)

    routeContentReadyBox.ref!.value = true
    await nextTick()

    expect(wrapper.find('[data-test="router-view"]').exists()).toBe(true)
    expect(loadModelsMock).toHaveBeenCalled()
    expect(startHealthPollingMock).toHaveBeenCalled()
  })
})
