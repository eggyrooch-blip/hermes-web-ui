// @vitest-environment jsdom
//
// Clicking a pending-approval notification must land on the session that is
// waiting, even when the user is browsing a different profile in that window.
// ChatView filters by profile and `loadSessions` only looks inside that
// profile, so the click URL has to carry the owning profile. These tests drive
// a REAL vue-router over the exact string the notification ships, covering
// both delivery paths: the in-page `onclick` (sets `location.hash`) and the
// service worker (`client.navigate('/#' + clickUrl)`).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createRouter, createWebHashHistory } from 'vue-router'
import { nextTick } from 'vue'

const loadModelsMock = vi.hoisted(() => vi.fn())
const loadSessionsMock = vi.hoisted(() => vi.fn())
const setRuntimeModeMock = vi.hoisted(() => vi.fn())
const switchSessionMock = vi.hoisted(() => vi.fn())
const newChatMock = vi.hoisted(() => vi.fn())
const fetchProfilesMock = vi.hoisted(() => vi.fn())
const fetchSettingsMock = vi.hoisted(() => vi.fn())
const isStoredSuperAdminMock = vi.hoisted(() => vi.fn(() => false))

const chatState = vi.hoisted(() => ({
  sessionProfileFilter: null as string | null,
  activeSessionId: null as string | null,
  activeSession: null as { title?: string; profile?: string } | null,
  sessionsLoaded: true,
  sessions: [] as Array<{ id: string; profile?: string; localCreated?: boolean }>,
}))

const profilesState = vi.hoisted(() => ({
  activeProfileName: 'profile-b',
  profilesLoaded: true,
  profiles: [{ name: 'profile-a' }, { name: 'profile-b' }],
}))

vi.mock('@/components/hermes/chat/ChatPanel.vue', () => ({
  default: { template: '<div data-test="chat-panel" />' },
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({ loadModels: loadModelsMock }),
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => ({
    loadSessions: loadSessionsMock,
    setRuntimeMode: setRuntimeModeMock,
    switchSession: switchSessionMock,
    newChat: newChatMock,
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
    get profilesLoaded() { return profilesState.profilesLoaded },
    get profiles() { return profilesState.profiles },
  }),
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => ({ fetchSettings: fetchSettingsMock }),
}))

vi.mock('@/api/client', () => ({
  isStoredSuperAdmin: isStoredSuperAdminMock,
}))

import ChatView from '@/views/hermes/ChatView.vue'
import { pendingRequestClickUrl } from '@/utils/pending-request-route'

/** The server only has this one session, and it belongs to profile A. */
const SESSION_A = { id: 'session-a', profile: 'profile-a' }

function makeRouter() {
  return createRouter({
    history: createWebHashHistory(),
    routes: [
      { path: '/hermes/chat', name: 'hermes.chat', component: ChatView },
      { path: '/hermes/session/:sessionId', name: 'hermes.session', component: ChatView },
    ],
  })
}

/**
 * Stand-in for the real `loadSessions`: it only finds the session when the
 * caller asks for the profile that owns it — which is exactly the behaviour
 * that makes the missing profile query a bug rather than a cosmetic detail.
 */
function serverLoadSessions(profile: string | null, sessionId?: string | null) {
  const visible = profile ? [SESSION_A].filter(session => session.profile === profile) : [SESSION_A]
  chatState.sessions = visible
  const target = sessionId ? visible.find(session => session.id === sessionId) : undefined
  chatState.activeSessionId = target ? target.id : null
  chatState.activeSession = target ? { ...target, title: 'release pipeline' } : null
  return Promise.resolve()
}

async function settle(router: ReturnType<typeof makeRouter>) {
  await router.isReady()
  for (let i = 0; i < 12; i += 1) {
    await nextTick()
    await Promise.resolve()
  }
}

describe('pending approval notification click target', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadModelsMock.mockResolvedValue(undefined)
    fetchProfilesMock.mockResolvedValue(undefined)
    fetchSettingsMock.mockResolvedValue(undefined)
    isStoredSuperAdminMock.mockReturnValue(false)
    loadSessionsMock.mockImplementation(serverLoadSessions)
    chatState.sessionProfileFilter = 'profile-b'
    chatState.activeSessionId = null
    chatState.activeSession = null
    chatState.sessionsLoaded = true
    chatState.sessions = []
    profilesState.activeProfileName = 'profile-b'
    window.location.hash = '#/hermes/chat'
  })

  it('builds a click URL that both delivery paths resolve to the owning profile', () => {
    const clickUrl = pendingRequestClickUrl('session-a', 'profile-a')
    expect(clickUrl).toBe('/hermes/session/session-a?profile=profile-a')

    const router = makeRouter()
    const resolved = router.resolve(clickUrl)
    expect(resolved.name).toBe('hermes.session')
    expect(resolved.params.sessionId).toBe('session-a')
    expect(resolved.query.profile).toBe('profile-a')

    // The service worker navigates the window to `/#${clickUrl}`; the hash it
    // produces has to parse to the same route.
    const serviceWorkerTarget = new URL(`/#${clickUrl}`, 'http://localhost')
    expect(router.resolve(serviceWorkerTarget.hash.slice(1)).query.profile).toBe('profile-a')
  })

  it('opens profile A’s session when the notification is clicked from profile B', async () => {
    const router = makeRouter()
    window.location.hash = '#/hermes/chat'
    router.push('/hermes/chat')
    mount(ChatView, { global: { plugins: [router] } })
    await settle(router)

    // The user is sitting in profile B and cannot see profile A's session.
    expect(loadSessionsMock).toHaveBeenCalledWith('profile-b', null)
    expect(chatState.activeSessionId).toBeNull()

    loadSessionsMock.mockClear()
    await router.push(pendingRequestClickUrl(SESSION_A.id, SESSION_A.profile))
    await settle(router)

    expect(loadSessionsMock).toHaveBeenCalledWith('profile-a', 'session-a')
    expect(chatState.sessionProfileFilter).toBe('profile-a')
    expect(chatState.activeSessionId).toBe('session-a')
    expect(router.currentRoute.value.name).toBe('hermes.session')
  })

  it('regression: a click URL without the profile strands the user on the chat home', async () => {
    // This is the shape the notification used to ship. Kept as an executable
    // record of why the profile query is required.
    const router = makeRouter()
    window.location.hash = '#/hermes/chat'
    router.push('/hermes/chat')
    mount(ChatView, { global: { plugins: [router] } })
    await settle(router)

    loadSessionsMock.mockClear()
    await router.push(`/hermes/session/${SESSION_A.id}`)
    await settle(router)

    // profile B cannot see the session, so nothing is opened and the waiting
    // approval card never comes on screen.
    expect(loadSessionsMock).toHaveBeenCalledWith('profile-b', 'session-a')
    expect(chatState.activeSessionId).toBeNull()
    expect(chatState.activeSession).toBeNull()
    expect(chatState.sessions).toEqual([])
  })
})
