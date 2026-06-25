// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const replaceMock = vi.hoisted(() => vi.fn())
const routeQuery = vi.hoisted(() => ({ tab: undefined as string | undefined }))
const openMock = vi.hoisted(() => vi.fn())

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery }),
  useRouter: () => ({ replace: replaceMock }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

// Mock the three tab panels so the heavy chat-store/router import chain never
// loads in this isolated view test (mirrors how SkillsView/CredentialsView are
// stubbed).
vi.mock('@/views/hermes/ExpertCatalogView.vue', () => ({
  default: { name: 'ExpertCatalogView', template: '<section data-test="expert-experts">Experts</section>' },
}))

vi.mock('@/views/hermes/SkillsView.vue', () => ({
  default: { name: 'SkillsView', template: '<section data-test="expert-skills">Skills</section>' },
}))

vi.mock('@/views/hermes/CredentialsView.vue', () => ({
  default: { name: 'CredentialsView', template: '<section data-test="expert-connectors">Connectors</section>' },
}))

import ExpertView from '@/views/hermes/ExpertView.vue'

describe('ExpertView', () => {
  beforeEach(() => {
    routeQuery.tab = undefined
    replaceMock.mockClear()
    openMock.mockClear()
    vi.unstubAllEnvs()
  })

  it('opens on the Experts catalog by default', () => {
    const wrapper = mount(ExpertView)

    expect(wrapper.find('[data-test="expert-experts"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="expert-skills"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="expert-connectors"]').exists()).toBe(false)
  })

  it('opens the connectors page from the tab query', () => {
    routeQuery.tab = 'connectors'

    const wrapper = mount(ExpertView)

    expect(wrapper.find('[data-test="expert-experts"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="expert-connectors"]').exists()).toBe(true)
  })

  it('normalizes invalid tab query values back to experts', () => {
    routeQuery.tab = 'plugins'

    mount(ExpertView)

    expect(replaceMock).toHaveBeenCalledWith({
      query: { tab: undefined },
    })
  })

  it('hides the AiHub entry button when VITE_HERMES_AIHUB_URL is unset', () => {
    const wrapper = mount(ExpertView)
    expect(wrapper.find('.aihub-entry').exists()).toBe(false)
  })

  it('shows the AiHub entry button and opens the configured URL in a new tab', async () => {
    vi.stubEnv('VITE_HERMES_AIHUB_URL', 'https://aihub.example.com')
    vi.stubGlobal('open', openMock)

    const wrapper = mount(ExpertView)
    const btn = wrapper.find('.aihub-entry')
    expect(btn.exists()).toBe(true)

    await btn.trigger('click')
    expect(openMock).toHaveBeenCalledWith(
      'https://aihub.example.com',
      '_blank',
      'noopener,noreferrer',
    )
  })

  it('keeps the AiHub button hidden when only the placeholder default is set', () => {
    vi.stubEnv('VITE_HERMES_AIHUB_URL', '__AIHUB_URL_NOT_CONFIGURED__')
    const wrapper = mount(ExpertView)
    expect(wrapper.find('.aihub-entry').exists()).toBe(false)
  })
})
