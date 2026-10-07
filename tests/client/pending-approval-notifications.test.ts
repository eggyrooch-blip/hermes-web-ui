// @vitest-environment jsdom
//
// Background system notifications for pending approval / clarify /
// authorization requests. The event source is our own inline cards: every
// socket path funnels into the chat store's `setPendingApproval`,
// `setPendingClarify` and `setPendingAuthorization`, so these tests drive the
// store the same way the run handlers do and assert on a stubbed browser
// `Notification`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  respondAuthorization: vi.fn(),
  socketEmit: vi.fn(),
}))

const sessionsApi = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  fetchSessionMessagesPage: vi.fn(),
  fetchSessions: vi.fn(),
  setSessionModel: vi.fn(),
}))

const settingsMock = vi.hoisted(() => ({
  display: {} as Record<string, unknown>,
}))

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: vi.fn(() => ({ emit: chatApi.socketEmit })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  respondAuthorization: chatApi.respondAuthorization,
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onAuthResolved: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
  getActiveExpertId: () => null,
  setActiveExpertId: () => {},
  hasApiKey: () => false,
  canAccessProtectedRoutes: () => true,
}))

vi.mock('@/api/hermes/sessions', () => ({
  deleteSession: sessionsApi.deleteSession,
  fetchSessionMessagesPage: sessionsApi.fetchSessionMessagesPage,
  fetchSessions: sessionsApi.fetchSessions,
  setSessionModel: sessionsApi.setSessionModel,
  fetchWorkspaceRunChanges: vi.fn(() => Promise.resolve([])),
}))

vi.mock('@/api/hermes/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/api/hermes/system', () => ({
  checkHealth: vi.fn(),
  fetchAvailableModels: vi.fn(),
  addCustomModel: vi.fn(),
  removeCustomModel: vi.fn(),
  updateDefaultModel: vi.fn(),
  updateModelVisibility: vi.fn(),
  triggerUpdate: vi.fn(),
  updateModelAlias: vi.fn(),
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => settingsMock,
}))

import { useChatStore, type Session } from '@/stores/hermes/chat'
import type { RunEvent } from '@/api/hermes/chat'
import { loadNotifiedPendingRequests } from '@/utils/pending-request-notification-ledger'

interface StubNotification {
  title: string
  options: NotificationOptions
  onclick: ((this: unknown) => void) | null
  close: ReturnType<typeof vi.fn>
}

let notifications: StubNotification[] = []
let visibility: DocumentVisibilityState = 'hidden'
let focusSpy: ReturnType<typeof vi.fn>

function installNotificationStub(permission: NotificationPermission = 'granted') {
  const requestPermission = vi.fn(async () => permission)
  class NotificationStub {
    static permission: NotificationPermission = permission
    static requestPermission = requestPermission
    title: string
    options: NotificationOptions
    onclick: ((this: unknown) => void) | null = null
    close = vi.fn()
    constructor(title: string, options: NotificationOptions = {}) {
      this.title = title
      this.options = options
      notifications.push(this as unknown as StubNotification)
    }
  }
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    writable: true,
    value: NotificationStub,
  })
  return requestPermission
}

const APPROVAL = {
  event: 'approval.requested',
  session_id: 'session-1',
  approval_id: 'approval-1',
  command: 'rm -rf build',
  description: 'Delete the build directory',
  choices: ['once', 'deny'],
} as unknown as RunEvent

const CLARIFY = {
  event: 'clarify.requested',
  session_id: 'session-1',
  clarify_id: 'clarify-1',
  question: '要部署到哪个环境？',
} as unknown as RunEvent

const AUTHORIZATION = {
  event: 'authorization.required',
  session_id: 'session-1',
  authorization_id: 'auth-1',
  service: 'lark-cli',
  scopes: ['im:message'],
  expires_at: 1780000000,
} as unknown as RunEvent

