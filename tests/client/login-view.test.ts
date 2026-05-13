// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mockReplace = vi.hoisted(() => vi.fn())
const mockFetchAuthStatus = vi.hoisted(() => vi.fn())
const mockFetchCurrentUser = vi.hoisted(() => vi.fn())
const mockLoginWithPassword = vi.hoisted(() => vi.fn())
const mockSetApiKey = vi.hoisted(() => vi.fn())
const mockHasApiKey = vi.hoisted(() => vi.fn())
const mockSetRuntimeMode = vi.hoisted(() => vi.fn())
const mockLocationAssign = vi.hoisted(() => vi.fn())

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
  fetchCurrentUser: mockFetchCurrentUser,
  loginWithPassword: mockLoginWithPassword,
}))

import LoginView from '@/views/LoginView.vue'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('LoginView token login', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    delete (window as any).__LOGIN_TOKEN__
    Object.defineProperty(window, 'location', {
      value: { assign: mockLocationAssign },
      writable: true,
    })
    vi.clearAllMocks()
    mockHasApiKey.mockReturnValue(false)
    mockFetchAuthStatus.mockResolvedValue({ hasPasswordLogin: false })
    mockFetchCurrentUser.mockResolvedValue({ openid: 'ou_test', profile: 'researcher', role: 'user' })
    mockFetch.mockResolvedValue({ ok: true, status: 200 })
  })

  it('validates token login against the Hermes sessions endpoint', async () => {
    const wrapper = mount(LoginView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    await wrapper.find('input.login-input').setValue('secret-token')
    await wrapper.find('form.login-form').trigger('submit')

    expect(mockFetch).toHaveBeenCalledOnce()
    expect(mockFetch).toHaveBeenCalledWith('/api/hermes/sessions', {
      headers: { Authorization: 'Bearer secret-token' },
    })
    expect(mockSetApiKey).toHaveBeenCalledWith('secret-token')
    expect(mockReplace).toHaveBeenCalledWith('/hermes/chat')
  })

  it('keeps the existing invalid-token behavior on 401', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 })
    const wrapper = mount(LoginView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    await wrapper.find('input.login-input').setValue('bad-token')
    await wrapper.find('form.login-form').trigger('submit')

    expect(mockFetch).toHaveBeenCalledWith('/api/hermes/sessions', {
      headers: { Authorization: 'Bearer bad-token' },
    })
    expect(wrapper.find('.login-error').text()).toBe('login.invalidToken')
    expect(mockSetApiKey).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('uses the Feishu OAuth entrypoint when configured for local OAuth', async () => {
    mockFetchAuthStatus.mockResolvedValue({
      hasPasswordLogin: false,
      authMode: 'feishu-oauth-dev',
      plane: 'chat',
    })
    mockFetchCurrentUser.mockRejectedValue(new Error('Unauthorized'))

    const wrapper = mount(LoginView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    await wrapper.find('button.login-btn').trigger('click')

    expect(mockLocationAssign).toHaveBeenCalledWith('/api/auth/feishu/login')
    expect(mockSetApiKey).not.toHaveBeenCalled()
  })

  it('prevents duplicate Feishu OAuth redirects after the login button is clicked', async () => {
    mockFetchAuthStatus.mockResolvedValue({
      hasPasswordLogin: false,
      authMode: 'feishu-oauth-dev',
      plane: 'chat',
    })
    mockFetchCurrentUser.mockRejectedValue(new Error('Unauthorized'))

    const wrapper = mount(LoginView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    const button = wrapper.find('button.login-btn')
    await button.trigger('click')
    await button.trigger('click')

    expect(mockLocationAssign).toHaveBeenCalledOnce()
    expect(mockLocationAssign).toHaveBeenCalledWith('/api/auth/feishu/login')
  })

  it('redirects to chat when Feishu OAuth current user is already valid', async () => {
    mockFetchAuthStatus.mockResolvedValue({
      hasPasswordLogin: false,
      authMode: 'feishu-oauth-dev',
      plane: 'chat',
    })
    mockFetch.mockResolvedValue({ ok: false, status: 502 })

    mount(LoginView)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(mockFetch).not.toHaveBeenCalledWith('/api/hermes/sessions')
    expect(mockFetchCurrentUser).toHaveBeenCalledOnce()
    expect(window.localStorage.getItem('hermes_active_profile_name')).toBe('researcher')
    expect(mockReplace).toHaveBeenCalledWith('/hermes/chat')
  })

  it('shows a wake screen while validating an existing Feishu OAuth session', async () => {
    mockFetchAuthStatus.mockResolvedValue({
      hasPasswordLogin: false,
      authMode: 'feishu-oauth-dev',
      plane: 'chat',
    })
    mockFetchCurrentUser.mockReturnValue(new Promise(() => {}))

    const wrapper = mount(LoginView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('login.wakingTitle')
    expect(wrapper.text()).toContain('login.wakingDescription')
    expect(wrapper.find('form.login-form').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('login.feishuLogin')
  })
})
