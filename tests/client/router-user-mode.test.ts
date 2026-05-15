// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/client', () => ({
  canAccessProtectedRoutes: () => true,
  isUserMode: () => true,
  shouldSkipLoginPage: () => false,
}))

describe('router user mode route metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('marks the terminal route as hidden in chat-plane user mode', async () => {
    const router = (await import('@/router')).default

    expect(router.getRoutes().find(route => route.name === 'hermes.terminal')?.meta.hiddenInChatPlane).toBe(true)
  })

  it('does not gate protected routes on Feishu UAT connection state', async () => {
    vi.resetModules()
    const router = (await import('@/router')).default

    await router.push('/hermes/usage')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('hermes.usage')
  })
})
