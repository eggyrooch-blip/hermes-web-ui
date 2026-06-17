// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Upstream-rebaseline drift: the router lazy-imports real view components, and
// the redirect target (ChatView) / blocked routes transitively pull in
// monaco-editor, which crashes at import time under jsdom
// (document.queryCommandSupported is not a function). This guard test only
// exercises the beforeEach navigation guard, never the rendered views, so we
// sever the monaco import chain with a harmless stub.
vi.mock('monaco-editor', () => ({}))

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
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('gates the terminal route behind super-admin', async () => {
    const router = (await import('@/router')).default

    expect(router.getRoutes().find(route => route.name === 'hermes.terminal')?.meta.requiresSuperAdmin).toBe(true)
  })

  it('registers profile-aware session deep link routes', async () => {
    const router = (await import('@/router')).default

    expect(router.getRoutes().find(route => route.name === 'hermes.session')?.path).toBe('/hermes/session/:sessionId')
    expect(router.getRoutes().find(route => route.name === 'hermes.historySession')?.path).toBe('/hermes/history/session/:sessionId')
    expect(router.getRoutes().find(route => route.name === 'hermes.groupChatRoom')?.path).toBe('/hermes/group-chat/room/:roomId')
  })

  it('allows an authenticated user onto a protected, non-admin route', async () => {
    localStorage.setItem('hermes_api_key', USER_TOKEN)
    const router = (await import('@/router')).default

    await router.push('/hermes/usage')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('hermes.usage')
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

  it('lets a super-admin reach super-admin-only routes', async () => {
    localStorage.setItem('hermes_api_key', SUPER_ADMIN_TOKEN)
    const router = (await import('@/router')).default

    await router.push('/hermes/profiles')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('hermes.profiles')
  })
})
