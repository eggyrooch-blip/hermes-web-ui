// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const fetchExpertsMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/hermes/experts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/hermes/experts')>()
  return { ...actual, fetchExperts: fetchExpertsMock }
})

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => ({
    activeExpertId: null,
    setActiveExpert: vi.fn(),
  }),
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({ activeProfileName: 'tester' }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key === 'expert.catalog.newBadge' ? 'New' : key,
  }),
}))

import ExpertCatalogView from '@/views/hermes/ExpertCatalogView.vue'
import ExpertDetailPanel from '@/components/hermes/expert/ExpertDetailPanel.vue'

describe('ExpertCatalogView release metadata', () => {
  beforeEach(() => {
    fetchExpertsMock.mockReset()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the release version and only marks updates from the last 7 days as New', async () => {
    fetchExpertsMock.mockResolvedValue({
      experts: [
        {
          id: 'recent',
          name: 'Recent expert',
          release_version: '1.0.5',
          release_installed_at: Math.floor(Date.parse('2026-07-20T12:00:00Z') / 1000),
        },
        {
          id: 'old',
          name: 'Old expert',
          release_version: '1.0.4',
          release_installed_at: Math.floor(Date.parse('2026-07-01T12:00:00Z') / 1000),
        },
        { id: 'legacy', name: 'Legacy expert' },
      ],
    })

    const wrapper = mount(ExpertCatalogView, {
      global: {
        stubs: {
          NInput: true,
          NDrawer: { template: '<div><slot /></div>' },
          NDrawerContent: { template: '<div><slot /></div>' },
          ExpertDetailPanel: true,
        },
      },
    })
    await flushPromises()

    const cards = wrapper.findAll('.expert-card')
    expect(cards[0].find('.card-version').text()).toBe('v1.0.5')
    expect(cards[0].find('.card-new-badge').text()).toBe('New')
    expect(cards[1].find('.card-version').text()).toBe('v1.0.4')
    expect(cards[1].find('.card-new-badge').exists()).toBe(false)
    expect(cards[2].find('.card-version').exists()).toBe(false)
    expect(cards[2].find('.card-new-badge').exists()).toBe(false)
  })

  it('shows the same release metadata in the expert detail panel', () => {
    const wrapper = mount(ExpertDetailPanel, {
      props: {
        expert: {
          id: 'recent',
          name: 'Recent expert',
          release_version: '1.0.5',
          release_installed_at: Math.floor(Date.parse('2026-07-20T12:00:00Z') / 1000),
        },
      },
    })

    expect(wrapper.find('.detail-version').text()).toBe('v1.0.5')
    expect(wrapper.find('.detail-new').text()).toBe('New')
  })
})
