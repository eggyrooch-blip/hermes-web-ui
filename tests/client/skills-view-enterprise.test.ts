// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const mockIsStoredSuperAdmin = vi.hoisted(() => vi.fn())
const mockFetchSkills = vi.hoisted(() => vi.fn())
const mockFetchPendingWrites = vi.hoisted(() => vi.fn())
const mockProfilesStore = vi.hoisted(() => ({
  activeProfileName: 'feishu_g41a5b5g',
  profiles: [{ name: 'feishu_g41a5b5g' }],
  fetchProfiles: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  isStoredSuperAdmin: mockIsStoredSuperAdmin,
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: mockFetchSkills,
}))

vi.mock('@/api/hermes/write-gate', () => ({
  fetchPendingWrites: mockFetchPendingWrites,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => mockProfilesStore,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    locale: { value: 'en' },
    t: (key: string, params?: Record<string, unknown>) =>
      key === 'skills.writeApprovalButton' ? `Pending ${params?.count ?? 0}` : key,
  }),
}))

vi.mock('naive-ui', () => ({
  NBadge: { template: '<span><slot /></span>' },
  NButton: { template: '<button><slot name="icon" /><slot /></button>' },
  NDrawer: { props: ['show'], template: '<div v-if="show"><slot /></div>' },
  NDrawerContent: { template: '<section><slot /></section>' },
  NInput: { inheritAttrs: false, template: '<div class="n-input" />' },
}))

vi.mock('@/components/hermes/skills/SkillList.vue', () => ({
  default: { name: 'SkillList', template: '<div class="skill-list">SkillList</div>' },
}))
vi.mock('@/components/hermes/skills/SkillDetail.vue', () => ({
  default: { name: 'SkillDetail', template: '<div>SkillDetail</div>' },
}))
vi.mock('@/components/hermes/skills/SkillImportModal.vue', () => ({
  default: { name: 'SkillImportModal', template: '<div>SkillImportModal</div>' },
}))
vi.mock('@/components/hermes/skills/SkillExternalDirsModal.vue', () => ({
  default: { name: 'SkillExternalDirsModal', template: '<div>SkillExternalDirsModal</div>' },
}))
vi.mock('@/components/hermes/skills/PendingWriteApprovals.vue', () => ({
  default: { name: 'PendingWriteApprovals', template: '<div>PendingWriteApprovals</div>' },
}))
vi.mock('@/components/hermes/chat/MarkdownRenderer.vue', () => ({
  default: { name: 'MarkdownRenderer', props: ['content'], template: '<article>{{ content }}</article>' },
}))

import SkillsView from '@/views/hermes/SkillsView.vue'

describe('SkillsView enterprise surface gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsStoredSuperAdmin.mockReturnValue(false)
    mockFetchSkills.mockResolvedValue({ categories: [], archived: [] })
    mockFetchPendingWrites.mockResolvedValue({ records: [], counts: { memory: 0, skills: 0 }, supported: true })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue('') }))
  })

  it('hides host-level skill import controls from non-super-admin users', async () => {
    const wrapper = mount(SkillsView)
    await flushPromises()

    expect(wrapper.text()).toContain('Pending 0')
    expect(wrapper.text()).not.toContain('skills.import')
    expect(wrapper.text()).not.toContain('skills.externalDirs.manage')
    expect(mockFetchPendingWrites).toHaveBeenCalledOnce()
  })

  it('does not load external skill recommendation links for non-super-admin users', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue('[External skill](https://github.com/example/skill)'),
    })
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mount(SkillsView)
    await flushPromises()

    expect(fetchMock).not.toHaveBeenCalledWith('/skill-recommendations.en.md')
    expect(wrapper.text()).not.toContain('github.com/example/skill')
  })

  it('keeps host-level skill controls visible for super-admin users', async () => {
    mockIsStoredSuperAdmin.mockReturnValue(true)

    const wrapper = mount(SkillsView)
    await flushPromises()

    expect(wrapper.text()).toContain('skills.import')
    expect(wrapper.text()).toContain('skills.externalDirs.manage')
  })
})
