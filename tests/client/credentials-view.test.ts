// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const fetchSkillCredentialsMock = vi.hoisted(() => vi.fn())
const submitGitlabTokenMock = vi.hoisted(() => vi.fn())
const startSkillCredentialAuthMock = vi.hoisted(() => vi.fn())
const completeSkillCredentialAuthMock = vi.hoisted(() => vi.fn())
const pollFeishuUatSessionMock = vi.hoisted(() => vi.fn())
const messageSuccessMock = vi.hoisted(() => vi.fn())
const messageErrorMock = vi.hoisted(() => vi.fn())
const messageWarningMock = vi.hoisted(() => vi.fn())
const routeQuery = vi.hoisted(() => ({} as Record<string, string>))

vi.mock('@/api/skillCredentials', () => ({
  completeSkillCredentialAuth: completeSkillCredentialAuthMock,
  fetchSkillCredentials: fetchSkillCredentialsMock,
  pollFeishuUatSession: pollFeishuUatSessionMock,
  startSkillCredentialAuth: startSkillCredentialAuthMock,
  submitGitlabToken: submitGitlabTokenMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      let out = ({
        'market.title': 'Market',
        'sidebar.connectors': 'Connectors',
        'connectors.allConnectors': 'All connectors',
        'connectors.internalSystems': 'Internal systems',
        'connectors.otherCredentials': 'Other credentials',
        'connectors.noMatch': 'No matching results',
        'connectors.viewMore': '查看 {names}',
        'connectors.viewMoreRest': '查看 {names}，以及另外 {rest} 个',
      } as Record<string, string>)[key] || key
      if (params) {
        for (const [k, v] of Object.entries(params)) out = out.replace(`{${k}}`, String(v))
      }
      return out
    },
  }),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ name: 'hermes.connectors', query: routeQuery }),
  // The market tab strip in the page head navigates between sections.
  useRouter: () => ({ push: vi.fn() }),
}))

// Reactive so tests can flip activeProfileName post-mount and fire the
// component's requestedProfile watcher — the real profile-switch path.
const profilesState = vi.hoisted(() => ({ current: null as any }))
vi.mock('@/stores/hermes/profiles', async () => {
  const { reactive } = await import('vue')
  return {
    useProfilesStore: () => {
      if (!profilesState.current) {
        profilesState.current = reactive({
          activeProfileName: 'feishu_g41a5b5g',
          profiles: [{ name: 'feishu_g41a5b5g' }],
          fetchProfiles: vi.fn(),
        })
      }
      return profilesState.current
    },
  }
})

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<any>('naive-ui')
  return {
    ...actual,
    useMessage: () => ({
      success: messageSuccessMock,
      error: messageErrorMock,
      // 少一个 warning，"没启动任何流程"那条分支就会抛 TypeError 被自己的 catch 吞掉，
      // 新断言看着绿其实走的是错误路径（codex 评审）。mock 必须覆盖组件用到的全部通道。
      warning: messageWarningMock,
      info: vi.fn(),
    }),
    NButton: {
      props: ['loading', 'disabled'],
      template: '<button :disabled="disabled" :data-loading="loading ? \'true\' : undefined"><slot /></button>',
    },
    NSpin: {
      props: ['show'],
      template: '<div><slot /></div>',
    },
    NModal: {
      props: ['show', 'title'],
      emits: ['update:show'],
      template: '<div v-if="show" class="mock-modal"><slot /><slot name="footer" /></div>',
    },
  }
})