function makeSession(id: string, profile: string | null): Session {
  return {
    id,
    profile: profile ?? undefined,
    title: '发布流水线',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function bootStore(profile: string | null = 'profile-a') {
  const store = useChatStore()
  const session = makeSession('session-1', profile)
  store.sessions = [session]
  store.activeSessionId = 'session-1'
  store.activeSession = session
  return store
}

describe('pending approval system notifications', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    notifications = []
    visibility = 'hidden'
    settingsMock.display = {}
    // The notified ledger is per-tab state that deliberately survives a store
    // rebuild, so each test starts from an empty one.
    sessionStorage.clear()
    delete (navigator as { serviceWorker?: unknown }).serviceWorker
    setActivePinia(createPinia())
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    sessionsApi.fetchSessionMessagesPage.mockResolvedValue(null)
    sessionsApi.fetchSessions.mockResolvedValue([])
    sessionsApi.setSessionModel.mockResolvedValue({ ok: true, familySwitchNotice: false })

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    })
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    focusSpy = vi.fn()
    Object.defineProperty(window, 'focus', { configurable: true, writable: true, value: focusSpy })
    installNotificationStub('granted')
  })

  afterEach(() => {
    window.location.hash = ''
  })

  it('notifies once for a backgrounded approval and never twice for the same request id', async () => {
    const store = bootStore()

    store.setPendingApproval(APPROVAL)
    await vi.waitFor(() => expect(notifications).toHaveLength(1))

    // Title carries the session name; body carries the request summary.
    expect(notifications[0].title).toBe('发布流水线')
    expect(notifications[0].options.body).toBe('Approval needed: Delete the build directory')
    // The owning profile rides along: ChatView only looks for the session
    // inside the profile it is filtering by, so a bare session id would drop
    // the user on the chat home whenever they are browsing another profile.
    expect(notifications[0].options.data).toEqual({ clickUrl: '/hermes/session/session-1?profile=profile-a' })

    // A replayed `approval.requested` (resume, reconnect, F5) is the same
    // request — it must not wake the user a second time.
    store.setPendingApproval(APPROVAL)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(notifications).toHaveLength(1)

    // A genuinely different request still notifies.
    store.setPendingApproval({ ...APPROVAL, approval_id: 'approval-2' } as unknown as RunEvent)
    await vi.waitFor(() => expect(notifications).toHaveLength(2))
  })

  it('stays silent while the tab is in the foreground', async () => {
    visibility = 'visible'
    const store = bootStore()

    store.setPendingApproval(APPROVAL)
    store.setPendingClarify(CLARIFY)
    store.setPendingAuthorization(AUTHORIZATION)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(notifications).toHaveLength(0)
    // The cards themselves are unaffected by the notification layer.
    expect(store.activePendingApproval?.approvalId).toBe('approval-1')
    expect(store.activePendingClarify?.clarifyId).toBe('clarify-1')
    expect(store.activePendingAuthorization?.authorizationId).toBe('auth-1')
  })

  it('stays silent when the Display switch is off', async () => {
    settingsMock.display = { notify_on_approval: false }
    const store = bootStore()

    store.setPendingApproval(APPROVAL)
    store.setPendingClarify(CLARIFY)
    store.setPendingAuthorization(AUTHORIZATION)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(notifications).toHaveLength(0)
  })

  it('focuses the window and routes to the requesting session when the notification is clicked', async () => {
    const store = bootStore()

    store.setPendingApproval(APPROVAL)
    await vi.waitFor(() => expect(notifications).toHaveLength(1))

    notifications[0].onclick?.()

    expect(focusSpy).toHaveBeenCalledTimes(1)
    expect(window.location.hash).toBe('#/hermes/session/session-1?profile=profile-a')
    expect(notifications[0].close).toHaveBeenCalledTimes(1)
  })

  it('notifies for clarify and for a still-pending authorization, but not for a replay of a resolved one', async () => {
    const store = bootStore()

    store.setPendingClarify(CLARIFY)
    await vi.waitFor(() => expect(notifications).toHaveLength(1))
    expect(notifications[0].options.body).toBe('Clarification needed: 要部署到哪个环境？')

    store.setPendingAuthorization(AUTHORIZATION)
    await vi.waitFor(() => expect(notifications).toHaveLength(2))
    expect(notifications[1].options.body).toBe('Authorization needed: lark-cli — im:message')

    // The server resolved it; a later replay of the same id keeps the terminal
    // state and must not raise a second notification.
    store.clearPendingAuthorization({
      event: 'authorization.resolved', session_id: 'session-1', authorization_id: 'auth-1', state: 'success',
    } as unknown as RunEvent)
    store.setPendingAuthorization(AUTHORIZATION)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(notifications).toHaveLength(2)
  })

  it('shows nothing when the browser has not granted notification permission', async () => {
    installNotificationStub('default')
    const store = bootStore()

    store.setPendingApproval(APPROVAL)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(notifications).toHaveLength(0)
  })

  it('omits the profile query for a session that has no profile', async () => {
    const store = bootStore(null)

    store.setPendingApproval(APPROVAL)
    await vi.waitFor(() => expect(notifications).toHaveLength(1))

    expect(notifications[0].options.data).toEqual({ clickUrl: '/hermes/session/session-1' })
  })

  it('re-notifies a replayed request whose first delivery never reached the user', async () => {
    // Permission is still `default` when the request lands: the switch is on by
    // default, so this is the ordinary first-run case. Nothing was shown, so the
    // dedupe ledger must not swallow the replay that follows the user granting
    // permission and the socket reconnecting.
    installNotificationStub('default')
    const store = bootStore()

    store.setPendingApproval(APPROVAL)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(notifications).toHaveLength(0)

    installNotificationStub('granted')
    store.setPendingApproval(APPROVAL)
    await vi.waitFor(() => expect(notifications).toHaveLength(1))
    expect(notifications[0].options.data).toEqual({ clickUrl: '/hermes/session/session-1?profile=profile-a' })
  })

  it('releases the ledger entry when the notification constructor throws', async () => {
    const throwing = vi.fn(() => { throw new Error('notification backend unavailable') })
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      writable: true,
      value: Object.assign(throwing, { permission: 'granted' as NotificationPermission, requestPermission: vi.fn() }),
    })
    const store = bootStore()

    store.setPendingApproval(APPROVAL)
    await vi.waitFor(() => expect(throwing).toHaveBeenCalledTimes(1))
    expect(notifications).toHaveLength(0)

    installNotificationStub('granted')
    store.setPendingApproval(APPROVAL)
    await vi.waitFor(() => expect(notifications).toHaveLength(1))
  })

  it('delivers once when the same request arrives again while the first delivery is still in flight', async () => {
    const store = bootStore()

    // Both calls land in the same tick, before the first `showSystemNotification`
    // has resolved — the claim is taken up front so only one reaches the browser.
    store.setPendingApproval(APPROVAL)
    store.setPendingApproval(APPROVAL)
    store.setPendingApproval(APPROVAL)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(notifications).toHaveLength(1)
  })

  it('does not notify again for the same request after the page reloads', async () => {
    const store = bootStore()
    store.setPendingApproval(APPROVAL)
    await vi.waitFor(() => expect(notifications).toHaveLength(1))

    // A reload rebuilds the store from scratch while the server still holds the
    // request open and replays it on resume. sessionStorage is what survives.
    setActivePinia(createPinia())
    const reloaded = bootStore()
    reloaded.setPendingApproval(APPROVAL)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(notifications).toHaveLength(1)
  })

  it('forgets the ledger entry once the server resolves the request', async () => {
    const store = bootStore()
    store.setPendingApproval(APPROVAL)
    await vi.waitFor(() => expect(notifications).toHaveLength(1))
    expect(loadNotifiedPendingRequests()).toContain('approval:session-1:approval-1')

    store.clearPendingApproval({
      event: 'approval.resolved', session_id: 'session-1', approval_id: 'approval-1',
    } as unknown as RunEvent)

    expect(loadNotifiedPendingRequests()).not.toContain('approval:session-1:approval-1')
  })

  it('forgets the ledger entry when a clarify or an authorization resolves', async () => {
    const store = bootStore()
    store.setPendingClarify(CLARIFY)
    store.setPendingAuthorization(AUTHORIZATION)
    await vi.waitFor(() => expect(notifications).toHaveLength(2))
    expect(loadNotifiedPendingRequests()).toEqual([
      'clarify:session-1:clarify-1',
      'authorization:session-1:auth-1',
    ])

    store.clearPendingClarify({
      event: 'clarify.resolved', session_id: 'session-1', clarify_id: 'clarify-1',
    } as unknown as RunEvent)
    store.clearPendingAuthorization({
      event: 'authorization.resolved', session_id: 'session-1', authorization_id: 'auth-1', state: 'success',
    } as unknown as RunEvent)

    expect(loadNotifiedPendingRequests()).toEqual([])
  })

  it('does not deliver when the user returns to the tab while the service worker is still registering', async () => {
    let releaseRegistration!: (registration: unknown) => void
    const registrationReady = new Promise<unknown>(resolve => { releaseRegistration = resolve })
    const showNotification = vi.fn(async () => {})
    const registration = { showNotification }
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: vi.fn(() => registrationReady),
        get ready() { return Promise.resolve(registration) },
      },
    })

    const store = bootStore()
    store.setPendingApproval(APPROVAL)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(showNotification).not.toHaveBeenCalled()

    // Registration can take seconds on a first visit. The user comes back to
    // the tab in the meantime and is now looking straight at the card.
    visibility = 'visible'
    releaseRegistration(registration)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(showNotification).not.toHaveBeenCalled()
    expect(notifications).toHaveLength(0)
    // Nothing reached the user, so the request stays eligible to notify later.
    expect(loadNotifiedPendingRequests()).toEqual([])
  })
})
