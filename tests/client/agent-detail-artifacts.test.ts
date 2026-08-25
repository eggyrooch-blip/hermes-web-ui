// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'

// The 产物 tab reads ANOTHER agent's workspace while a different profile may be
// active, so every artifact call has to carry that agent's profile selector —
// list, read (preview) and download alike. A download that forgets it fetches
// the active profile's file of the same name, which is the bug these lock.
const mocks = vi.hoisted(() => ({
  fetchMemory: vi.fn(),
  fetchSkills: vi.fn(),
  saveMemory: vi.fn(),
  listFiles: vi.fn(),
  readFile: vi.fn(),
  downloadFile: vi.fn(),
  fetchAgentShares: vi.fn(),
  revokeAgentShare: vi.fn(),
  error: vi.fn(),
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
  useMessage: () => ({ success: vi.fn(), error: mocks.error }),
  useDialog: () => ({ warning: vi.fn() }),
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchMemory: mocks.fetchMemory,
  fetchSkills: mocks.fetchSkills,
  saveMemory: mocks.saveMemory,
}))

vi.mock('@/api/hermes/files', () => ({
  listFiles: mocks.listFiles,
  readFile: mocks.readFile,
  getFileDownloadUrl: vi.fn(() => '/download/stub'),
}))

vi.mock('@/api/hermes/download', () => ({ downloadFile: mocks.downloadFile }))

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

// The reader has its own test; here it only has to prove it was handed the
// right artifact.
vi.mock('@/components/hermes/agents/AgentArtifactPreview.vue', () => ({
  default: {
    props: ['entry', 'kind', 'content', 'profile', 'loading', 'error', 'downloading'],
    emits: ['close', 'download'],
    template: '<div class="preview-stub" :data-kind="kind" :data-profile="profile">{{ entry.name }}</div>',
  },
}))

const AgentDetailView = (await import('@/views/hermes/AgentDetailView.vue')).default

const HTML_ENTRY = {
  name: 'hermes_intro.html',
  path: 'hermes_intro.html',
  isDir: false,
  size: 2048,
  modTime: '2026-08-18T06:52:47.000Z',
}
const BINARY_ENTRY = {
  name: 'Q3.docx',
  path: 'reports/Q3.docx',
  isDir: false,
  size: 51200,
  modTime: '2026-08-17T02:00:00.000Z',
}

function flush() {
  return Promise.resolve().then(() => Promise.resolve())
}

async function mountArtifactsTab() {
  profilesState.profiles = [reactive({ name: 'test1', active: false, model: '', alias: '' })]
  const wrapper = mount(AgentDetailView, { props: { agentName: 'test1', embedded: true } })
  await flush()
  await wrapper.vm.$nextTick()
  await wrapper.find('[data-testid="agent-tab-artifacts"]').trigger('click')
  await wrapper.vm.$nextTick()
  return wrapper
}

describe('AgentDetailView — 产物 preview and download', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchMemory.mockResolvedValue({ soul: '', user: '', memory: '' })
    mocks.fetchSkills.mockResolvedValue({ categories: [] })
    mocks.fetchAgentShares.mockResolvedValue([])
    mocks.listFiles.mockResolvedValue({ entries: [HTML_ENTRY, BINARY_ENTRY], path: '' })
    mocks.readFile.mockResolvedValue({ content: '<h1>hi</h1>', path: HTML_ENTRY.path, size: HTML_ENTRY.size })
  })

  it('lists artifacts as catalog rows, each with its own download affordance', async () => {
    const wrapper = await mountArtifactsTab()

    const rows = wrapper.findAll('[data-testid="agent-artifact-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('hermes_intro.html')
    // Extension + size are real data (the prototype's row meta is mock text).
    expect(rows[0].text()).toContain('HTML')
    expect(rows[0].text()).toContain('2.0 KB')
    expect(wrapper.findAll('[data-testid="agent-artifact-row-download"]')).toHaveLength(2)
  })

  it('orders artifacts newest first, whatever order the directory listing came in', async () => {
    mocks.listFiles.mockResolvedValue({ entries: [BINARY_ENTRY, HTML_ENTRY], path: '' })
    const wrapper = await mountArtifactsTab()

    const rows = wrapper.findAll('[data-testid="agent-artifact-row"]')
    expect(rows[0].text()).toContain('hermes_intro.html')
    expect(rows[1].text()).toContain('Q3.docx')
  })

  it('opens a text-shaped artifact by reading it under the agent profile', async () => {
    const wrapper = await mountArtifactsTab()

    await wrapper.findAll('[data-testid="agent-artifact-row"]')[0].trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(mocks.readFile).toHaveBeenCalledWith('hermes_intro.html', 'test1')
    const preview = wrapper.find('.preview-stub')
    expect(preview.exists()).toBe(true)
    expect(preview.attributes('data-kind')).toBe('html')
    expect(preview.attributes('data-profile')).toBe('test1')
    // The reader replaces the list rather than stacking under it.
    expect(wrapper.find('[data-testid="agent-artifact-row"]').exists()).toBe(false)
  })

  it('does not try to read a binary artifact, and offers it for download instead', async () => {
    const wrapper = await mountArtifactsTab()

    await wrapper.findAll('[data-testid="agent-artifact-row"]')[1].trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(wrapper.find('.preview-stub').attributes('data-kind')).toBe('binary')
  })

  it('downloads from the row with the agent profile, without opening the preview', async () => {
    const wrapper = await mountArtifactsTab()

    await wrapper.findAll('[data-testid="agent-artifact-row-download"]')[1].trigger('click')
    await flush()

    expect(mocks.downloadFile).toHaveBeenCalledWith('reports/Q3.docx', 'Q3.docx', 'test1')
    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(wrapper.find('.preview-stub').exists()).toBe(false)
  })

  it('closing the reader brings the list back', async () => {
    const wrapper = await mountArtifactsTab()
    await wrapper.findAll('[data-testid="agent-artifact-row"]')[0].trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    wrapper.findComponent<any>('.preview-stub').vm.$emit('close')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.preview-stub').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="agent-artifact-row"]')).toHaveLength(2)
  })

  it('surfaces a failed download instead of failing silently', async () => {
    mocks.downloadFile.mockRejectedValueOnce(new Error('下载被拦截'))
    const wrapper = await mountArtifactsTab()

    await wrapper.findAll('[data-testid="agent-artifact-row-download"]')[0].trigger('click')
    await flush()

    // Same intent — a failed download must not be silent — now reported on the
    // page rather than in a toast that expires. A successful download is left
    // unannounced because the browser announces it.
    expect(wrapper.find('[data-testid="agent-detail-error"]').text()).toContain('下载被拦截')
  })
})
