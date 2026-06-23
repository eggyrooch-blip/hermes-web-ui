// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const replaceMock = vi.hoisted(() => vi.fn())
const routeQuery = vi.hoisted(() => ({ tab: undefined as string | undefined }))

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery }),
  useRouter: () => ({ replace: replaceMock }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/views/hermes/SkillsView.vue', () => ({
  default: { name: 'SkillsView', template: '<section data-test="expert-skills">Skills</section>' },
}))

vi.mock('@/views/hermes/CredentialsView.vue', () => ({
  default: { name: 'CredentialsView', template: '<section data-test="expert-connectors">Connectors</section>' },
}))

vi.mock('naive-ui', () => ({
  NTabs: {
    props: ['value'],
    emits: ['update:value'],
    template: '<div class="n-tabs"><slot /></div>',
  },
  NTabPane: {
    props: ['name', 'tab'],
    template: '<div class="n-tab-pane" :data-tab="name"><slot /></div>',
  },
}))

import ExpertView from '@/views/hermes/ExpertView.vue'

describe('ExpertView', () => {
  beforeEach(() => {
    routeQuery.tab = undefined
    replaceMock.mockClear()
  })

  it('opens on Skills by default', () => {
    const wrapper = mount(ExpertView)

    expect(wrapper.find('[data-test="expert-skills"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="expert-connectors"]').exists()).toBe(false)
  })

  it('opens the connectors page from the tab query', () => {
    routeQuery.tab = 'connectors'

    const wrapper = mount(ExpertView)

    expect(wrapper.find('[data-test="expert-skills"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="expert-connectors"]').exists()).toBe(true)
  })

  it('normalizes invalid tab query values back to skills', () => {
    routeQuery.tab = 'plugins'

    mount(ExpertView)

    expect(replaceMock).toHaveBeenCalledWith({
      query: { tab: undefined },
    })
  })
})
