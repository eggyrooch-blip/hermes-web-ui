// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const fetchSkillCredentialsMock = vi.hoisted(() => vi.fn())
const startSkillCredentialAuthMock = vi.hoisted(() => vi.fn())
const completeSkillCredentialAuthMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/skillCredentials', () => ({
  completeSkillCredentialAuth: completeSkillCredentialAuthMock,
  fetchSkillCredentials: fetchSkillCredentialsMock,
  startSkillCredentialAuth: startSkillCredentialAuthMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'skillCredentials.groups.internalSystems': 'Internal systems',
      'skillCredentials.groups.otherCredentials': 'Other credentials',
      'sidebar.connectors': 'Connectors',
    } as Record<string, string>)[key] || key,
  }),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
}))

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<any>('naive-ui')
  return {
    ...actual,
    useMessage: () => ({
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    }),
    NButton: {
      props: ['loading', 'disabled'],
      template: '<button :disabled="disabled"><slot /></button>',
    },
    NSpin: {
      props: ['show'],
      template: '<div><slot /></div>',
    },
    NModal: {
      props: ['show', 'title'],
      emits: ['update:show'],
      template: '<div v-if="show" class="mock-modal"><slot /></div>',
    },
  }
})

describe('CredentialsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchSkillCredentialsMock.mockResolvedValue({
      profile_name: 'feishu_user_a',
      credentials: [
        {
          id: 'lark-cli',
          title: 'Lark-cli',
          provider: 'lark',
          installed: true,
          status: 'authenticated',
          account_hint: '孙可',
          default_identity: 'user',
          detail: 'ready',
          required_by: ['wiki-helper'],
          action: { kind: 'feishu_device_flow', label: '重新授权' },
        },
        {
          id: 'feishu-project',
          title: '飞书项目',
          provider: 'feishu-project',
          installed: true,
          status: 'needs_auth',
          detail: '飞书项目需要授权后才能查询和更新工作项。',
          action: { kind: 'oauth_url', label: '授权' },
        },
        {
          id: 'keep-record',
          title: 'Keep-record',
          provider: 'keep',
          installed: true,
          status: 'unknown',
          account_hint: 'Keep User',
          detail: 'ready',
          action: { kind: 'skill_flow', label: '扫码认证', command: '/keep-record auth' },
        },
        {
          id: 'kep-cli',
          title: 'kep-cli',
          provider: 'keep',
          installed: true,
          status: 'needs_auth',
          detail: 'login required',
          required_by: ['aidock-helper', 'keep-login-skill'],
          action: { kind: 'oauth_url', label: '认证' },
        },
        {
          id: 'gitlab',
          title: 'GitLab',
          provider: 'gitlab',
          installed: true,
          status: 'configured',
          detail: 'materialized',
          action: { kind: 'manual', label: '刷新' },
        },
      ],
    })
    startSkillCredentialAuthMock.mockResolvedValue({
      id: 'lark-cli',
      action: { kind: 'feishu_device_flow' },
    })
    completeSkillCredentialAuthMock.mockResolvedValue({
      id: 'keep-record',
      status: 'authenticated',
      account_hint: 'Keep User',
    })
  })

  it('renders skill credential statuses without leaking raw secrets', async () => {
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(fetchSkillCredentialsMock).toHaveBeenCalledOnce()
    expect(wrapper.find('.header-title').text()).toBe('Connectors')
    expect(wrapper.findAll('.credential-card')).toHaveLength(5)
    expect(wrapper.find('[data-credential-group="internal-systems"]').text()).toContain('Internal systems')
    expect(wrapper.find('[data-credential-group="internal-systems"]').text()).toContain('Lark-cli')
    expect(wrapper.find('[data-credential-group="internal-systems"]').text()).toContain('飞书项目')
    expect(wrapper.find('[data-credential-group="internal-systems"]').text()).toContain('Keep-record')
    expect(wrapper.find('[data-credential-group="internal-systems"]').text()).toContain('kep-cli')
    expect(wrapper.find('[data-credential-group="other-credentials"]').text()).toContain('Other credentials')
    expect(wrapper.find('[data-credential-group="other-credentials"]').text()).not.toContain('Keep-record')
    expect(wrapper.find('[data-credential-group="other-credentials"]').text()).toContain('GitLab')
    expect(wrapper.text()).toContain('Lark-cli')
    expect(wrapper.text()).toContain('已认证')
    expect(wrapper.text()).toContain('孙可')
    expect(wrapper.text()).toContain('Keep-record')
    expect(wrapper.text()).toContain('待验证')
    expect(wrapper.text()).toContain('Keep User')
    expect(wrapper.text()).toContain('kep-cli')
    expect(wrapper.text()).toContain('飞书项目')
    expect(wrapper.text()).toContain('飞书项目需要授权后才能查询和更新工作项。')
    expect(wrapper.text()).not.toContain('MCP')
    expect(wrapper.text()).toContain('wiki-helper')
    expect(wrapper.text()).toContain('aidock-helper')
    expect(wrapper.text()).toContain('keep-login-skill')
    expect(wrapper.text()).toContain('GitLab')
    expect(wrapper.text()).toContain('Token 可读')

    const html = wrapper.html()
    expect(html).not.toContain('keep-secret-token')
    expect(html).not.toContain('gitlab-secret-token')
  })

  it('keeps dense required-skill lists from stretching sibling credential cards', async () => {
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.credentials-grid').classes()).toContain('credentials-grid-compact')
    expect(wrapper.find('.credential-required').classes()).toContain('credential-required-scroll')
  })

  it('starts the selected skill credential action from the page', async () => {
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-credential-action="lark-cli"]').trigger('click')

    expect(startSkillCredentialAuthMock).toHaveBeenCalledWith('lark-cli', '')
  })

  it('opens the OAuth authorization URL returned by kep-cli start', async () => {
    const authWindow = { opener: {}, location: { href: '' } } as any
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(authWindow)
    startSkillCredentialAuthMock.mockResolvedValueOnce({
      id: 'kep-cli',
      status: 'auth_pending',
      verification_uri: 'https://auth.example.com/?response_url=http://localhost:52237&oauth2=1',
      action: { kind: 'oauth_url', label: '打开 kep-cli 认证' },
    })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-credential-action="kep-cli"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(startSkillCredentialAuthMock).toHaveBeenCalledWith('kep-cli', '')
    expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank')
    expect(authWindow.opener).toBe(null)
    expect(authWindow.location.href).toBe('https://auth.example.com/?response_url=http://localhost:52237&oauth2=1')
  })

  it('opens the OAuth authorization URL returned by Feishu Project start', async () => {
    const authWindow = { opener: {}, location: { href: '' } } as any
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(authWindow)
    startSkillCredentialAuthMock.mockResolvedValueOnce({
      id: 'feishu-project',
      status: 'auth_pending',
      verification_uri: 'https://project.feishu.cn/oauth/device?user_code=ABCD-1234',
      action: { kind: 'oauth_url', label: '授权飞书项目' },
    })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-credential-action="feishu-project"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(startSkillCredentialAuthMock).toHaveBeenCalledWith('feishu-project', '')
    expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank')
    expect(authWindow.opener).toBe(null)
    expect(authWindow.location.href).toBe('https://project.feishu.cn/oauth/device?user_code=ABCD-1234')
  })

  it('renders and completes Keep-record QR auth without exposing token values', async () => {
    startSkillCredentialAuthMock.mockResolvedValueOnce({
      id: 'keep-record',
      status: 'qr_pending',
      qrcode_id: 'qr-1',
      qrcode_url: 'https://keep.example/qr.png',
      redirect_url: 'https://keep.example/login',
      action: { kind: 'qr_flow', label: 'Scan Keep QR code' },
    })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-credential-action="keep-record"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.qr-image').attributes('src')).toBe('https://keep.example/qr.png')
    expect(wrapper.text()).toContain('二维码图片链接')
    expect(wrapper.text()).not.toContain('keep-secret-token')

    await wrapper.findAll('button').at(-1)!.trigger('click')

    expect(completeSkillCredentialAuthMock).toHaveBeenCalledWith('keep-record', 'qr-1', '')
  })
})
