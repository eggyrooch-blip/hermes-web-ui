// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'

const fetchSkillCredentialsMock = vi.hoisted(() => vi.fn())
const submitGitlabTokenMock = vi.hoisted(() => vi.fn())
const submitGithubTokenMock = vi.hoisted(() => vi.fn())
const revokeGithubTokenMock = vi.hoisted(() => vi.fn())
const revokeFigmaCredentialMock = vi.hoisted(() => vi.fn())
const startSkillCredentialAuthMock = vi.hoisted(() => vi.fn())
const completeSkillCredentialAuthMock = vi.hoisted(() => vi.fn())
const pollFeishuUatSessionMock = vi.hoisted(() => vi.fn())
const fetchConnectorCatalogMock = vi.hoisted(() => vi.fn())
const fetchCustomConnectorsMock = vi.hoisted(() => vi.fn())
const importCustomConnectorsMock = vi.hoisted(() => vi.fn())
const connectCatalogConnectorMock = vi.hoisted(() => vi.fn())
const deleteCustomConnectorMock = vi.hoisted(() => vi.fn())
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
  submitGithubToken: submitGithubTokenMock,
  revokeGithubToken: revokeGithubTokenMock,
  revokeFigmaCredential: revokeFigmaCredentialMock,
}))

vi.mock('@/api/connectorCatalog', () => ({
  fetchConnectorCatalog: fetchConnectorCatalogMock,
  fetchCustomConnectors: fetchCustomConnectorsMock,
  importCustomConnectors: importCustomConnectorsMock,
  connectCatalogConnector: connectCatalogConnectorMock,
  deleteCustomConnector: deleteCustomConnectorMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'skillCredentials.groups.internalSystems': 'Internal systems',
      'skillCredentials.groups.otherCredentials': 'Other credentials',
      'skillCredentials.larkAuthRequired': 'Lark-cli authorization was not saved. Re-authorize from the card below.',
      'sidebar.connectors': 'Connectors',
      'skillCredentials.github.title': 'GitHub — connect my personal credential',
      'skillCredentials.github.hint': 'PAT stays in the vault; Agent gets a broker token.',
      'skillCredentials.github.readonly': 'Read-only MCP with companion Skill.',
      'skillCredentials.github.create': 'Create a fine-grained PAT on GitHub',
      'skillCredentials.github.repositoryAccess': 'Only select repositories the Agent may query.',
      'skillCredentials.github.permissions': 'Use read-only Contents, Issues and Pull requests permissions.',
      'skillCredentials.github.returnToPaste': 'Generate the token, copy it once, then return here to paste it.',
      'skillCredentials.github.token': 'GitHub PAT',
      'skillCredentials.github.placeholder': 'Paste your GitHub PAT',
      'skillCredentials.github.connect': 'Connect',
      'skillCredentials.github.cancel': 'Cancel',
      'skillCredentials.github.revoke': 'Revoke',
      'skillCredentials.github.revokeConfirm': 'Revoke GitHub?',
      'skillCredentials.github.revoked': 'GitHub revoked',
      'skillCredentials.github.failed': 'GitHub failed',
      'skillCredentials.figma.revoke': 'Revoke Figma',
      'skillCredentials.figma.revokeConfirm': 'Revoke Figma?',
      'skillCredentials.figma.revoked': 'Figma revoked',
      'skillCredentials.figma.failed': 'Figma failed',
      'skillCredentials.figma.cancel': 'Cancel',
    } as Record<string, string>)[key] || key,
  }),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery }),
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({
    activeProfileName: 'feishu_g41a5b5g',
    profiles: [{ name: 'feishu_g41a5b5g' }],
    fetchProfiles: vi.fn(),
  }),
}))

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

// Unmount after each test so an OAuth poll left running on real timers stops (pollAbort)
// instead of calling the shared fetchSkillCredentials mock during a later test.
enableAutoUnmount(afterEach)

