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
    t: (key: string, params?: Record<string, unknown>) =>
      key === 'expert.catalog.newBadge'
        ? 'New'
        : key === 'expert.catalog.updatedAt'
          ? `更新于 ${params?.date}`
          : key === 'expert.catalog.usedCount'
            ? `使用 ${params?.count} 次`
            : key,
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

  it('shows the release version, updated date, and only marks updates from the last 24 hours as New', async () => {
    fetchExpertsMock.mockResolvedValue({
      experts: [
        {
          id: 'recent',
          name: 'Recent expert',
          release_version: '1.0.5',
          release_installed_at: Math.floor(Date.parse('2026-07-24T02:00:00Z') / 1000),
          use_count: 132,
        },
        {
          id: 'old',
          name: 'Old expert',
          release_version: '1.0.4',
          release_installed_at: Math.floor(Date.parse('2026-07-20T12:00:00Z') / 1000),
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
    expect(cards[0].find('.card-updated').text()).toMatch(/^更新于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(cards[0].find('.card-usage').text()).toBe('使用 132 次')
    expect(cards[1].find('.card-version').text()).toBe('v1.0.4')
    expect(cards[1].find('.card-new-badge').exists()).toBe(false)
    expect(cards[1].find('.card-usage').exists()).toBe(false)
    expect(cards[1].find('.card-updated').text()).toMatch(/^更新于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(cards[2].find('.card-version').exists()).toBe(false)
    expect(cards[2].find('.card-version-placeholder').exists()).toBe(true)
    expect(cards[0].find('.card-version-placeholder').exists()).toBe(false)
    expect(cards[2].find('.card-new-badge').exists()).toBe(false)
    expect(cards[2].find('.card-updated').exists()).toBe(false)
  })

  it('drops the New badge when the 24h window expires while the page stays open', async () => {
    const now = Date.parse('2026-07-24T12:00:00Z')
    fetchExpertsMock.mockResolvedValue({
      experts: [
        {
          id: 'edge',
          name: 'Edge expert',
          release_version: '1.0.0',
          release_installed_at: Math.floor((now - 24 * 60 * 60 * 1000 + 90_000) / 1000),
        },
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
    expect(wrapper.find('.card-new-badge').exists()).toBe(true)

    vi.advanceTimersByTime(120_000)
    await flushPromises()
    expect(wrapper.find('.card-new-badge').exists()).toBe(false)
  })

  it('rejects out-of-range and future timestamps in helpers', async () => {
    const { formatExpertUpdatedFull, isExpertRecentlyUpdated } =
      await import('@/api/hermes/experts')
    for (const bad of [0, -1, NaN, Infinity, 1e13]) {
      expect(formatExpertUpdatedFull({ release_installed_at: bad })).toBe('')
    }
    const ts = Math.floor(Date.parse('2026-07-24T02:00:00Z') / 1000)
    expect(formatExpertUpdatedFull({ release_installed_at: ts })).toMatch(/^2026-\d{2}-\d{2} \d{2}:\d{2}$/)

    const now = Date.parse('2026-07-24T12:00:00Z')
    const at = (iso: string) => Math.floor(Date.parse(iso) / 1000)
    expect(isExpertRecentlyUpdated({ release_installed_at: at('2026-07-23T12:00:00Z') }, now)).toBe(true)
    expect(isExpertRecentlyUpdated({ release_installed_at: at('2026-07-23T11:59:59Z') }, now)).toBe(false)
    expect(isExpertRecentlyUpdated({ release_installed_at: at('2026-07-24T13:00:00Z') }, now)).toBe(false)
    const recentStr = String(at('2026-07-24T11:30:00Z'))
    expect(isExpertRecentlyUpdated({ release_installed_at: recentStr as unknown as number }, now)).toBe(false)
    expect(isExpertRecentlyUpdated({ release_installed_at: [at('2026-07-24T11:30:00Z')] as unknown as number }, now)).toBe(false)
  })

  it('shows the same release metadata in the expert detail panel', () => {
    const wrapper = mount(ExpertDetailPanel, {
      props: {
        expert: {
          id: 'recent',
          name: 'Recent expert',
          release_version: '1.0.5',
          release_installed_at: Math.floor(Date.parse('2026-07-24T02:00:00Z') / 1000),
        },
      },
    })

    expect(wrapper.find('.detail-version').text()).toBe('v1.0.5')
    expect(wrapper.find('.detail-new').text()).toBe('New')
    expect(wrapper.find('.detail-updated').text()).toMatch(/^更新于 2026-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})
