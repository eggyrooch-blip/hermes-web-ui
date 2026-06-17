// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import SkillDetail from '../../packages/client/src/components/hermes/skills/SkillDetail.vue'

const mockFetchSkillContent = vi.hoisted(() => vi.fn())
const mockFetchSkillFiles = vi.hoisted(() => vi.fn())
const mockUpdateSkillContent = vi.hoisted(() => vi.fn())
const mockPinSkillApi = vi.hoisted(() => vi.fn())
const mockMessageSuccess = vi.hoisted(() => vi.fn())
const mockMessageError = vi.hoisted(() => vi.fn())

vi.mock('../../packages/client/src/api/hermes/skills', () => ({
  fetchSkillContent: mockFetchSkillContent,
  fetchSkillFiles: mockFetchSkillFiles,
  updateSkillContent: mockUpdateSkillContent,
  pinSkillApi: mockPinSkillApi,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => ({
    success: mockMessageSuccess,
    error: mockMessageError,
  }),
}))

vi.mock('../../packages/client/src/components/hermes/chat/MarkdownRenderer.vue', () => ({
  default: {
    name: 'MarkdownRenderer',
    props: ['content'],
    template: '<article class="markdown-body">{{ content }}</article>',
  },
}))

describe('SkillDetail editing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchSkillContent.mockResolvedValue('# Daily Writing\nold instructions\n')
    mockFetchSkillFiles.mockResolvedValue([])
    mockUpdateSkillContent.mockResolvedValue('# Daily Writing\nnew instructions\n')
  })

  it('lets employees edit and save an editable profile-local skill', async () => {
    const wrapper = mount(SkillDetail, {
      props: {
        category: 'misc',
        skill: 'daily-writing',
        skillName: 'daily-writing',
        editable: true,
      },
    })

    await flushPromises()

    await wrapper.get('.skill-edit-toggle').trigger('click')
    const editor = wrapper.get('textarea.skill-editor-textarea')
    await editor.setValue('# Daily Writing\nnew instructions\n')
    await wrapper.get('.skill-save').trigger('click')
    await flushPromises()

    expect(mockUpdateSkillContent).toHaveBeenCalledWith(
      'misc',
      'daily-writing',
      'SKILL.md',
      '# Daily Writing\nnew instructions\n',
    )
    expect(wrapper.find('.markdown-body').text()).toContain('new instructions')
    expect(wrapper.find('textarea.skill-editor-textarea').exists()).toBe(false)
  })

  it('normalizes absolute attached-file paths before saving edits', async () => {
    mockFetchSkillContent.mockImplementation(async (path: string) => {
      return path.endsWith('/references/note.md')
        ? 'old note\n'
        : '# Daily Writing\nold instructions\n'
    })
    mockFetchSkillFiles.mockResolvedValue([
      {
        path: '/Users/kite/.hermes/skills/misc/daily-writing/references/note.md',
        name: 'note.md',
        isDir: false,
      },
    ])
    mockUpdateSkillContent.mockResolvedValue('new note\n')

    const wrapper = mount(SkillDetail, {
      props: {
        category: 'misc',
        skill: 'daily-writing',
        skillName: 'daily-writing',
        editable: true,
      },
    })

    await flushPromises()

    await wrapper.get('.file-item').trigger('click')
    await flushPromises()
    await wrapper.get('.skill-edit-toggle').trigger('click')
    await wrapper.get('textarea.skill-editor-textarea').setValue('new note\n')
    await wrapper.get('.skill-save').trigger('click')
    await flushPromises()

    expect(mockUpdateSkillContent).toHaveBeenCalledWith(
      'misc',
      'daily-writing',
      'references/note.md',
      'new note\n',
    )
    expect(wrapper.find('.breadcrumb-path').text()).toBe('references/note.md')
  })

  it('does not expose editing for read-only skills', async () => {
    const wrapper = mount(SkillDetail, {
      props: {
        category: 'tools',
        skill: 'external-skill',
        skillName: 'external-skill',
        editable: false,
      },
    })

    await flushPromises()

    expect(wrapper.find('.skill-edit-toggle').exists()).toBe(false)
  })
})
