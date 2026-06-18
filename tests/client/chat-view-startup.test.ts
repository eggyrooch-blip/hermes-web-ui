// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

const loadModelsMock = vi.hoisted(() => vi.fn())
const loadSessionsMock = vi.hoisted(() => vi.fn())
const setRuntimeModeMock = vi.hoisted(() => vi.fn())
const switchSessionMock = vi.hoisted(() => vi.fn())
const chatState = vi.hoisted(() => ({
  sessionProfileFilter: 'tester',
  activeSessionId: null as string | null,
  activeSession: null as { title?: string } | null,
  sessionsLoaded: false,
  sessions: [] as Array<{ id: string }>,
}))
const fetchProfilesMock = vi.hoisted(() => vi.fn())
const isStoredSuperAdminMock = vi.hoisted(() => vi.fn(() => false))
const profilesState = vi.hoisted(() => ({
  activeProfileName: 'tester',
}))
const fetchSettingsMock = vi.hoisted(() => vi.fn())
const routerReplaceMock = vi.hoisted(() => vi.fn())
const routeState = vi.hoisted(() => ({
  params: {} as Record<string, unknown>,
  query: {} as Record<string, unknown>,
}))

vi.mock('@/components/hermes/chat/ChatPanel.vue', () => ({
  default: { template: '<div data-test="chat-panel" />' },
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({
    loadModels: loadModelsMock,
  }),
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => ({
    loadSessions: loadSessionsMock,
    setRuntimeMode: setRuntimeModeMock,
    switchSession: switchSessionMock,
    get sessionProfileFilter() { return chatState.sessionProfileFilter },
    set sessionProfileFilter(value) { chatState.sessionProfileFilter = value },
    get activeSessionId() { return chatState.activeSessionId },
    get activeSession() { return chatState.activeSession },
    get sessionsLoaded() { return chatState.sessionsLoaded },
    get sessions() { return chatState.sessions },
  }),
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({
    fetchProfiles: fetchProfilesMock,
    get activeProfileName() { return profilesState.activeProfileName },
  }),
}))

vi.mock('@/api/client', () => ({
  isStoredSuperAdmin: isStoredSuperAdminMock,
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => ({
    fetchSettings: fetchSettingsMock,
  }),
}))

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({ replace: routerReplaceMock }),
}))

import ChatView from '@/views/hermes/ChatView.vue'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(res => { resolve = res })
  return { promise, resolve }
}

describe('ChatView startup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadModelsMock.mockResolvedValue(undefined)
    loadSessionsMock.mockResolvedValue(undefined)
    fetchProfilesMock.mockResolvedValue(undefined)
    fetchSettingsMock.mockResolvedValue(undefined)
    isStoredSuperAdminMock.mockReturnValue(false)
    routeState.params = {}
    routeState.query = {}
    chatState.sessionProfileFilter = 'tester'
    profilesState.activeProfileName = 'tester'
    chatState.activeSessionId = null
    chatState.activeSession = null
    chatState.sessionsLoaded = false
    chatState.sessions = []
  })

  it('loads profiles first, then sessions once the profile fetch resolves', async () => {
    // Upstream intentionally awaits the profile/settings fetch BEFORE loading
    // sessions, so the cache key uses the correct profile name. While the profile
    // promise is still pending, sessions must NOT have been loaded yet.
    const profiles = deferred()
    fetchProfilesMock.mockReturnValue(profiles.promise)
    fetchSettingsMock.mockResolvedValue(undefined)

    mount(ChatView)
    await nextTick()
    await Promise.resolve()

    expect(fetchProfilesMock).toHaveBeenCalled()
    expect(loadSessionsMock).not.toHaveBeenCalled()

    profiles.resolve()
    await nextTick()
    await Promise.resolve()
    await Promise.resolve()

    expect(loadSessionsMock).toHaveBeenCalled()
  })

  it('loads the route-selected session using the store profile filter', async () => {
    // Upstream loadRouteSession threads chatStore.sessionProfileFilter (not the
    // route query) as the profile arg into loadSessions, alongside the route sessionId.
    routeState.params = { sessionId: 'session-9' }
    chatState.sessionProfileFilter = 'tester'

    mount(ChatView)
    await nextTick()
    await Promise.resolve()

    expect(loadSessionsMock).toHaveBeenCalledWith('tester', 'session-9')
  })

  it('defaults employee chat sessions to the active frontend profile', async () => {
    chatState.sessionProfileFilter = null
    profilesState.activeProfileName = 'bianmaceshi'

    mount(ChatView)
    await nextTick()
    await Promise.resolve()
    await Promise.resolve()

    expect(chatState.sessionProfileFilter).toBe('bianmaceshi')
    expect(loadSessionsMock).toHaveBeenCalledWith('bianmaceshi', null)
  })

  it('uses the route profile query when opening a session link', async () => {
    routeState.params = { sessionId: 'session-9' }
    routeState.query = { profile: 'bianmaceshi' }
    chatState.sessionProfileFilter = null
    profilesState.activeProfileName = 'feishu_g41a5b5g'

    mount(ChatView)
    await nextTick()
    await Promise.resolve()
    await Promise.resolve()

    expect(chatState.sessionProfileFilter).toBe('bianmaceshi')
    expect(loadSessionsMock).toHaveBeenCalledWith('bianmaceshi', 'session-9')
  })
})
