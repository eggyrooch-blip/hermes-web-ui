// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import SkillMarketGrid from '@/components/hermes/skills/SkillMarketGrid.vue'

// The grid is the prototype's plugin-tab body: 精选技能 sampler, then the
// 市场/内置/已安装 seg-chips over per-tab card walls. Source filtering left
// with the header legend row; the hub/keephub display merge now surfaces as
// the card's source label instead of a dot.

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/api/hermes/skills', () => ({
  toggleSkill: vi.fn(),
  deleteSkillApi: vi.fn(),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
  useDialog: () => ({ warning: vi.fn() }),
}))

function mountGrid(props: Record<string, unknown>) {
  return mount(SkillMarketGrid, {
    props: { archived: [], searchQuery: '', ...props },
    global: {
      stubs: {
        KpIcon: true,
        KpAppIcon: true,
        KpToggle: true,
        KpSectionTitle: { template: '<div><slot /><slot name="action" /></div>' },
        KpEmptyState: { props: ['title'], template: '<div>{{ title }}</div>' },
      },
    },
  })
}

const CATS = (skills: Record<string, unknown>[]) => [
  { name: 'tools', description: '', skills },
]

describe('SkillMarketGrid', () => {
  it('merges hub and keephub sources into the single keepaihub label on cards', () => {
    const wrapper = mountGrid({
      categories: CATS([
        { name: 'hub-skill', description: 'From hub', enabled: true, source: 'hub' },
        { name: 'keephub-skill', description: 'From keephub', enabled: true, source: 'keephub' },
        { name: 'local-skill', description: 'Local', enabled: true, source: 'local' },
      ]),
    })

    const metas = wrapper
      .find('.skill-market__grid')
      .findAll('.skill-card__meta')
      .map(m => m.text())
    expect(metas).toEqual([
      'skills.source.keepaihub',
      'skills.source.keepaihub',
      'skills.source.local',
    ])
  })

  it('shows archived skills on the market wall with the archived badge', () => {
    const wrapper = mountGrid({
      categories: [],
      archived: [{ name: 'archived-hub-skill', description: 'Archived', enabled: false, source: 'keephub' }],
    })

    const card = wrapper.get('[data-skill="archived-hub-skill"]')
    expect(card.get('.skill-badge').text()).toBe('skills.archived')
    expect(card.get('.skill-card__meta').text()).toBe('skills.source.keepaihub')
  })

  it('opens the detail for the clicked skill', async () => {
    const wrapper = mountGrid({
      categories: CATS([{ name: 'local-skill', description: 'Local', enabled: true, source: 'local' }]),
    })

    await wrapper.get('.skill-market__grid [data-skill="local-skill"]').trigger('click')

    expect(wrapper.emitted('select')).toEqual([['tools', 'local-skill']])
  })

  it('filters the market wall by the search query across name and description', () => {
    const wrapper = mountGrid({
      categories: CATS([
        { name: 'alpha', description: 'reads spreadsheets', enabled: true, source: 'local' },
        { name: 'beta', description: 'writes docs', enabled: true, source: 'local' },
      ]),
      searchQuery: 'spreadsheet',
    })

    const grid = wrapper.find('.skill-market__grid')
    expect(grid.text()).toContain('alpha')
    expect(grid.text()).not.toContain('beta')
  })

  it('splits builtin and user-added skills across the 内置/已安装 tabs', async () => {
    const wrapper = mountGrid({
      categories: CATS([
        { name: 'builtin-skill', description: '', enabled: true, source: 'builtin' },
        { name: 'builtin-off', description: '', enabled: false, source: 'builtin' },
        { name: 'local-skill', description: '', enabled: true, source: 'local' },
      ]),
    })

    // Tab counts: 内置 counts only the built-ins that are ON (prototype rule);
    // 已安装 counts everything user-added.
    expect(wrapper.get('[data-testid="skills-tab-builtin"]').text()).toContain('1')
    expect(wrapper.get('[data-testid="skills-tab-installed"]').text()).toContain('1')

    await wrapper.get('[data-testid="skills-tab-builtin"]').trigger('click')
    let names = wrapper.findAll('.skill-market__grid [data-skill]').map(c => c.attributes('data-skill'))
    expect(names).toEqual(['builtin-skill', 'builtin-off'])

    await wrapper.get('[data-testid="skills-tab-installed"]').trigger('click')
    names = wrapper.findAll('.skill-market__grid [data-skill]').map(c => c.attributes('data-skill'))
    expect(names).toEqual(['local-skill'])
  })

  it('emits use from the corner quick-action on an enabled card', async () => {
    const wrapper = mountGrid({
      categories: CATS([{ name: 'local-skill', description: '', enabled: true, source: 'local' }]),
    })

    await wrapper
      .get('.skill-market__grid [data-skill="local-skill"] .skill-card__corner')
      .trigger('click')

    expect(wrapper.emitted('use')).toEqual([['tools', 'local-skill']])
    // The quick-action must not also open the detail.
    expect(wrapper.emitted('select')).toBeUndefined()
  })
})