describe('CredentialsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    try { localStorage.clear() } catch { /* jsdom localStorage */ }
    for (const key of Object.keys(routeQuery)) delete routeQuery[key]
    // Fresh store instance per test: components from PREVIOUS tests stay mounted
    // and share the reactive store — mutating a shared instance would fire their
    // watchers too and let them steal this test's mockImplementationOnce queue.
    profilesState.current = null
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
          id: 'kep-cli-online',
          title: 'kep-cli online',
          provider: 'keep',
          installed: true,
          status: 'authenticated',
          detail: 'online ready',
          required_by: ['aidock-helper', 'keep-login-skill'],
          action: { kind: 'oauth_url', label: '重新认证', env: 'online' },
        },
        {
          id: 'kep-cli-pre',
          title: 'kep-cli pre',
          provider: 'keep',
          installed: true,
          status: 'needs_auth',
          detail: 'pre login required',
          action: { kind: 'oauth_url', label: '认证', env: 'pre' },
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

    expect(fetchSkillCredentialsMock).toHaveBeenCalledWith('feishu_g41a5b5g')
    // The page is one market with three sections: the h1 names the market, the
    // tab strip below it names the section.
    expect(wrapper.find('.header-titles h1').text()).toBe('Market')
    expect(wrapper.find('[data-testid="tabstrip-connectors"]').classes()).toContain('is-on')
    expect(wrapper.findAll('.credential-card')).toHaveLength(6)
    // Prototype anatomy: connectors split into "内部系统" / "其他凭证" catalog groups.
    const internalGroup = wrapper.find('[data-credential-group="internal"]')
    expect(internalGroup.text()).toContain('Internal systems')
    expect(internalGroup.text()).toContain('Lark-cli')
    expect(internalGroup.text()).toContain('飞书项目')
    expect(internalGroup.text()).toContain('Keep-record')
    expect(internalGroup.text()).toContain('kep-cli')
    const otherGroup = wrapper.find('[data-credential-group="other"]')
    expect(otherGroup.text()).toContain('Other credentials')
    expect(otherGroup.text()).toContain('GitLab')
    expect(wrapper.text()).toContain('Lark-cli')
    expect(wrapper.text()).toContain('已认证')
    expect(wrapper.text()).toContain('孙可')
    expect(wrapper.text()).toContain('Keep-record')
    expect(wrapper.text()).toContain('待验证')
    expect(wrapper.text()).toContain('Keep User')
    expect(wrapper.text()).toContain('kep-cli online')
    expect(wrapper.text()).toContain('kep-cli pre')
    expect(wrapper.text()).toContain('飞书项目')
    expect(wrapper.text()).toContain('飞书项目需要授权后才能查询和更新工作项。')
    expect(wrapper.text()).not.toContain('MCP')
    expect(wrapper.text()).not.toContain('关联技能')
    expect(wrapper.text()).not.toContain('wiki-helper')
    expect(wrapper.text()).not.toContain('aidock-helper')
    expect(wrapper.text()).not.toContain('keep-login-skill')
    expect(wrapper.text()).toContain('GitLab')
    expect(wrapper.text()).toContain('Token 可读')

    const html = wrapper.html()
    expect(html).not.toContain('keep-secret-token')
    expect(html).not.toContain('gitlab-secret-token')
  })

  it('renders every connector flat with no fold/expand behind a MoreLine', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: `conn-${i + 1}`,
      title: `连接器${i + 1}`,
      provider: 'keep',
      installed: true,
      status: 'needs_auth',
      detail: `第 ${i + 1} 个`,
      action: { kind: 'oauth_url', label: '认证' },
    }))
    fetchSkillCredentialsMock.mockResolvedValue({ profile_name: 'feishu_g41a5b5g', credentials: rows })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('.credential-card')).toHaveLength(8)
    expect(wrapper.find('.more-line').exists()).toBe(false)
  })

  it('paints last-known status instantly from localStorage before the live refresh resolves', async () => {
    localStorage.clear()
    const cached = {
      profile_name: 'feishu_g41a5b5g',
      credentials: [
        { id: 'kep-cli', title: 'kep-cli', provider: 'keep', installed: true, status: 'authenticated', action: { kind: 'oauth_url', label: '重新认证' } },
      ],
    }
    // 用导出的 key 助手，别硬编码字符串：缓存 key 里带 schema 版本，形状一变就 bump，
    // 硬编码会让这条测试在 bump 后静默读不到缓存（本次 v1→v2 就是这么红的）。
    const { connectorStatusCacheKey } = await import('@/utils/connector-status-cache')
    localStorage.setItem(connectorStatusCacheKey('feishu_g41a5b5g'), JSON.stringify(cached))
    // Hang the live refresh so only the cached instant-paint is observable.
    let resolveFetch: (v: any) => void = () => {}
    fetchSkillCredentialsMock.mockReturnValue(new Promise(r => { resolveFetch = r }))

    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await wrapper.vm.$nextTick()

    // Cached card renders even though the live fetch has NOT resolved yet.
    expect(wrapper.findAll('.credential-card').length).toBeGreaterThan(0)
    expect(wrapper.text()).toContain('kep-cli')

    resolveFetch({ profile_name: 'feishu_g41a5b5g', credentials: cached.credentials })
    localStorage.clear()
  })

  it('drops a superseded refresh so a late response cannot overwrite a newer one (load-seq guard)', async () => {
    // Two overlapping refreshes exercise the same loadSeq guard that protects a profile
    // switch. The standalone refresh button is gone (prototype head has search only),
    // so the overlap is driven via the retry card's corner action — same loadCredentials
    // fresh path.
    localStorage.clear()
    routeQuery.profile = 'feishu_g41a5b5g'
    const row = (status: string, label: string) => [
      { id: 'kep-cli', title: 'kep-cli', provider: 'keep', installed: true, status, detail: label, action: { kind: 'retry', label: '重试' } },
    ]
    fetchSkillCredentialsMock.mockResolvedValueOnce({ profile_name: 'feishu_g41a5b5g', credentials: row('authenticated', 'INIT') })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(r => setTimeout(r, 0)); await wrapper.vm.$nextTick()

    // refresh #1 hangs (the stale one); refresh #2 resolves (the current one)
    let resolveStale: () => void = () => {}
    fetchSkillCredentialsMock.mockImplementationOnce(() => new Promise(r => { resolveStale = () => r({ profile_name: 'feishu_g41a5b5g', credentials: row('missing', 'STALE-B') }) }))
    fetchSkillCredentialsMock.mockResolvedValueOnce({ profile_name: 'feishu_g41a5b5g', credentials: row('needs_auth', 'CURRENT-A') })
    const btn = wrapper.find('[data-credential-action="kep-cli"]')
    await btn.trigger('click')  // refresh #1 (hangs) → loadSeq = N
    await btn.trigger('click')  // refresh #2 (resolves) → loadSeq = N+1 → applies CURRENT-A
    await new Promise(r => setTimeout(r, 0)); await wrapper.vm.$nextTick()
    resolveStale()              // late stale response — guard must drop it
    await new Promise(r => setTimeout(r, 0)); await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('CURRENT-A')
    expect(wrapper.text()).not.toContain('STALE-B')
    localStorage.clear()
  })

  it('a superseded load that FAILS does not show its error over the current panel', async () => {
    // The error channel must respect the same guard: an old failed load must not set
    // error.value while a newer load (data still null, in-flight) is pending. With the
    // refresh button gone, the second load is driven by the REAL trigger the guard
    // exists for: a profile switch while the mount load is still in flight.
    localStorage.clear()
    const row = (status: string, label: string) => [
      { id: 'kep-cli', title: 'kep-cli', provider: 'keep', installed: true, status, detail: label, action: { kind: 'oauth_url', label: 'x' } },
    ]
    // initial (mount) load #1 hangs, then REJECTS — data stays null
    let rejectInit: () => void = () => {}
    fetchSkillCredentialsMock.mockImplementationOnce(() => new Promise((_res, rej) => { rejectInit = () => rej(new Error('STALE-ERROR')) }))
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await wrapper.vm.$nextTick()  // load #1 in flight, data null
    // load #2 (profile switch) starts, hangs, then resolves CURRENT
    let resolveNew: () => void = () => {}
    fetchSkillCredentialsMock.mockImplementationOnce(() => new Promise(res => { resolveNew = () => res({ profile_name: 'feishu_user_b', credentials: row('needs_auth', 'CURRENT-A') }) }))
    profilesState.current.activeProfileName = 'feishu_user_b'  // fires the watcher → load #2, loadSeq bumped
    await wrapper.vm.$nextTick()
    rejectInit()  // stale load #1 fails while data is still null and #2 is pending
    await new Promise(r => setTimeout(r, 0)); await wrapper.vm.$nextTick()
    resolveNew()  // current load resolves
    await new Promise(r => setTimeout(r, 0)); await wrapper.vm.$nextTick()

    expect(wrapper.find('.credentials-error').exists()).toBe(false)  // stale error suppressed
    expect(wrapper.text()).toContain('CURRENT-A')
    localStorage.clear()
  })

  it('the retry card corner requests FRESH status (bypasses the broker cache)', async () => {
    localStorage.clear()
    fetchSkillCredentialsMock.mockResolvedValue({
      profile_name: 'feishu_g41a5b5g',
      credentials: [
        { id: 'kep-cli', title: 'kep-cli', provider: 'keep', installed: true, status: 'error', detail: '暂时不可用', action: { kind: 'retry', label: '重试' } },
      ],
    })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()
    // Initial mount load is cached (single-arg); the manual retry must be fresh.
    expect(fetchSkillCredentialsMock).toHaveBeenLastCalledWith('feishu_g41a5b5g')
    fetchSkillCredentialsMock.mockClear()

    await wrapper.find('[data-credential-action="kep-cli"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fetchSkillCredentialsMock).toHaveBeenCalledWith('feishu_g41a5b5g', { fresh: true })
  })

  it('keeps explicit route profile support on the standalone connectors route', async () => {
    routeQuery.profile = 'route_profile'
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fetchSkillCredentialsMock).toHaveBeenCalledWith('route_profile')
  })

  it('prefers the active profile when embedded in Expert', async () => {
    routeQuery.profile = 'stale_route_profile'
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    mount(CredentialsView, {
      props: {
        embedded: true,
        preferActiveProfile: true,
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fetchSkillCredentialsMock).toHaveBeenCalledWith('feishu_g41a5b5g')
  })

  it('does not render associated skills on credential cards', async () => {
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.credential-required').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('关联技能')
  })

  it('starts the selected skill credential action from the page', async () => {
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-credential-action="lark-cli"]').trigger('click')

    expect(startSkillCredentialAuthMock).toHaveBeenCalledWith('lark-cli', 'feishu_g41a5b5g')
  })

  it('passes a credential action env through when starting kep-cli auth', async () => {
    fetchSkillCredentialsMock.mockResolvedValueOnce({
      profile_name: 'feishu_g41a5b5g',
      credentials: [
        {
          id: 'kep-cli-pre',
          title: 'kep-cli pre',
          provider: 'keep',
          installed: true,
          status: 'needs_auth',
          detail: 'pre 未登录；online 已登录。',
          action: { kind: 'oauth_url', label: '认证 pre', env: 'pre' },
        },
      ],
    })
    startSkillCredentialAuthMock.mockResolvedValueOnce({
      id: 'kep-cli-pre',
      status: 'auth_pending',
      action: { kind: 'oauth_url', label: '认证 pre', env: 'pre' },
    })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-credential-action="kep-cli-pre"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(startSkillCredentialAuthMock).toHaveBeenCalledWith('kep-cli-pre', 'feishu_g41a5b5g', { env: 'pre' })
  })

  it('opens the OAuth authorization URL returned by kep-cli start', async () => {
    const authWindow = { opener: {}, location: { href: '' } } as any
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(authWindow)
    startSkillCredentialAuthMock.mockResolvedValueOnce({
      id: 'kep-cli-online',
      status: 'auth_pending',
      verification_uri: 'https://auth.example.com/?response_url=http://localhost:52237&oauth2=1',
      action: { kind: 'oauth_url', label: '打开 kep-cli online 认证', env: 'online' },
    })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-credential-action="kep-cli-online"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(startSkillCredentialAuthMock).toHaveBeenCalledWith('kep-cli-online', 'feishu_g41a5b5g', { env: 'online' })
    expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank')
    expect(authWindow.opener).toBe(null)
    expect(authWindow.location.href).toBe('https://auth.example.com/?response_url=http://localhost:52237&oauth2=1')
  })

  it('does not keep the OAuth action button in loading state while background polling continues', async () => {
    const authWindow = { opener: {}, location: { href: '' } } as any
    vi.spyOn(window, 'open').mockReturnValue(authWindow)
    startSkillCredentialAuthMock.mockResolvedValueOnce({
      id: 'kep-cli-online',
      status: 'auth_pending',
      verification_uri: 'https://auth.example.com/?response_url=http://localhost:52237&oauth2=1',
      action: { kind: 'oauth_url', label: '打开 kep-cli online 认证', env: 'online' },
    })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-credential-action="kep-cli-online"]').trigger('click')
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    const action = wrapper.find('[data-credential-action="kep-cli-online"]')
    expect(action.attributes('data-loading')).toBeUndefined()
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

    expect(startSkillCredentialAuthMock).toHaveBeenCalledWith('feishu-project', 'feishu_g41a5b5g')
    expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank')
    expect(authWindow.opener).toBe(null)
    expect(authWindow.location.href).toBe('https://project.feishu.cn/oauth/device?user_code=ABCD-1234')
  })

  it('polls the Feishu UAT device-flow session returned by lark-cli start', async () => {
    const authWindow = { opener: {}, location: { href: '' }, closed: false, close: vi.fn() } as any
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(authWindow)
    const row = (status: string) => [
      {
        id: 'lark-cli',
        title: 'Lark-cli',
        provider: 'lark',
        installed: true,
        status,
        detail: status === 'authenticated' ? 'ready' : 'needs auth',
        action: { kind: 'feishu_device_flow', label: status === 'authenticated' ? '重新授权' : '授权' },
      },
    ]
    fetchSkillCredentialsMock
      .mockResolvedValueOnce({ profile_name: 'feishu_g41a5b5g', credentials: row('needs_auth') })
      .mockResolvedValueOnce({ profile_name: 'feishu_g41a5b5g', credentials: row('authenticated') })
    startSkillCredentialAuthMock.mockResolvedValueOnce({
      id: 'lark-cli',
      status: 'pending',
      session_id: 'uat-session-1',
      verification_uri: 'https://accounts.feishu.cn/device?user_code=ABCD-1234',
      action: { kind: 'feishu_device_flow', label: '授权' },
    })
    pollFeishuUatSessionMock
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'success' })

    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    vi.useFakeTimers()
    try {
      await wrapper.find('[data-credential-action="lark-cli"]').trigger('click')
      await Promise.resolve()

      expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank')
      expect(authWindow.location.href).toBe('https://accounts.feishu.cn/device?user_code=ABCD-1234')

      await vi.advanceTimersByTimeAsync(2_500)
      expect(pollFeishuUatSessionMock).toHaveBeenCalledTimes(1)
      expect(fetchSkillCredentialsMock).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(2_500)
      await wrapper.vm.$nextTick()

      expect(pollFeishuUatSessionMock).toHaveBeenCalledTimes(2)
      expect(pollFeishuUatSessionMock).toHaveBeenLastCalledWith('uat-session-1', 'feishu_g41a5b5g')
      expect(fetchSkillCredentialsMock).toHaveBeenLastCalledWith('feishu_g41a5b5g', { fresh: true })
      expect(authWindow.close).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports Feishu UAT session expiry without marking lark-cli authenticated', async () => {
    const authWindow = { opener: {}, location: { href: '' }, closed: false, close: vi.fn() } as any
    vi.spyOn(window, 'open').mockReturnValue(authWindow)
    fetchSkillCredentialsMock.mockResolvedValueOnce({
      profile_name: 'feishu_g41a5b5g',
      credentials: [
        {
          id: 'lark-cli',
          title: 'Lark-cli',
          provider: 'lark',
          installed: true,
          status: 'needs_auth',
          detail: 'needs auth',
          action: { kind: 'feishu_device_flow', label: '授权' },
        },
      ],
    })
    startSkillCredentialAuthMock.mockResolvedValueOnce({
      id: 'lark-cli',
      status: 'pending',
      session_id: 'uat-session-expired',
      verification_uri: 'https://accounts.feishu.cn/device?user_code=ABCD-1234',
      action: { kind: 'feishu_device_flow', label: '授权' },
    })
    pollFeishuUatSessionMock.mockResolvedValueOnce({ status: 'expired', error: '授权会话已过期' })

    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    vi.useFakeTimers()
    try {
      await wrapper.find('[data-credential-action="lark-cli"]').trigger('click')
      await Promise.resolve()

      await vi.advanceTimersByTimeAsync(2_500)
      await wrapper.vm.$nextTick()

      // Reported on the credential's own card now, not in a toast — but the
      // point of the test is unchanged: it must be SAID, and lark-cli must not
      // be marked authenticated on the way.
      expect(wrapper.find('[data-testid="credential-notice"]').text()).toContain('授权会话已过期')
      expect(fetchSkillCredentialsMock).toHaveBeenCalledTimes(1)
      expect(authWindow.close).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports HTTP-level Feishu UAT poll failures instead of silently ending', async () => {
    const authWindow = { opener: {}, location: { href: '' }, closed: false, close: vi.fn() } as any
    vi.spyOn(window, 'open').mockReturnValue(authWindow)
    fetchSkillCredentialsMock.mockResolvedValueOnce({
      profile_name: 'feishu_g41a5b5g',
      credentials: [
        {
          id: 'lark-cli',
          title: 'Lark-cli',
          provider: 'lark',
          installed: true,
          status: 'needs_auth',
          detail: 'needs auth',
          action: { kind: 'feishu_device_flow', label: '授权' },
        },
      ],
    })
    startSkillCredentialAuthMock.mockResolvedValueOnce({
      id: 'lark-cli',
      status: 'pending',
      session_id: 'uat-session-404',
      verification_uri: 'https://accounts.feishu.cn/device?user_code=ABCD-1234',
      action: { kind: 'feishu_device_flow', label: '授权' },
    })
    pollFeishuUatSessionMock.mockRejectedValueOnce(new Error('授权会话不存在'))

    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    vi.useFakeTimers()
    try {
      await wrapper.find('[data-credential-action="lark-cli"]').trigger('click')
      await Promise.resolve()

      await vi.advanceTimersByTimeAsync(2_500)
      await wrapper.vm.$nextTick()

      expect(wrapper.find('[data-testid="credential-notice"]').text()).toContain('授权会话不存在')
      expect(fetchSkillCredentialsMock).toHaveBeenCalledTimes(1)
      expect(authWindow.close).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not close a lark-cli re-auth popup from a stale authenticated focus refresh', async () => {
    const authWindow = { opener: {}, location: { href: '' }, closed: false, close: vi.fn() } as any
    vi.spyOn(window, 'open').mockReturnValue(authWindow)
    fetchSkillCredentialsMock.mockResolvedValueOnce({
      profile_name: 'feishu_g41a5b5g',
      credentials: [
        {
          id: 'lark-cli',
          title: 'Lark-cli',
          provider: 'lark',
          installed: true,
          status: 'authenticated',
          detail: 'ready from previous auth',
          action: { kind: 'feishu_device_flow', label: '重新授权' },
        },
      ],
    })
    startSkillCredentialAuthMock.mockResolvedValueOnce({
      id: 'lark-cli',
      status: 'pending',
      session_id: 'uat-session-reauth',
      verification_uri: 'https://accounts.feishu.cn/device?user_code=ABCD-1234',
      action: { kind: 'feishu_device_flow', label: '重新授权' },
    })
    pollFeishuUatSessionMock.mockResolvedValueOnce({ status: 'pending' })

    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-credential-action="lark-cli"]').trigger('click')
    await Promise.resolve()
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()

    expect(authWindow.close).not.toHaveBeenCalled()
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

    expect(completeSkillCredentialAuthMock).toHaveBeenCalledWith('keep-record', 'qr-1', 'feishu_g41a5b5g')
  })

  it('splits GitLab into a button-less global card and an actionable personal card', async () => {
    // The broker now emits two gitlab rows. The global one is admin-operated, so it
    // must render NO button; the personal one must open the own-token form. Keying the
    // form on the literal id 'gitlab' (the old check) would leave the personal card's
    // button inert — the exact defect this split exists to fix.
    fetchSkillCredentialsMock.mockResolvedValue({
      profile: 'feishu_g41a5b5g',
      credentials: [
        {
          id: 'gitlab',
          title: 'GitLab（全局）',
          provider: 'gitlab',
          installed: true,
          status: 'configured',
          detail: '管理员配置的共用 GitLab token（不展示内容），全员共享；你不能改它。',
          // action 缺省 = 没有员工可执行的操作。这是 broker(送 null) + coerceAction(如实
          // 返回 undefined) 之后的真实形状；旧夹具写 {kind:'manual',label:''} 是"有操作但
          // 没标签"，语义完全不同，现在会渲染出一颗兜底文案的按钮。
        },
        {
          id: 'gitlab-personal',
          title: 'GitLab（我的）',
          provider: 'gitlab',
          installed: true,
          status: 'needs_auth',
          detail: '绑定后 hermes 用你本人的权限操作仓库；不绑就一直用全局那个。',
          action: { kind: 'manual', label: '绑定我的 GitLab' },
        },
      ],
    })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    // Two cards, not one.
    expect(wrapper.text()).toContain('GitLab（全局）')
    expect(wrapper.text()).toContain('GitLab（我的）')

    // Global card: stated only, no affordance the employee cannot act on.
    expect(wrapper.find('[data-credential-action="gitlab"]').exists()).toBe(false)

    // Personal card: the button opens the own-token form, and does NOT start an
    // interactive auth flow (GitLab has none).
    const personal = wrapper.find('[data-credential-action="gitlab-personal"]')
    expect(personal.exists()).toBe(true)
    // 原型 CornerBtn 是图标钮，动作文案走 title/aria-label。
    expect(personal.attributes('title')).toBe('绑定我的 GitLab')
    await personal.trigger('click')
    await wrapper.vm.$nextTick()

    expect(startSkillCredentialAuthMock).not.toHaveBeenCalled()
    // The own-token form is what opened — assert on the form itself rather than the
    // modal chrome, which NModal teleports out of the wrapper.
    const html = wrapper.html() + document.body.innerHTML
    expect(html).toContain('gitlab-form')
  })

  it('opens the token form for the personal GitLab card even when action.kind drifted', async () => {
    // ligaofeng 2026-08-06：点「绑定我的 GitLab」只弹一句「认证流程已启动」，卡片纹丝
    // 不动。只要 kind 不是 'manual'（降级卡、旧缓存、reader 改字段都能造成），旧判据就
    // 静默失效、按钮掉进 startCredential —— 而 GitLab 压根没有交互式流程可启动。
    fetchSkillCredentialsMock.mockResolvedValue({
      profile: 'feishu_g41a5b5g',
      credentials: [
        {
          id: 'gitlab-personal',
          title: 'GitLab（我的）',
          provider: 'gitlab',
          installed: true,
          status: 'needs_auth',
          detail: '绑定后 hermes 用你本人的权限操作仓库；不绑就一直用全局那个。',
          action: { kind: 'oauth_url', label: '绑定我的 GitLab' },
        },
      ],
    })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-credential-action="gitlab-personal"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(startSkillCredentialAuthMock).not.toHaveBeenCalled()
    expect(wrapper.html() + document.body.innerHTML).toContain('gitlab-form')
  })

  it('opens the personal GitLab token form requested by a stale-client handoff URL', async () => {
    routeQuery.open_credential = 'gitlab-personal'
    fetchSkillCredentialsMock.mockResolvedValue({
      profile: 'feishu_g41a5b5g',
      credentials: [
        {
          id: 'gitlab-personal',
          title: 'GitLab（我的）',
          provider: 'gitlab',
          installed: true,
          status: 'needs_auth',
          detail: '绑定后使用本人权限。',
          action: { kind: 'manual', label: '绑定我的 GitLab' },
        },
      ],
    })

    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(startSkillCredentialAuthMock).not.toHaveBeenCalled()
    expect(wrapper.html() + document.body.innerHTML).toContain('gitlab-form')
  })

  it('never reports success when the start response started nothing', async () => {
    // 服务端现在对无流程连接器回 400，这条是客户端侧的防线：万一又有人回一个
    // 200 空操作，也不许弹绿色「认证流程已启动」——那正是 ligaofeng 看到的假成功。
    fetchSkillCredentialsMock.mockResolvedValue({
      profile_name: 'feishu_user_a',
      credentials: [
        {
          id: 'kep-cli-online',
          title: 'kep-cli online',
          provider: 'keep',
          installed: true,
          status: 'needs_auth',
          detail: '需要认证',
          action: { kind: 'oauth_url', label: '认证', env: 'online' },
        },
      ],
    })
    startSkillCredentialAuthMock.mockResolvedValue({ id: 'kep-cli-online', action: { kind: 'manual', label: '' } })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-credential-action="kep-cli-online"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    // The original point stands: a start that started nothing must not read as
    // success. There is no toast channel to check any more, so it is asserted on
    // the card — a notice IS shown, and it is the neutral/informational tone,
    // not a swallowed error and not a success.
    const notice = wrapper.find('[data-testid="credential-notice"]')
    expect(notice.exists()).toBe(true)
    expect(notice.classes()).toContain('is-info')
    expect(notice.classes()).not.toContain('is-error')
  })

  it('refreshes instead of starting anything when the broker-down card says 重试', async () => {
    // broker 挂掉 → failSafeResult 把每一行变成 status:error + 「重试」。那颗按钮是
    // "再读一次状态"，不是启动认证；GitLab 行更不能被劫持去开 token 表单（codex 评审）。
    fetchSkillCredentialsMock.mockResolvedValue({
      profile_name: 'feishu_user_a',
      credentials: [
        {
          id: 'gitlab',
          title: 'GitLab（全局）',
          provider: 'gitlab',
          installed: false,
          status: 'error',
          detail: '凭证状态服务暂时不可用',
          action: { kind: 'retry', label: '重试' },
        },
      ],
    })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()
    const callsBefore = fetchSkillCredentialsMock.mock.calls.length

    await wrapper.find('[data-credential-action="gitlab"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(startSkillCredentialAuthMock).not.toHaveBeenCalled()
    expect(wrapper.html() + document.body.innerHTML).not.toContain('gitlab-form')
    expect(fetchSkillCredentialsMock.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it('renders a button whenever an action exists — even if its label went missing', async () => {
    // 区分两种判据的唯一用例：按 `entry.action` 判 → 渲染；按 `entry.action?.label` 判 →
    // 不渲染。有 kind 却没 label 是数据问题，不是"没有操作"；静默吞掉会让那张卡永远
    // 点不动且无人察觉。没有这条，客户端那行 v-if 改动等于没有测试锁。
    fetchSkillCredentialsMock.mockResolvedValue({
      profile: 'feishu_g41a5b5g',
      credentials: [
        {
          id: 'gitlab',
          title: 'GitLab（全局）',
          provider: 'gitlab',
          installed: true,
          status: 'configured',
          detail: '没有操作的卡',
          // action 整个缺省 = 真的没有操作
        },
        {
          id: 'kep-cli-online',
          title: 'kep-cli online',
          provider: 'keep',
          installed: true,
          status: 'needs_auth',
          detail: '标签丢了的卡',
          action: { kind: 'oauth_url', label: '', env: 'online' },
        },
      ],
    })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-credential-action="gitlab"]').exists()).toBe(false)
    const labelless = wrapper.find('[data-credential-action="kep-cli-online"]')
    expect(labelless.exists()).toBe(true)
    // 图标钮没有可见文案，兜底提示落在 title/aria-label 上。
    expect(labelless.attributes('title')).toBe('连接')
  })

  it('gitlab bind sends the panel profile as a target hint and repaints FRESH', async () => {
    fetchSkillCredentialsMock.mockResolvedValue({
      profile_name: 'feishu_g41a5b5g',
      credentials: [
        {
          id: 'gitlab-personal',
          title: 'GitLab（我的）',
          provider: 'gitlab',
          installed: true,
          status: 'needs_auth',
          detail: '群主绑定后，本群所有会话都会用群主的权限操作仓库；不绑就一直用全局那个。',
          action: { kind: 'manual', label: '群主绑定 GitLab' },
        },
      ],
    })
    submitGitlabTokenMock.mockResolvedValue({
      ok: true,
      stored: true,
      profile_scope: 'group',
      note: '已绑定到本群：本群所有会话都会使用此 token。',
    })

    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-credential-action="gitlab-personal"]').trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.find('.mock-modal input').setValue('glpat-group-token')
    const submit = wrapper.findAll('.mock-modal button').find(b => b.text().includes('提交'))
    expect(submit).toBeTruthy()
    await submit!.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    // 面板 profile 作为目标提示随请求带出；身份仍由服务端 session 盖章。
    expect(submitGitlabTokenMock).toHaveBeenCalledWith(
      { tier: 'read', token: 'glpat-group-token' },
      'feishu_g41a5b5g',
    )
    // 落点说明来自 broker 回执，原样展示给绑定人 —— 现在长在卡片上而不是弹一下就没。
    expect(wrapper.find('[data-testid="credential-notice"]').text())
      .toContain('已绑定到本群：本群所有会话都会使用此 token。')
    // 成功后的刷新必须 fresh —— 否则短 TTL 缓存把绑定前的状态刷回来，绑定看起来失败。
    const lastFetch = fetchSkillCredentialsMock.mock.calls.at(-1)
    expect(lastFetch?.[1]).toEqual({ fresh: true })
  })

  it('gitlab bind sends the panel profile as a target hint and repaints FRESH', async () => {
    fetchSkillCredentialsMock.mockResolvedValue({
      profile_name: 'feishu_g41a5b5g',
      credentials: [
        {
          id: 'gitlab-personal',
          title: 'GitLab（我的）',
          provider: 'gitlab',
          installed: true,
          status: 'needs_auth',
          detail: '群主绑定后，本群所有会话都会用群主的权限操作仓库；不绑就一直用全局那个。',
          action: { kind: 'manual', label: '群主绑定 GitLab' },
        },
      ],
    })
    submitGitlabTokenMock.mockResolvedValue({
      ok: true,
      stored: true,
      profile_scope: 'group',
      note: '已绑定到本群：本群所有会话都会使用此 token。',
    })

    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-credential-action="gitlab-personal"]').trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.find('.mock-modal input').setValue('glpat-group-token')
    const submit = wrapper.findAll('.mock-modal button').find(b => b.text().includes('提交'))
    expect(submit).toBeTruthy()
    await submit!.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    // 面板 profile 作为目标提示随请求带出；身份仍由服务端 session 盖章。
    expect(submitGitlabTokenMock).toHaveBeenCalledWith(
      { tier: 'read', token: 'glpat-group-token' },
      'feishu_g41a5b5g',
    )
    // 落点说明来自 broker 回执，原样提示给绑定人 —— 落在卡片自己的 notice 行上，
    // 不是全局 toast:回执讲的是这张卡的落点，答案就该长在被点的那张卡上。
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="credential-notice"]').text())
      .toContain('已绑定到本群：本群所有会话都会使用此 token。')
    // 成功后的刷新必须 fresh —— 否则短 TTL 缓存把绑定前的状态刷回来，绑定看起来失败。
    const lastFetch = fetchSkillCredentialsMock.mock.calls.at(-1)
    expect(lastFetch?.[1]).toEqual({ fresh: true })
  })
})
