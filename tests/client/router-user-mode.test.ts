// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetchFeishuUatStatus = vi.hoisted(() => vi.fn())
const mockGetAuthMode = vi.hoisted(() => vi.fn(() => 'token'))

vi.mock('@/api/client', () => ({
  canAccessProtectedRoutes: () => true,
  getAuthMode: mockGetAuthMode,
  isUserMode: () => true,
  shouldSkipLoginPage: () => false,
}))

vi.mock('@/api/auth', () => ({
  fetchFeishuUatStatus: mockFetchFeishuUatStatus,
}))

describe('router user mode route metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAuthMode.mockReturnValue('token')
    mockFetchFeishuUatStatus.mockResolvedValue({ status: 'valid' })
  })

  it('marks the terminal route as hidden in chat-plane user mode', async () => {
    const router = (await import('@/router')).default

    expect(router.getRoutes().find(route => route.name === 'hermes.terminal')?.meta.hiddenInChatPlane).toBe(true)
  })

  it('redirects Feishu OAuth users to login when UAT is missing before protected routes', async () => {
    vi.resetModules()
    mockGetAuthMode.mockReturnValue('feishu-oauth-dev')
    mockFetchFeishuUatStatus.mockResolvedValue({ status: 'missing' })
    const router = (await import('@/router')).default

    await router.push('/hermes/chat')
    await router.isReady()

    expect(mockFetchFeishuUatStatus).toHaveBeenCalledOnce()
    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.uat).toBe('required')
  })
})
