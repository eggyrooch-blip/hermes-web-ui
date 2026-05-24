// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// vi.mock is hoisted, so mockReplace must be inside the factory
vi.mock('@/router', () => ({
  default: {
    currentRoute: { value: { name: 'hermes.chat' } },
    replace: vi.fn(),
  },
}))

import {
  canAccessProtectedRoutes,
  getApiKey,
  setApiKey,
  clearApiKey,
  hasApiKey,
  isUserMode,
  shouldSkipLoginPage,
  request,
} from '../../packages/client/src/api/client'
import { fetchCurrentUser } from '../../packages/client/src/api/auth'
import { fetchHermesSessions, fetchSession } from '../../packages/client/src/api/hermes/sessions'
import router from '@/router'

describe('API Client', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  describe('token management', () => {
    it('hasApiKey returns false when no token', () => {
      expect(hasApiKey()).toBe(false)
    })

    it('hasApiKey returns true after setApiKey', () => {
      setApiKey('test-token')
      expect(hasApiKey()).toBe(true)
    })

    it('does not treat Feishu OAuth dev mode as a local API key', () => {
      localStorage.setItem('hermes_auth_mode', 'feishu-oauth-dev')

      expect(hasApiKey()).toBe(false)
    })

    it('allows Feishu OAuth dev mode to access protected routes without skipping the login page', () => {
      localStorage.setItem('hermes_auth_mode', 'feishu-oauth-dev')

      expect(shouldSkipLoginPage()).toBe(false)
      expect(canAccessProtectedRoutes()).toBe(true)
    })

    it('treats chat plane or cached bound users as user mode', () => {
      expect(isUserMode()).toBe(false)

      localStorage.setItem('hermes_web_plane', 'chat')
      expect(isUserMode()).toBe(true)

      localStorage.setItem('hermes_web_plane', 'both')
      localStorage.setItem('hermes_current_user', '{"profile":"g41a5b5g"}')
      expect(isUserMode()).toBe(true)
    })

    it('getApiKey returns the stored token', () => {
      setApiKey('my-token')
      expect(getApiKey()).toBe('my-token')
    })

    it('clearApiKey removes the token', () => {
      setApiKey('my-token')
      clearApiKey()
      expect(hasApiKey()).toBe(false)
      expect(getApiKey()).toBe('')
    })
  })

  describe('request', () => {
    it('adds Authorization header when token exists', async () => {
      setApiKey('secret-key')
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => ({ data: 1 }) })

      await request('/api/hermes/sessions')

      expect(mockFetch).toHaveBeenCalledOnce()
      const [, options] = mockFetch.mock.calls[0]
      expect(options.headers.Authorization).toBe('Bearer secret-key')
    })

    it('does not add Authorization header when no token', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => ({ data: 1 }) })

      await request('/api/hermes/sessions')

      const [, options] = mockFetch.mock.calls[0]
      expect(options.headers.Authorization).toBeUndefined()
    })

    it('clears token and redirects on 401 for local BFF endpoints', async () => {
      setApiKey('secret-key')
      mockFetch.mockResolvedValue({ ok: false, status: 401 })

      await expect(request('/api/hermes/sessions')).rejects.toThrow('Unauthorized')
      expect(hasApiKey()).toBe(false)
      expect(router.replace).toHaveBeenCalledWith({ name: 'login' })
    })

    it('does NOT clear token on 401 for proxied v1 endpoints', async () => {
      setApiKey('secret-key')
      mockFetch.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('') })

      await expect(request('/api/hermes/v1/runs')).rejects.toThrow('API Error 401')
      expect(hasApiKey()).toBe(true)
    })

    it('does NOT clear token on 401 for proxied jobs endpoints', async () => {
      setApiKey('secret-key')
      mockFetch.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('') })

      await expect(request('/api/hermes/jobs')).rejects.toThrow('API Error 401')
      expect(hasApiKey()).toBe(true)
    })

    it('does NOT clear token on 401 for proxied skills endpoints', async () => {
      setApiKey('secret-key')
      mockFetch.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('') })

      await expect(request('/api/hermes/skills')).rejects.toThrow('API Error 401')
      expect(hasApiKey()).toBe(true)
    })

    it('can preserve a local BFF 401 error without clearing the preview token', async () => {
      setApiKey('preview-token')
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: () => Promise.resolve('{"error":"Feishu user session is required for Lark-cli authorization"}'),
      })

      await expect(request('/api/auth/skill-credentials/lark-cli/start', {
        method: 'POST',
        skipAuthRedirect: true,
      })).rejects.toThrow('Feishu user session is required for Lark-cli authorization')
      expect(hasApiKey()).toBe(true)
      expect(router.replace).not.toHaveBeenCalled()
    })

    it('throws error on non-401 failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      })

      await expect(request('/api/hermes/sessions')).rejects.toThrow('API Error 500: Internal Server Error')
    })

    it('returns parsed JSON on success', async () => {
      const data = { sessions: [{ id: '1' }] }
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(data) })

      const result = await request('/api/hermes/sessions')
      expect(result).toEqual(data)
    })

    it('sends the selected owner profile header in chat-plane user mode', async () => {
      localStorage.setItem('hermes_web_plane', 'chat')
      localStorage.setItem('hermes_auth_mode', 'feishu-oauth-dev')
      localStorage.setItem('hermes_active_profile_name', 'feishu_group_alpha')
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ sessions: [] }) })

      await request('/api/hermes/sessions')

      const [, options] = mockFetch.mock.calls[0]
      expect(options.headers['X-Hermes-Profile']).toBe('feishu_group_alpha')
    })

    it('does not send the profile header for Feishu OAuth outside chat-plane', async () => {
      localStorage.setItem('hermes_web_plane', 'both')
      localStorage.setItem('hermes_auth_mode', 'feishu-oauth-dev')
      localStorage.setItem('hermes_active_profile_name', 'feishu_group_alpha')
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ sessions: [] }) })

      await request('/api/hermes/sessions')

      const [, options] = mockFetch.mock.calls[0]
      expect(options.headers['X-Hermes-Profile']).toBeUndefined()
    })
  })

  describe('auth API', () => {
    it('unwraps upstream-style current-user responses while preserving Feishu fields', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          user: {
            id: 'ou_test',
            username: '张三',
            openid: 'ou_test',
            profile: 'researcher',
            role: 'user',
            status: 'active',
            name: '张三',
            avatarUrl: 'https://example.com/avatar.png',
            profiles: ['researcher'],
          },
        }),
      })

      const user = await fetchCurrentUser()

      expect(user).toMatchObject({
        id: 'ou_test',
        username: '张三',
        openid: 'ou_test',
        profile: 'researcher',
        role: 'user',
        status: 'active',
        name: '张三',
        avatarUrl: 'https://example.com/avatar.png',
        profiles: ['researcher'],
      })
    })
  })

  describe('sessions API', () => {
    it('passes explicit profile query params for deep-linked sessions', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ sessions: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ session: { id: 's1' } }) })

      await fetchHermesSessions(undefined, undefined, 'tester')
      await fetchSession('s1', 'tester')

      expect(mockFetch.mock.calls[0][0]).toBe('/api/hermes/sessions/hermes?profile=tester')
      expect(mockFetch.mock.calls[1][0]).toBe('/api/hermes/sessions/s1?profile=tester')
    })
  })
})