describe('CredentialsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    try { localStorage.clear() } catch { /* jsdom localStorage */ }
    for (const key of Object.keys(routeQuery)) delete routeQuery[key]
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
    fetchConnectorCatalogMock.mockResolvedValue({
      profile_name: 'feishu_g41a5b5g',
      subject_id: 'owner-a',
      view: 'source',
      source_count: 642,
      canonical_count: 330,
      connectors: [],
    })
    fetchCustomConnectorsMock.mockResolvedValue({
      profile_name: 'feishu_g41a5b5g',
      subject_id: 'owner-a',
      connectors: [],
    })
    importCustomConnectorsMock.mockResolvedValue({
      profile_name: 'feishu_g41a5b5g',
      subject_id: 'owner-a',
      connectors: [],
    })
    connectCatalogConnectorMock.mockResolvedValue({
      profile_name: 'feishu_g41a5b5g', subject_id: 'owner-a', connectors: [],
    })
    deleteCustomConnectorMock.mockResolvedValue({ ok: true })
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
    expect(wrapper.find('.header-title').text()).toBe('Connectors')
    expect(wrapper.findAll('.credential-card')).toHaveLength(6)
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

  it('retries a failed catalog when the page refresh button is clicked', async () => {
    fetchConnectorCatalogMock.mockRejectedValueOnce(new Error('catalog timeout'))
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('catalog timeout')
    const refresh = wrapper.findAll('button').find(button => button.text() === '刷新')!
    await refresh.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()
    expect(fetchConnectorCatalogMock).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).not.toContain('catalog timeout')
  })

  it('shows the owner-scoped catalog and rejects command-based custom imports', async () => {
    fetchConnectorCatalogMock.mockResolvedValueOnce({
      profile_name: 'feishu_g41a5b5g', subject_id: 'owner-a', view: 'source',
      source_count: 642, canonical_count: 330,
      connectors: [
        { row_key: 'github', canonical_key: 'github', name: 'GitHub', product: 'GitHub', final_verdict: 'needs_auth', download_count: 1200,
          reason_code: 'remote_auth_required', next_action: 'Complete personal OAuth', action: { kind: 'authorize', label: 'Authorization required', available: false } },
        { row_key: 'unknown', canonical_key: 'unknown', name: 'Unknown', product: 'Example', final_verdict: 'needs_sandbox', download_count: null,
          next_action: 'Use an admitted sandbox package', action: { kind: 'install_sandbox', label: 'Sandbox required', available: false } },
      ],
    })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    expect(fetchConnectorCatalogMock).toHaveBeenCalledWith('source')
    expect(fetchCustomConnectorsMock).toHaveBeenCalledWith()
    expect(wrapper.findAll('.catalog-card')).toHaveLength(2)
    expect(wrapper.find('.catalog-card').attributes('tabindex')).toBe('0')
    expect(wrapper.text()).toContain('↓ mcp.downloadUnknown')

    await wrapper.find('.catalog-card').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.mock-modal').text()).toContain('Complete personal OAuth')
    expect(connectCatalogConnectorMock).not.toHaveBeenCalled()

    await wrapper.find('[data-testid="custom-connector-open"]').trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.find('.mock-modal textarea').setValue('{"mcpServers":{"unsafe":{"command":"npx"}}}')
    await wrapper.vm.$nextTick()
    const save = wrapper.findAll('.mock-modal button').at(-1)!
    expect(save.attributes('disabled')).toBeDefined()
    expect(importCustomConnectorsMock).not.toHaveBeenCalled()
  })

  it('connects and revokes an available catalog card through the owner-bound APIs', async () => {
    const installation = {
      connector_id: 'custom-0123456789abcdef01234567', name: 'catalog-ready', transport: 'streamable_http',
      endpoint: 'https://example.com/mcp', credential_fields: [], state: 'active', updated_at: 1,
    }
    const catalog = (connected = false) => ({
      profile_name: 'current', subject_id: 'owner', view: 'source', source_count: 642, canonical_count: 330,
      connectors: [{ row_key: 'ready', canonical_key: 'ready', name: 'Ready MCP', final_verdict: 'pass',
        next_action: 'ready', action: connected
          ? { kind: 'revoke', label: 'Disconnect', available: true, installation_name: 'catalog-ready', connector_id: installation.connector_id, status: 'ready' }
          : { kind: 'connect', label: 'Connect', available: true, installation_name: 'catalog-ready' } }],
    })
    fetchConnectorCatalogMock
      .mockResolvedValueOnce(catalog())
      .mockResolvedValueOnce(catalog(true))
      .mockResolvedValueOnce(catalog())
    fetchCustomConnectorsMock
      .mockResolvedValueOnce({ profile_name: 'current', subject_id: 'owner', connectors: [] })
      .mockResolvedValueOnce({ profile_name: 'current', subject_id: 'owner', connectors: [installation] })
      .mockResolvedValueOnce({ profile_name: 'current', subject_id: 'owner', connectors: [] })
    connectCatalogConnectorMock.mockResolvedValueOnce({
      profile_name: 'current', subject_id: 'owner', connectors: [installation],
    })
    const Panel = (await import('@/components/hermes/connectors/ConnectorCatalogPanel.vue')).default
    const wrapper = mount(Panel, { props: { profile: 'current' } })
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    await wrapper.find('.catalog-card').trigger('click')
    await wrapper.find('[data-testid="catalog-primary-action"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(connectCatalogConnectorMock).toHaveBeenCalledWith('ready')
    expect(wrapper.text()).toContain('mcp.connected')

    await wrapper.find('.catalog-card').trigger('click')
    await wrapper.find('[data-testid="catalog-primary-action"]').trigger('click')
    expect(deleteCustomConnectorMock).toHaveBeenCalledWith(installation.connector_id)
  })

  it('binds the exact credential fields requested by an owner-bound catalog card', async () => {
    const installation = {
      connector_id: 'custom-aaaaaaaaaaaaaaaaaaaaaaaa', name: 'catalog-manual', transport: 'streamable_http',
      endpoint: 'https://example.com/mcp', credential_fields: ['Authorization'], state: 'ready', updated_at: 1,
    }
    const catalog = {
      profile_name: 'current', subject_id: 'owner', view: 'source', source_count: 642, canonical_count: 330,
      connectors: [{
        row_key: 'manual', canonical_key: 'manual', name: 'Manual MCP', final_verdict: 'needs_auth',
        action: { kind: 'authorize', label: 'Authorize', available: true, fields: ['Authorization'] },
      }],
    }
    fetchConnectorCatalogMock.mockResolvedValue(catalog)
    fetchCustomConnectorsMock
      .mockResolvedValueOnce({ profile_name: 'current', subject_id: 'owner', connectors: [] })
      .mockResolvedValueOnce({ profile_name: 'current', subject_id: 'owner', connectors: [installation] })
    connectCatalogConnectorMock.mockResolvedValue({
      profile_name: 'current', subject_id: 'owner', connectors: [installation],
    })
    const Panel = (await import('@/components/hermes/connectors/ConnectorCatalogPanel.vue')).default
    const wrapper = mount(Panel, { props: { profile: 'current' } })
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    await wrapper.find('.catalog-card').trigger('click')
    await wrapper.find('[data-testid="catalog-credential-Authorization"] input').setValue('Bearer owner-secret')
    await wrapper.find('[data-testid="catalog-primary-action"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    expect(connectCatalogConnectorMock).toHaveBeenCalledWith('manual', { Authorization: 'Bearer owner-secret' })
    expect(wrapper.html()).not.toContain('owner-secret')
  })

  it('connects an admitted sandbox catalog card with its exact fields', async () => {
    fetchConnectorCatalogMock.mockResolvedValue({
      profile_name: 'current', subject_id: 'owner', view: 'source', source_count: 642, canonical_count: 330,
      connectors: [{
        row_key: 'sandbox', canonical_key: 'sandbox', name: 'Sandbox MCP', final_verdict: 'needs_sandbox',
        action: { kind: 'install_sandbox', label: 'Connect', available: true, fields: ['API_KEY'] },
      }],
    })
    fetchCustomConnectorsMock
      .mockResolvedValueOnce({ profile_name: 'current', subject_id: 'owner', connectors: [] })
      .mockResolvedValueOnce({ profile_name: 'current', subject_id: 'owner', connectors: [] })
    connectCatalogConnectorMock.mockResolvedValue({
      profile_name: 'current', subject_id: 'owner', connectors: [],
    })
    const Panel = (await import('@/components/hermes/connectors/ConnectorCatalogPanel.vue')).default
    const wrapper = mount(Panel, { props: { profile: 'current' } })
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    await wrapper.find('.catalog-card').trigger('click')
    await wrapper.find('[data-testid="catalog-credential-API_KEY"] input').setValue('owner-secret')
    await wrapper.find('[data-testid="catalog-primary-action"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    expect(connectCatalogConnectorMock).toHaveBeenCalledWith('sandbox', { API_KEY: 'owner-secret' })
    expect(wrapper.html()).not.toContain('owner-secret')
  })

  it('opens the standard MCP OAuth URL without claiming the card is connected', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window)
    fetchConnectorCatalogMock.mockResolvedValue({
      profile_name: 'current', subject_id: 'owner', view: 'source', source_count: 642, canonical_count: 330,
      connectors: [{
        row_key: 'oauth', canonical_key: 'oauth', name: 'OAuth MCP', final_verdict: 'needs_auth',
        action: { kind: 'authorize', label: 'Authorize', available: true, auth_flow: 'mcp_oauth', status: 'ready' },
      }],
    })
    fetchCustomConnectorsMock.mockResolvedValue({ profile_name: 'current', subject_id: 'owner', connectors: [] })
    connectCatalogConnectorMock.mockResolvedValue({
      profile_name: 'current', subject_id: 'owner',
      authorization_url: 'https://auth.example/authorize?state=opaque',
    })
    const Panel = (await import('@/components/hermes/connectors/ConnectorCatalogPanel.vue')).default
    const wrapper = mount(Panel, { props: { profile: 'current' } })
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    await wrapper.find('.catalog-card').trigger('click')
    await wrapper.find('[data-testid="catalog-primary-action"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    expect(open).toHaveBeenCalledWith('https://auth.example/authorize?state=opaque', '_blank', 'noopener,noreferrer')
    expect(fetchCustomConnectorsMock).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).not.toContain('mcp.connected')
    open.mockRestore()
  })

  it('routes the Feishu catalog card through the existing owner-bound lark-cli broker', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window)
    fetchConnectorCatalogMock.mockResolvedValue({
      profile_name: 'current', subject_id: 'owner', view: 'source', source_count: 642, canonical_count: 330,
      connectors: [{
        row_key: 'workbuddy:feishu', canonical_key: 'feishu', name: 'Feishu', final_verdict: 'needs_auth',
        action: { kind: 'authorize', label: 'Authorize', available: true, auth_flow: 'feishu_device_flow' },
      }],
    })
    fetchCustomConnectorsMock.mockResolvedValue({ profile_name: 'current', subject_id: 'owner', connectors: [] })
    startSkillCredentialAuthMock.mockResolvedValue({
      session_id: 'owner-session', verification_uri: 'https://accounts.feishu.cn/device', user_code: 'OWNER',
    })
    pollFeishuUatSessionMock.mockResolvedValue({ session_id: 'owner-session', status: 'success' })
    const Panel = (await import('@/components/hermes/connectors/ConnectorCatalogPanel.vue')).default
    const wrapper = mount(Panel, { props: { profile: 'current' } })
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    await wrapper.find('.catalog-card').trigger('click')
    vi.useFakeTimers()
    await wrapper.find('[data-testid="catalog-primary-action"]').trigger('click')
    await vi.advanceTimersByTimeAsync(2_500)

    expect(startSkillCredentialAuthMock).toHaveBeenCalledWith('lark-cli', 'current')
    expect(pollFeishuUatSessionMock).toHaveBeenCalledWith('owner-session', 'current')
    expect(connectCatalogConnectorMock).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith('https://accounts.feishu.cn/device', '_blank', 'noopener,noreferrer')
    open.mockRestore()
    vi.useRealTimers()
  })

  it('revokes a ready Feishu card through the exact owner-bound catalog route', async () => {
    const ready = {
      profile_name: 'current', subject_id: 'owner', view: 'source', source_count: 642, canonical_count: 330,
      connectors: [{
        row_key: 'workbuddy:feishu', canonical_key: 'feishu', name: 'Feishu', final_verdict: 'needs_auth',
        action: { kind: 'revoke', label: 'Disconnect', available: true, auth_flow: 'feishu_device_flow', status: 'ready' },
      }],
    }
    fetchConnectorCatalogMock.mockResolvedValue(ready)
    fetchCustomConnectorsMock.mockResolvedValue({ profile_name: 'current', subject_id: 'owner', connectors: [] })
    const Panel = (await import('@/components/hermes/connectors/ConnectorCatalogPanel.vue')).default
    const wrapper = mount(Panel, { props: { profile: 'current' } })
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('mcp.connected')
    await wrapper.find('.catalog-card').trigger('click')
    await wrapper.find('[data-testid="catalog-primary-action"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(connectCatalogConnectorMock).toHaveBeenCalledWith('workbuddy:feishu')
    expect(startSkillCredentialAuthMock).not.toHaveBeenCalled()
  })

  it('fails visibly without showing stale catalog rows when the broker is unavailable', async () => {
    fetchConnectorCatalogMock.mockRejectedValueOnce(new Error('catalog unavailable'))
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    expect(wrapper.findAll('.catalog-card')).toHaveLength(0)
    expect(wrapper.text()).toContain('catalog unavailable')
  })

  it('keeps the newest profile load when an older connector response arrives late', async () => {
    let resolveOldCatalog!: (value: any) => void
    let resolveOldCustom!: (value: any) => void
    fetchConnectorCatalogMock
      .mockImplementationOnce(() => new Promise(resolve => { resolveOldCatalog = resolve }))
      .mockResolvedValueOnce({
        profile_name: 'new', subject_id: 'new-owner', view: 'source', source_count: 642, canonical_count: 330,
        connectors: [{ row_key: 'new', canonical_key: 'new', name: 'Newest connector' }],
      })
    fetchCustomConnectorsMock
      .mockImplementationOnce(() => new Promise(resolve => { resolveOldCustom = resolve }))
      .mockResolvedValueOnce({ profile_name: 'new', subject_id: 'new-owner', connectors: [] })

    const Panel = (await import('@/components/hermes/connectors/ConnectorCatalogPanel.vue')).default
    const wrapper = mount(Panel, { props: { profile: 'old' } })
    await Promise.resolve()
    await wrapper.setProps({ profile: 'new' })
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Newest connector')

    resolveOldCatalog({
      profile_name: 'old', subject_id: 'old-owner', view: 'source', source_count: 642, canonical_count: 330,
      connectors: [{ row_key: 'old', canonical_key: 'old', name: 'Stale connector' }],
    })
    resolveOldCustom({ profile_name: 'old', subject_id: 'old-owner', connectors: [] })
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Newest connector')
    expect(wrapper.text()).not.toContain('Stale connector')
  })

  it('falls back from a failed icon and submits one import while pending', async () => {
    fetchConnectorCatalogMock.mockResolvedValueOnce({
      profile_name: 'current', subject_id: 'owner', view: 'source', source_count: 642, canonical_count: 330,
      connectors: [{ row_key: 'demo', canonical_key: 'demo', name: 'Demo', icon: { url: '/broken.png' } }],
    })
    importCustomConnectorsMock.mockImplementationOnce(() => new Promise(() => {}))
    const Panel = (await import('@/components/hermes/connectors/ConnectorCatalogPanel.vue')).default
    const wrapper = mount(Panel, { props: { profile: 'current' } })
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    await wrapper.find('.catalog-card img').trigger('error')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.catalog-fallback').text()).toBe('D')

    await wrapper.find('[data-testid="custom-connector-open"]').trigger('click')
    await wrapper.find('.mock-modal textarea').setValue('{"mcpServers":{"demo":{"url":"https://example.com/mcp"}}}')
    await wrapper.vm.$nextTick()
    const save = wrapper.findAll('.mock-modal button').at(-1)!
    await save.trigger('click')
    await save.trigger('click')
    expect(importCustomConnectorsMock).toHaveBeenCalledTimes(1)
  })

  it('connects the GitHub MCP bundle without persisting or rendering the PAT', async () => {
    const row = (status: string, hint?: string) => ({
      profile_name: 'feishu_g41a5b5g',
      credentials: [{
        id: 'github-mcp', title: 'GitHub', provider: 'github', installed: true,
        status, account_hint: hint,
        detail: 'Official remote MCP · companion Skill · read-only · personal credential',
        required_by: ['github-mcp'], action: { kind: 'manual', label: 'Connect' },
      }],
    })
    fetchSkillCredentialsMock
      .mockResolvedValueOnce(row('needs_auth'))
      .mockResolvedValueOnce(row('authenticated', 'octo…ice'))
    submitGithubTokenMock.mockResolvedValueOnce({ ok: true, account_hint: 'octo…ice' })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Official remote MCP · companion Skill · read-only')
    await wrapper.find('[data-credential-action="github-mcp"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Read-only MCP with companion Skill.')
    const createLink = wrapper.find('[data-testid="github-pat-create-link"]')
    expect(createLink.attributes('href')).toBe('https://github.com/settings/personal-access-tokens/new?name=Hermes%20MCP&description=Read-only%20GitHub%20MCP%20connector&expires_in=30&contents=read&issues=read&pull_requests=read&metadata=read')
    expect(createLink.attributes('target')).toBe('_blank')
    expect(createLink.attributes('rel')).toBe('noopener noreferrer')
    expect(wrapper.text()).toContain('Only select repositories the Agent may query.')
    expect(wrapper.text()).toContain('Use read-only Contents, Issues and Pull requests permissions.')
    expect(wrapper.text()).toContain('Generate the token, copy it once, then return here to paste it.')
    const input = wrapper.find('input[type="password"]')
    const sampleValue = ['sample', 'value'].join('-')
    await input.setValue(`  ${sampleValue}  `)
    await wrapper.find('[data-testid="github-submit"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    expect(submitGithubTokenMock).toHaveBeenCalledWith(sampleValue, 'feishu_g41a5b5g')
    expect(fetchSkillCredentialsMock).toHaveBeenLastCalledWith('feishu_g41a5b5g', { fresh: true })
    expect(wrapper.html()).not.toContain(sampleValue)
    expect(JSON.stringify(localStorage)).not.toContain(sampleValue)
    expect(wrapper.text()).toContain('octo…ice')
  })

  it('keeps the GitHub dialog open when the broker rejects the token', async () => {
    fetchSkillCredentialsMock.mockResolvedValueOnce({
      profile_name: 'feishu_g41a5b5g',
      credentials: [{
        id: 'github-mcp', title: 'GitHub', provider: 'github', installed: true,
        status: 'needs_auth', action: { kind: 'manual', label: 'Connect' },
      }],
    })
    submitGithubTokenMock.mockResolvedValueOnce({ ok: false, error: 'GitHub token is invalid' })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    await wrapper.find('[data-credential-action="github-mcp"]').trigger('click')
    const submit = wrapper.find('[data-testid="github-submit"]')
    expect(submit.attributes('disabled')).toBeDefined()
    await wrapper.find('input[type="password"]').setValue('bad-token')
    await submit.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    expect(wrapper.find('.mock-modal').exists()).toBe(true)
    expect(wrapper.text()).toContain('GitHub token is invalid')
    expect(wrapper.text()).not.toContain('已认证')
  })

  it('revokes the authenticated GitHub MCP credential for the active profile', async () => {
    const credential = (status: string, label: string) => ({
      profile_name: 'feishu_g41a5b5g',
      credentials: [{
        id: 'github-mcp', title: 'GitHub', provider: 'github', installed: true,
        status, detail: 'read-only',
        account_hint: label,
        action: { kind: 'manual', label: 'Reconnect' },
      }],
    })
    fetchSkillCredentialsMock
      .mockResolvedValueOnce(credential('authenticated', 'octo…ice'))
      .mockResolvedValueOnce(credential('needs_auth', ''))
    revokeGithubTokenMock.mockResolvedValueOnce({ ok: true, revoked: true })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    await wrapper.find('[data-credential-revoke="github-mcp"]').trigger('click')
    await wrapper.find('[data-testid="github-revoke-confirm"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(revokeGithubTokenMock).toHaveBeenCalledWith('feishu_g41a5b5g')
    expect(messageSuccessMock).toHaveBeenCalledWith('GitHub revoked')
    expect(wrapper.text()).toContain('未认证')
    expect(wrapper.text()).not.toContain('octo…ice')
  })

  it('does not claim revoke success when the broker rejects it', async () => {
    fetchSkillCredentialsMock.mockResolvedValue({
      profile_name: 'feishu_g41a5b5g',
      credentials: [{
        id: 'github-mcp', title: 'GitHub', provider: 'github', installed: true,
        status: 'authenticated', action: { kind: 'manual', label: 'Reconnect' },
      }],
    })
    revokeGithubTokenMock.mockResolvedValueOnce({ ok: false, error: 'vault unavailable' })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    await wrapper.find('[data-credential-revoke="github-mcp"]').trigger('click')
    await wrapper.find('[data-testid="github-revoke-confirm"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    expect(messageSuccessMock).not.toHaveBeenCalled()
    expect(messageErrorMock).toHaveBeenCalledWith('vault unavailable')
    expect(wrapper.find('[data-testid="github-revoke-confirm"]').exists()).toBe(true)
  })

  // --- Figma 卡：授权走通用 oauth_url，撤销是这张卡自己的第二颗按钮 -----------

  const figmaRow = (status: string, hint?: string) => ({
    profile_name: 'feishu_g41a5b5g',
    credentials: [{
      id: 'figma', title: 'Figma', provider: 'figma', installed: true,
      status,
      account_hint: hint,
      detail: 'Figma 官方远端 MCP · 用你自己的 Figma 账号授权',
      action: { kind: 'oauth_url', label: status === 'authenticated' ? '重新授权' : '授权' },
    }],
  })

  it('opens the Figma authorization URL returned by the broker-backed start', async () => {
    const authWindow = { opener: {}, location: { href: '' } } as any
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(authWindow)
    fetchSkillCredentialsMock.mockResolvedValue(figmaRow('needs_auth'))
    startSkillCredentialAuthMock.mockResolvedValueOnce({
      id: 'figma',
      verification_uri: 'https://www.figma.com/oauth/mcp?state=abc',
    })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    // 未认证态不渲染撤销按钮 —— 没东西可撤。
    expect(wrapper.find('[data-credential-revoke="figma"]').exists()).toBe(false)
    await wrapper.find('[data-credential-action="figma"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(startSkillCredentialAuthMock).toHaveBeenCalledWith('figma', 'feishu_g41a5b5g')
    expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank')
    expect(authWindow.location.href).toBe('https://www.figma.com/oauth/mcp?state=abc')
  })

  it('revokes the authenticated Figma authorization for the active profile', async () => {
    fetchSkillCredentialsMock
      .mockResolvedValueOnce(figmaRow('authenticated', 'alice@example.com'))
      .mockResolvedValueOnce(figmaRow('needs_auth'))
    revokeFigmaCredentialMock.mockResolvedValueOnce({ ok: true, revoked: true })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('alice@example.com')
    await wrapper.find('[data-credential-revoke="figma"]').trigger('click')
    await wrapper.find('[data-testid="figma-revoke-confirm"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    expect(revokeFigmaCredentialMock).toHaveBeenCalledWith('feishu_g41a5b5g')
    expect(fetchSkillCredentialsMock).toHaveBeenLastCalledWith('feishu_g41a5b5g', { fresh: true })
    expect(messageSuccessMock).toHaveBeenCalledWith('Figma revoked')
    expect(wrapper.find('[data-testid="figma-revoke-confirm"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('未认证')
    expect(wrapper.text()).not.toContain('alice@example.com')
  })

  // 幂等撤销：broker 说"本来就没绑"(revoked:false) 仍然是 ok —— 弹窗照样要关，
  // 否则员工会以为没撤成功而反复点。
  it('closes the Figma dialog on an idempotent revoke (ok without revoked)', async () => {
    fetchSkillCredentialsMock
      .mockResolvedValueOnce(figmaRow('authenticated', 'alice@example.com'))
      .mockResolvedValueOnce(figmaRow('needs_auth'))
    revokeFigmaCredentialMock.mockResolvedValueOnce({ ok: true, revoked: false })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    await wrapper.find('[data-credential-revoke="figma"]').trigger('click')
    await wrapper.find('[data-testid="figma-revoke-confirm"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    expect(messageSuccessMock).toHaveBeenCalledWith('Figma revoked')
    expect(messageErrorMock).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="figma-revoke-confirm"]').exists()).toBe(false)
  })

  // 请求本身失败（路由不存在 / 面不对 / 网络断）时必须有话说：弹窗留着，但员工看得到
  // 是什么挡住了。真机走查里"弹窗不动又没提示"就是这条分支没被证据覆盖。
  it('keeps the Figma dialog open and surfaces the reason when the revoke request fails', async () => {
    fetchSkillCredentialsMock.mockResolvedValue(figmaRow('authenticated', 'alice@example.com'))
    revokeFigmaCredentialMock.mockRejectedValueOnce(
      Object.assign(new Error('API Error 404: not found'), { status: 404 }),
    )
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    await wrapper.find('[data-credential-revoke="figma"]').trigger('click')
    await wrapper.find('[data-testid="figma-revoke-confirm"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    expect(messageSuccessMock).not.toHaveBeenCalled()
    expect(messageErrorMock).toHaveBeenCalledWith('API Error 404: not found')
    expect(wrapper.find('[data-testid="figma-revoke-confirm"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('已认证')
  })

  it('does not claim a Figma revoke succeeded when the server rejects it', async () => {
    fetchSkillCredentialsMock.mockResolvedValue(figmaRow('authenticated', 'alice@example.com'))
    revokeFigmaCredentialMock.mockResolvedValueOnce({ ok: false, error: 'Figma 授权服务暂不可用，请稍后重试。' })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    await wrapper.find('[data-credential-revoke="figma"]').trigger('click')
    await wrapper.find('[data-testid="figma-revoke-confirm"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    expect(messageSuccessMock).not.toHaveBeenCalled()
    expect(messageErrorMock).toHaveBeenCalledWith('Figma 授权服务暂不可用，请稍后重试。')
    // 弹窗留在原地，卡片仍是已认证 —— 没撤成就别装作撤了。
    expect(wrapper.find('[data-testid="figma-revoke-confirm"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('已认证')
  })

  // 撤销只在 chat 面有服务端（控制器的 isChatPlaneRequest 闸）。别的面上这颗按钮点下去
  // 只会拿到 404，所以那里根本不渲染它 —— 按钮和端点必须同进同退。
  const authStatusReturning = (status: Record<string, unknown>) =>
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({ ok: true, json: async () => status } as any)

  it('hides the Figma revoke button on a plane where the revoke endpoint does not exist', async () => {
    const fetchSpy = authStatusReturning({ plane: 'both', gitlabBaseUrl: '' })
    fetchSkillCredentialsMock.mockResolvedValue(figmaRow('authenticated', 'alice@example.com'))
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-credential-revoke="figma"]').exists()).toBe(false)
    // 卡片本身照常：授权按钮还在，藏的只是撤销。
    expect(wrapper.find('[data-credential-action="figma"]').exists()).toBe(true)
    fetchSpy.mockRestore()
  })

  it('shows the Figma revoke button on the chat plane', async () => {
    const fetchSpy = authStatusReturning({ plane: 'chat', gitlabBaseUrl: '' })
    fetchSkillCredentialsMock.mockResolvedValue(figmaRow('authenticated', 'alice@example.com'))
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-credential-revoke="figma"]').exists()).toBe(true)
    fetchSpy.mockRestore()
  })

  it('keeps the Figma revoke button when the plane cannot be read', async () => {
    // /api/auth/status 抖一下不该把生产上唯一的撤销入口藏掉：问不到就照常渲染。
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockRejectedValue(new Error('offline'))
    fetchSkillCredentialsMock.mockResolvedValue(figmaRow('authenticated', 'alice@example.com'))
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0)); await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-credential-revoke="figma"]').exists()).toBe(true)
    fetchSpy.mockRestore()
  })

  it('keeps legacy kep-cli credential rows grouped with internal systems', async () => {
    fetchSkillCredentialsMock.mockResolvedValueOnce({
      profile_name: 'feishu_g41a5b5g',
      credentials: [
        {
          id: 'kep-cli',
          title: 'kep-cli',
          provider: 'keep',
          installed: true,
          status: 'needs_auth',
          detail: 'legacy row',
          action: { kind: 'oauth_url', label: '认证', env: 'online' },
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
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-credential-group="internal-systems"]').text()).toContain('kep-cli')
    expect(wrapper.find('[data-credential-group="other-credentials"]').text()).not.toContain('kep-cli')
    expect(wrapper.find('[data-credential-group="other-credentials"]').text()).toContain('GitLab')
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
    // switch (the reactive route mock can't fire the watcher post-mount, so we drive the
    // overlap via the refresh button — equivalent mechanism).
    localStorage.clear()
    routeQuery.profile = 'feishu_g41a5b5g'
    const row = (status: string, label: string) => [
      { id: 'kep-cli', title: 'kep-cli', provider: 'keep', installed: true, status, detail: label, action: { kind: 'oauth_url', label: 'x' } },
    ]
    fetchSkillCredentialsMock.mockResolvedValueOnce({ profile_name: 'feishu_g41a5b5g', credentials: row('authenticated', 'INIT') })
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(r => setTimeout(r, 0)); await wrapper.vm.$nextTick()

    // refresh #1 hangs (the stale one); refresh #2 resolves (the current one)
    let resolveStale: () => void = () => {}
    fetchSkillCredentialsMock.mockImplementationOnce(() => new Promise(r => { resolveStale = () => r({ profile_name: 'feishu_g41a5b5g', credentials: row('missing', 'STALE-B') }) }))
    fetchSkillCredentialsMock.mockResolvedValueOnce({ profile_name: 'feishu_g41a5b5g', credentials: row('needs_auth', 'CURRENT-A') })
    const btn = wrapper.find('.page-header button')
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
    // error.value while a newer load (data still null, in-flight) is pending.
    localStorage.clear()
    routeQuery.profile = 'feishu_g41a5b5g'
    const row = (status: string, label: string) => [
      { id: 'kep-cli', title: 'kep-cli', provider: 'keep', installed: true, status, detail: label, action: { kind: 'oauth_url', label: 'x' } },
    ]
    // initial (mount) load #1 hangs, then REJECTS — data stays null
    let rejectInit: () => void = () => {}
    fetchSkillCredentialsMock.mockImplementationOnce(() => new Promise((_res, rej) => { rejectInit = () => rej(new Error('STALE-ERROR')) }))
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await wrapper.vm.$nextTick()  // load #1 in flight, data null
    // load #2 (button) starts, hangs, then resolves CURRENT
    let resolveNew: () => void = () => {}
    fetchSkillCredentialsMock.mockImplementationOnce(() => new Promise(res => { resolveNew = () => res({ profile_name: 'feishu_g41a5b5g', credentials: row('needs_auth', 'CURRENT-A') }) }))
    await wrapper.find('.page-header button').trigger('click')  // load #2 in flight, loadSeq bumped
    rejectInit()  // stale load #1 fails while data is still null and #2 is pending
    await new Promise(r => setTimeout(r, 0)); await wrapper.vm.$nextTick()
    resolveNew()  // current load resolves
    await new Promise(r => setTimeout(r, 0)); await wrapper.vm.$nextTick()

    expect(wrapper.find('.credentials-error').exists()).toBe(false)  // stale error suppressed
    expect(wrapper.text()).toContain('CURRENT-A')
    localStorage.clear()
  })

  it('manual refresh button requests FRESH status (bypasses the broker cache)', async () => {
    localStorage.clear()
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()
    // Initial mount load is cached (single-arg); the manual refresh must be fresh.
    expect(fetchSkillCredentialsMock).toHaveBeenLastCalledWith('feishu_g41a5b5g')
    fetchSkillCredentialsMock.mockClear()

    await wrapper.find('.page-header button').trigger('click')
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

  it('shows the login fallback warning without starting Device Flow automatically', async () => {
    routeQuery.lark_auth = 'required'
    const CredentialsView = (await import('@/views/hermes/CredentialsView.vue')).default
    const wrapper = mount(CredentialsView)
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="lark-auth-required"]').text()).toContain('Lark-cli authorization was not saved')
    expect(startSkillCredentialAuthMock).not.toHaveBeenCalled()
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

      expect(messageErrorMock).toHaveBeenCalledWith('授权会话已过期')
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

      expect(messageErrorMock).toHaveBeenCalledWith('授权会话不存在')
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
    expect(personal.text()).toContain('绑定我的 GitLab')
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

    expect(messageSuccessMock).not.toHaveBeenCalled()
    expect(messageErrorMock).not.toHaveBeenCalled()  // warning 通道，不是被 catch 吞掉的报错
    expect(messageWarningMock).toHaveBeenCalledTimes(1)
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
    expect(labelless.text()).toBe('连接')
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
    // 落点说明来自 broker 回执，原样提示给绑定人。
    expect(messageSuccessMock).toHaveBeenCalledWith('已绑定到本群：本群所有会话都会使用此 token。')
    // 成功后的刷新必须 fresh —— 否则短 TTL 缓存把绑定前的状态刷回来，绑定看起来失败。
    const lastFetch = fetchSkillCredentialsMock.mock.calls.at(-1)
    expect(lastFetch?.[1]).toEqual({ fresh: true })
  })
})
