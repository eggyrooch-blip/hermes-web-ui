// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Upstream-rebaseline drift: the router lazy-imports real view components, and
// the redirect target (ChatView) / blocked routes transitively pull in
// monaco-editor, which crashes at import time under jsdom
// (document.queryCommandSupported is not a function). This guard test only
// exercises the beforeEach navigation guard, never the rendered views, so we
// sever the monaco import chain with a harmless stub.
vi.mock('monaco-editor', () => ({}))
vi.mock('@/views/hermes/ChatView.vue', () => ({
  default: { template: '<div data-test="chat-view" />' },
}))
vi.mock('@/views/hermes/SettingsView.vue', () => ({
  default: { template: '<div data-test="settings-view" />' },
}))

const fetchMock = vi.hoisted(() => vi.fn())

// A JWT whose payload encodes a non-admin role, so isStoredSuperAdmin() === false
// but hasApiKey() === true. Header/signature are dummies; only the middle segment
// is decoded by the auth helpers in @/api/client.
function makeToken(payload: Record<string, unknown>): string {
  const b64 = (obj: Record<string, unknown>) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `header.${b64(payload)}.sig`
}

const USER_TOKEN = makeToken({ username: 'zhaoxin', role: 'user' })
const SUPER_ADMIN_TOKEN = makeToken({ username: 'sunke', role: 'super_admin' })

