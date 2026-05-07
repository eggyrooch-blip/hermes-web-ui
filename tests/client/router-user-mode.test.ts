// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/api/client', () => ({
  canAccessProtectedRoutes: () => true,
  isUserMode: () => true,
  shouldSkipLoginPage: () => false,
}))

describe('router user mode route metadata', () => {
  it('marks the terminal route as hidden in chat-plane user mode', async () => {
    const router = (await import('@/router')).default

    expect(router.getRoutes().find(route => route.name === 'hermes.terminal')?.meta.hiddenInChatPlane).toBe(true)
  })
})
