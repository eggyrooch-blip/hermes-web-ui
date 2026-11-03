// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const mockReplace = vi.hoisted(() => vi.fn())
const mockFetchAuthStatus = vi.hoisted(() => vi.fn())
const mockLoginWithPassword = vi.hoisted(() => vi.fn())
const mockSetApiKey = vi.hoisted(() => vi.fn())
const mockHasApiKey = vi.hoisted(() => vi.fn())
const mockSetRuntimeMode = vi.hoisted(() => vi.fn())
const mockAssign = vi.hoisted(() => vi.fn())

vi.mock('vue-router', () => ({
  useRouter: () => ({
    replace: mockReplace,
  }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/api/client', () => ({
  setApiKey: mockSetApiKey,
  hasApiKey: mockHasApiKey,
  setRuntimeMode: mockSetRuntimeMode,
}))

vi.mock('@/api/auth', () => ({
  fetchAuthStatus: mockFetchAuthStatus,
  loginWithPassword: mockLoginWithPassword,
}))

import LoginView from '@/views/LoginView.vue'

describe('LoginView password login', () => {
  beforeEach(() => {
    delete (window as any).__LOGIN_TOKEN__
    vi.clearAllMocks()
    vi.stubGlobal('location', { ...window.location, assign: mockAssign })
    mockHasApiKey.mockReturnValue(false)
    mockFetchAuthStatus.mockResolvedValue({ hasPasswordLogin: true, username: 'admin' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('logs in with username and password', async () => {
    mockLoginWithPassword.mockResolvedValue('jwt-token')
    const wrapper = mount(LoginView)
    await flushPromises()

    const inputs = wrapper.findAll('input.login-input')
    await inputs[0].setValue('admin')
    await inputs[1].setValue('123456')
    await wrapper.find('form.login-form').trigger('submit')

    expect(mockLoginWithPassword).toHaveBeenCalledWith('admin', '123456')
    expect(mockSetApiKey).toHaveBeenCalledWith('jwt-token')
    expect(mockReplace).toHaveBeenCalledWith('/hermes/chat')
  })

  it('shows the default login hint', async () => {
    const wrapper = mount(LoginView)
    await flushPromises()

    expect(wrapper.text()).toContain('login.defaultCredentialsHint')
  })

  it('shows an error when password login fails', async () => {
    mockLoginWithPassword.mockRejectedValue(new Error('Invalid username or password'))
    const wrapper = mount(LoginView)
    await flushPromises()

    const inputs = wrapper.findAll('input.login-input')
    await inputs[0].setValue('admin')
    await inputs[1].setValue('bad-password')
    await wrapper.find('form.login-form').trigger('submit')

    expect(wrapper.find('.login-error').text()).toBe('Invalid username or password')
    expect(mockSetApiKey).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('shows the reset command hint when the login IP is locked', async () => {
    const err: any = new Error('Too many login attempts')
    err.status = 429
    mockLoginWithPassword.mockRejectedValue(err)
    const wrapper = mount(LoginView)
    await flushPromises()

    const inputs = wrapper.findAll('input.login-input')
    await inputs[0].setValue('admin')
    await inputs[1].setValue('123456')
    await wrapper.find('form.login-form').trigger('submit')

    expect(wrapper.find('.login-error').text()).toBe('login.tooManyAttempts')
    expect(wrapper.find('.login-lock-hint').text()).toContain('login.lockResetHint')
    expect(wrapper.find('.login-lock-hint').text()).toContain('login.defaultLoginResetHint')
    const commands = wrapper.findAll('.login-lock-hint code').map(command => command.text())
    expect(commands).toEqual([
      'hermes-web-ui clear-login-locks --restart',
      'hermes-web-ui reset-default-login',
    ])
  })

  // sunke 2026-08-13: bare-root bookmark re-authed on EVERY visit, and any
  // transient 401 (api/client.ts routes local-BFF 401 -> {name:'login'}) logged
  // the user out for real — both because this view woke OAuth without ever
  // asking whether the httpOnly session cookie was still good.
  describe('feishu-oauth-dev mode', () => {
    const mockAuthMe = vi.fn()

    beforeEach(() => {
      mockFetchAuthStatus.mockResolvedValue({
        hasPasswordLogin: false,
        authMode: 'feishu-oauth-dev',
        plane: 'chat',
      })
      vi.stubGlobal('fetch', mockAuthMe)
    })

    it('enters chat without an OAuth round-trip when the session cookie is still valid', async () => {
      mockAuthMe.mockResolvedValue({ ok: true })

      mount(LoginView)
      await flushPromises()

      expect(mockAuthMe).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({
        credentials: 'same-origin',
      }))
      expect(mockReplace).toHaveBeenCalledWith('/hermes/chat')
      expect(mockAssign).not.toHaveBeenCalled()
    })

    // Negative control: with no live session the user MUST still reach Feishu.
    it('wakes Feishu OAuth when there is no live session', async () => {
      mockAuthMe.mockResolvedValue({ ok: false, status: 401 })

      mount(LoginView)
      await flushPromises()

      expect(mockAssign).toHaveBeenCalledWith('/api/auth/feishu/login')
      expect(mockReplace).not.toHaveBeenCalled()
    })

    it('falls back to OAuth when the session probe itself fails', async () => {
      mockAuthMe.mockRejectedValue(new Error('offline'))

      mount(LoginView)
      await flushPromises()

      expect(mockAssign).toHaveBeenCalledWith('/api/auth/feishu/login')
      expect(mockReplace).not.toHaveBeenCalled()
    })

    // A stale mount whose /api/auth/status resolves late must not drag a user
    // that a newer mount already put into chat back out to OAuth.
    it('lets a newer mount win over a slower stale one', async () => {
      let releaseStaleStatus: (value: unknown) => void = () => {}
      mockFetchAuthStatus.mockImplementationOnce(() => new Promise((resolve) => {
        releaseStaleStatus = resolve
      }))

      mount(LoginView) // stale mount — status still pending
      await flushPromises()

      mockAuthMe.mockResolvedValue({ ok: true })
      mount(LoginView) // newer mount — valid session, enters chat
      await flushPromises()
      expect(mockReplace).toHaveBeenCalledWith('/hermes/chat')

      mockAuthMe.mockResolvedValue({ ok: false, status: 401 })
      releaseStaleStatus({ hasPasswordLogin: false, authMode: 'feishu-oauth-dev', plane: 'chat' })
      await flushPromises()

      expect(mockAssign).not.toHaveBeenCalled()
    })

    // A hung BFF must not strand the user on a blank login shell.
    it('falls back to OAuth when the session probe hangs past its timeout', async () => {
      vi.useFakeTimers()
      mockAuthMe.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }))

      mount(LoginView)
      await vi.advanceTimersByTimeAsync(5000)
      await flushPromises()
      vi.useRealTimers()

      expect(mockAssign).toHaveBeenCalledWith('/api/auth/feishu/login')
      expect(mockReplace).not.toHaveBeenCalled()
    })
  })

  // Regression guard: the new probe must stay inside the feishu-oauth-dev
  // branch — upstream password mode never talks to /api/auth/me.
  it('never probes the session in password mode and still renders the form', async () => {
    const spyFetch = vi.fn()
    vi.stubGlobal('fetch', spyFetch)

    const wrapper = mount(LoginView)
    await flushPromises()

    expect(spyFetch).not.toHaveBeenCalled()
    expect(mockAssign).not.toHaveBeenCalled()
    expect(wrapper.find('form.login-form').exists()).toBe(true)
  })

  it('enters chat directly in trusted Feishu mode instead of waking OAuth', async () => {
    mockFetchAuthStatus.mockResolvedValue({
      hasPasswordLogin: false,
      authMode: 'trusted-feishu',
      plane: 'chat',
    })

    const spyFetch = vi.fn()
    vi.stubGlobal('fetch', spyFetch)

    mount(LoginView)
    await flushPromises()

    expect(mockSetRuntimeMode).toHaveBeenCalledWith('trusted-feishu', 'chat')
    expect(mockReplace).toHaveBeenCalledWith('/hermes/chat')
    expect(mockAssign).not.toHaveBeenCalled()
    expect(spyFetch).not.toHaveBeenCalled()
  })
})
