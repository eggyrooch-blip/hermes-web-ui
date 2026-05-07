// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const isUserModeMock = vi.hoisted(() => vi.fn(() => false))
const skillsApiMock = vi.hoisted(() => ({
  fetchSkills: vi.fn(async () => ({
    categories: [{
      name: 'builtin',
      description: '',
      skills: [{
        name: 'researcher',
        description: 'Research assistant',
        enabled: true,
        source: 'builtin',
        modified: true,
      }],
    }],
    archived: [],
  })),
  fetchSkillContent: vi.fn(async () => '# Skill'),
  fetchSkillFiles: vi.fn(async () => []),
  toggleSkill: vi.fn(),
  pinSkillApi: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  isUserMode: isUserModeMock,
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: skillsApiMock.fetchSkills,
  fetchSkillContent: skillsApiMock.fetchSkillContent,
  fetchSkillFiles: skillsApiMock.fetchSkillFiles,
  toggleSkill: skillsApiMock.toggleSkill,
  pinSkillApi: skillsApiMock.pinSkillApi,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NInput: {
    inheritAttrs: false,
    props: ['value', 'placeholder'],
    emits: ['update:value'],
    template: '<input class="skills-search" :value="value" :placeholder="placeholder" @input="$emit(\'update:value\', $event.target.value)" />',
  },
  NSwitch: {
    props: ['value', 'loading'],
    emits: ['update:value', 'click'],
    template: '<button class="skill-toggle" @click.stop="$emit(\'update:value\', !value)">toggle</button>',
  },
  useMessage: () => ({
    error: vi.fn(),
  }),
}))

vi.mock('@/components/hermes/chat/MarkdownRenderer.vue', () => ({
  default: { props: ['content'], template: '<article class="markdown">{{ content }}</article>' },
}))

import SkillList from '@/components/hermes/skills/SkillList.vue'
import SkillDetail from '@/components/hermes/skills/SkillDetail.vue'
import SkillsView from '@/views/hermes/SkillsView.vue'

const categories = [{
  name: 'builtin',
  description: '',
  skills: [{
    name: 'researcher',
    description: 'Research assistant',
    enabled: true,
    source: 'builtin' as const,
    pinned: true,
  }],
}]

describe('skills user mode presentation', () => {
  beforeEach(() => {
    isUserModeMock.mockReturnValue(false)
    skillsApiMock.fetchSkills.mockClear()
    skillsApiMock.fetchSkillContent.mockClear()
    skillsApiMock.fetchSkillFiles.mockClear()
    skillsApiMock.toggleSkill.mockClear()
    skillsApiMock.pinSkillApi.mockClear()
  })

  it('hides admin source and modified filters in chat plane user mode', async () => {
    isUserModeMock.mockReturnValue(true)

    const wrapper = mount(SkillsView, {
      global: {
        stubs: {
          SkillDetail: true,
        },
      },
    })

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(wrapper.find('.source-legend').exists()).toBe(false)
    expect(wrapper.find('.modified-badge').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('skills.modified')
  })

  it('hides mutating controls in chat plane user mode', () => {
    isUserModeMock.mockReturnValue(true)

    const list = mount(SkillList, {
      props: {
        categories,
        archived: [],
        selectedSkill: 'builtin/researcher',
        searchQuery: '',
        sourceFilter: null,
      },
    })
    const detail = mount(SkillDetail, {
      props: {
        category: 'builtin',
        skill: 'researcher',
        skillName: 'researcher',
        pinned: true,
      },
    })

    expect(list.find('.skill-toggle').exists()).toBe(false)
    expect(detail.find('.pin-toggle').exists()).toBe(false)
  })

  it('keeps mutating controls outside chat plane user mode', () => {
    isUserModeMock.mockReturnValue(false)

    const list = mount(SkillList, {
      props: {
        categories,
        archived: [],
        selectedSkill: 'builtin/researcher',
        searchQuery: '',
        sourceFilter: null,
      },
    })
    const detail = mount(SkillDetail, {
      props: {
        category: 'builtin',
        skill: 'researcher',
        skillName: 'researcher',
        pinned: true,
      },
    })

    expect(list.find('.skill-toggle').exists()).toBe(true)
    expect(detail.find('.pin-toggle').exists()).toBe(true)
  })

  it('loads the first visible skill detail after the list is fetched', async () => {
    isUserModeMock.mockReturnValue(true)

    mount(SkillsView)

    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(skillsApiMock.fetchSkillContent).toHaveBeenCalledWith('builtin/researcher/SKILL.md')
    expect(skillsApiMock.fetchSkillFiles).toHaveBeenCalledWith('builtin', 'researcher')
  })
})