describe('router route metadata + auth gating', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: vi.fn(() => ({})),
    })
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ user: { id: 1 } }) })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    localStorage.clear()
    window.history.replaceState(null, '', '/')
    vi.unstubAllGlobals()
  })

  it('gates the terminal route behind super-admin', async () => {
    const router = (await import('@/router')).default

    expect(router.getRoutes().find(route => route.name === 'hermes.terminal')?.meta.requiresSuperAdmin).toBe(true)
  })

  it.each([
    'hermes.channels',
    'hermes.logs',
    'hermes.devices',
    'hermes.models',
    'hermes.codingAgents',
    'hermes.performance',
    'hermes.versionPreview',
  ])('gates %s behind super-admin', async (routeName) => {
    const router = (await import('@/router')).default

    expect(router.getRoutes().find(route => route.name === routeName)?.meta.requiresSuperAdmin).toBe(true)
  })

  it('registers profile-aware session deep link routes', async () => {
    const router = (await import('@/router')).default

    expect(router.getRoutes().find(route => route.name === 'hermes.session')?.path).toBe('/hermes/session/:sessionId')
    expect(router.getRoutes().find(route => route.name === 'hermes.historySession')?.path).toBe('/hermes/history/session/:sessionId')
    expect(router.getRoutes().find(route => route.name === 'hermes.groupChatRoom')?.path).toBe('/hermes/group-chat/room/:roomId')
  })

  it('registers the connectors route for skill credentials', async () => {
    const router = (await import('@/router')).default
    const route = router.getRoutes().find(route => route.name === 'hermes.connectors')

    expect(route?.path).toBe('/hermes/connectors')
    expect(router.resolve('/hermes/credentials').matched.at(-1)?.name).toBe('hermes.connectors')
  })

  it.each([
    'hermes.plugins',
    'hermes.mcp',
  ])('keeps %s available as an authenticated user tool route', async (routeName) => {
    const router = (await import('@/router')).default

    expect(router.getRoutes().find(route => route.name === routeName)?.meta.requiresSuperAdmin).toBeUndefined()
  })

  it('allows an authenticated user onto a protected, non-admin route', async () => {
    localStorage.setItem('hermes_api_key', USER_TOKEN)
    const router = (await import('@/router')).default

    await router.push('/hermes/usage')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('hermes.usage')
  })

  it('allows Feishu OAuth cookie-mode users onto protected routes without a JS token', async () => {
    localStorage.setItem('hermes_auth_mode', 'feishu-oauth-dev')
    const router = (await import('@/router')).default

    await router.push('/hermes/chat')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('hermes.chat')
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({ credentials: 'same-origin' }))
  })

  it('discovers Feishu OAuth mode after a fresh callback redirects straight to chat', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/auth/status') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ authMode: 'feishu-oauth-dev', plane: 'chat' }),
        })
      }
      if (url === '/api/auth/me') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: { id: 1 } }) })
      }
      return Promise.resolve({ ok: false, status: 404 })
    })
    const router = (await import('@/router')).default

    await router.push('/hermes/chat')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('hermes.chat')
    expect(localStorage.getItem('hermes_auth_mode')).toBe('feishu-oauth-dev')
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/status', expect.objectContaining({ credentials: 'same-origin' }))
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({ credentials: 'same-origin' }))
  })

  it('uses chat as the default landing when fresh Feishu cookie mode reaches settings', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/auth/status') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ authMode: 'feishu-oauth-dev', plane: 'chat' }),
        })
      }
      if (url === '/api/auth/me') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: { id: 1 } }) })
      }
      return Promise.resolve({ ok: false, status: 404 })
    })
    const router = (await import('@/router')).default

    await router.push('/hermes/settings')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('hermes.chat')
    expect(localStorage.getItem('hermes_auth_mode')).toBe('feishu-oauth-dev')
  })

  it('replaces the browser history entry when fresh Feishu cookie mode reaches settings', async () => {
    localStorage.setItem('hermes_auth_mode', 'feishu-oauth-dev')
    const { freshServerSettingsLandingRedirect } = await import('@/router')

    expect(freshServerSettingsLandingRedirect(true, 'hermes.settings')).toEqual({
      name: 'hermes.chat',
      replace: true,
    })
    expect(freshServerSettingsLandingRedirect(false, 'hermes.settings')).toBeNull()
    expect(freshServerSettingsLandingRedirect(true, 'hermes.chat')).toBeNull()
  })

  it.each([
    'feishu-oauth-dev',
    'trusted-feishu',
  ])('redirects stale %s mode when the server session is not valid', async (authMode) => {
    localStorage.setItem('hermes_auth_mode', authMode)
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 })
    const router = (await import('@/router')).default

    await router.push('/hermes/chat')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('login')
    expect(localStorage.getItem('hermes_auth_mode')).toBeNull()
  })

  it('allows an authenticated user onto the connectors route', async () => {
    localStorage.setItem('hermes_api_key', USER_TOKEN)
    const router = (await import('@/router')).default

    await router.push('/hermes/connectors')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('hermes.connectors')
  })

  it('redirects an unauthenticated visitor on a protected route to login', async () => {
    // no api key in localStorage
    const router = (await import('@/router')).default

    await router.push('/hermes/usage')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('login')
  })

  it('keeps a non-admin user off super-admin-only routes', async () => {
    localStorage.setItem('hermes_api_key', USER_TOKEN)
    const router = (await import('@/router')).default

    // /hermes/profiles is requiresSuperAdmin, like terminal, but its view does
    // not pull in monaco-editor (which is unloadable under jsdom).
    await router.push('/hermes/profiles')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('hermes.chat')
  })

  it.each([
    '/hermes/channels',
    '/hermes/logs',
    '/hermes/devices',
    '/hermes/models',
    '/hermes/coding-agents',
    '/hermes/performance',
    '/hermes/version-preview',
  ])('keeps a non-admin user off %s', async (path) => {
    localStorage.setItem('hermes_api_key', USER_TOKEN)
    const router = (await import('@/router')).default

    await router.push(path)
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('hermes.chat')
  })

  it.each([
    ['/hermes/plugins', 'hermes.plugins'],
    ['/hermes/mcp', 'hermes.mcp'],
  ])('lets a non-admin user reach %s', async (path, routeName) => {
    localStorage.setItem('hermes_api_key', USER_TOKEN)
    const router = (await import('@/router')).default

    await router.push(path)
    await router.isReady()

    expect(router.currentRoute.value.name).toBe(routeName)
  })

  it.each([
    'feishu-oauth-dev',
    'trusted-feishu',
  ])('does not let a stale super-admin JWT bypass %s route gates', async (authMode) => {
    localStorage.setItem('hermes_auth_mode', authMode)
    localStorage.setItem('hermes_api_key', SUPER_ADMIN_TOKEN)
    const router = (await import('@/router')).default

    await router.push('/hermes/models')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('hermes.chat')
  })

  it('lets a super-admin reach super-admin-only routes', async () => {
    localStorage.setItem('hermes_api_key', SUPER_ADMIN_TOKEN)
    const router = (await import('@/router')).default

    await router.push('/hermes/profiles')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('hermes.profiles')
  })
})
