// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'

const mocks = vi.hoisted(() => ({
  fetchMemory: vi.fn(),
  fetchSkills: vi.fn(),
  saveMemory: vi.fn(),
  listFiles: vi.fn(),
  fetchAgentShares: vi.fn(),
  revokeAgentShare: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))

const profilesState = vi.hoisted(() => ({ profiles: [] as any[] }))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: {} }),
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('naive-ui', () => ({
  NSpin: { props: ['show'], template: '<div><slot /></div>' },
  useMessage: () => ({ success: mocks.success, error: mocks.error }),
  useDialog: () => ({ warning: mocks.warning }),
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchMemory: mocks.fetchMemory,
  fetchSkills: mocks.fetchSkills,
  saveMemory: mocks.saveMemory,
}))

vi.mock('@/api/hermes/files', () => ({
  listFiles: mocks.listFiles,
  readFile: vi.fn(),
  getFileDownloadUrl: vi.fn(() => ''),
}))

// Not just unused plumbing: importing the real module pulls api/client → the
// router, which cannot be constructed under the vue-router mock above.
vi.mock('@/api/hermes/download', () => ({ downloadFile: vi.fn() }))

vi.mock('@/components/hermes/agents/AgentArtifactPreview.vue', () => ({
  default: { template: '<div class="artifact-preview-stub" />' },
}))

vi.mock('@/api/hermes/agents', () => ({
  fetchAgentShares: mocks.fetchAgentShares,
  revokeAgentShare: mocks.revokeAgentShare,
}))

vi.mock('@/utils/hermes/share-identity', () => ({
  safeShareAvatarUrl: (url?: string) => url || '',
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesState,
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => ({ agentSwitching: false }),
}))

vi.mock('@/components/hermes/profiles/ProfileAvatar.vue', () => ({
  default: { template: '<div class="avatar-stub" />' },
}))

const AgentDetailView = (await import('@/views/hermes/AgentDetailView.vue')).default

function flush() {
  return Promise.resolve().then(() => Promise.resolve())
}

async function mountDetail(profile: Record<string, unknown>) {
  profilesState.profiles = [reactive({ name: 'sales', active: false, model: '', alias: '', ...profile })]
  const wrapper = mount(AgentDetailView, { props: { agentName: 'sales', embedded: true } })
  await flush()
  await wrapper.vm.$nextTick()
  return wrapper
}

describe('AgentDetailView — access and persona editing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchMemory.mockResolvedValue({ soul: 'I am sales.', user: '', memory: '' })
    mocks.fetchSkills.mockResolvedValue({ categories: [], archived: [] })
    mocks.listFiles.mockResolvedValue({ entries: [], path: '' })
    mocks.fetchAgentShares.mockResolvedValue([])
    mocks.saveMemory.mockResolvedValue(undefined)
  })

  it('only fetches shares when the access tab is opened', async () => {
    mocks.fetchAgentShares.mockResolvedValue([
      { agent_id: 'a1', grantee_open_id: 'ou_1', role: 'viewer', status: 'active', principal: { provider: 'feishu', display_name: 'Wang Fang' } },
    ])
    const wrapper = await mountDetail({ agentId: 'a1' })

    expect(mocks.fetchAgentShares).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="agent-tab-safe"]').trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(mocks.fetchAgentShares).toHaveBeenCalledWith('a1')
    expect(wrapper.text()).toContain('Wang Fang')
  })

  it('says an unregistered agent has nothing to share instead of showing an empty list', async () => {
    const wrapper = await mountDetail({})

    await wrapper.get('[data-testid="agent-tab-safe"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(mocks.fetchAgentShares).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('agentDetail.safe.unavailable')
  })

  it('never reaches sharing on an agent shared with you — the panel is identity only', async () => {
    const wrapper = await mountDetail({ agentId: 'a1', shareRole: 'viewer' })

    await wrapper.get('[data-testid="agent-tab-safe"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(mocks.fetchAgentShares).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('agentDetail.sharedNotice')
  })

  it('writes the edited persona file back to the agent it belongs to', async () => {
    const wrapper = await mountDetail({ agentId: 'a1' })

    await wrapper.get('[data-testid="agent-persona-edit"]').trigger('click')
    const editor = wrapper.get('[data-testid="agent-persona-editor"]')
    expect((editor.element as HTMLTextAreaElement).value).toBe('I am sales.')

    await editor.setValue('I am sales, and I lead with the number.')
    await wrapper.get('[data-testid="agent-persona-save"]').trigger('click')
    await flush()

    expect(mocks.saveMemory).toHaveBeenCalledWith('soul', 'I am sales, and I lead with the number.', 'sales')
    // Back to the read view, showing what was just saved.
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="agent-persona-editor"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('I am sales, and I lead with the number.')
  })

  it('drops the draft when you switch to another persona file', async () => {
    const wrapper = await mountDetail({ agentId: 'a1' })

    await wrapper.get('[data-testid="agent-persona-edit"]').trigger('click')
    await wrapper.get('[data-testid="agent-persona-editor"]').setValue('half-written')
    await wrapper.findAll('.agent-chip')[1].trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="agent-persona-editor"]').exists()).toBe(false)
    expect(mocks.saveMemory).not.toHaveBeenCalled()
  })
})
