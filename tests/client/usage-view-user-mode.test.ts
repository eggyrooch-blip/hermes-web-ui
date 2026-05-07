// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const isUserModeMock = vi.hoisted(() => vi.fn(() => false))
const fetchUsageStatsMock = vi.hoisted(() => vi.fn(async () => ({
  total_input_tokens: 0,
  total_output_tokens: 0,
  total_cache_read_tokens: 0,
  total_cache_write_tokens: 0,
  total_reasoning_tokens: 0,
  total_cost: 0,
  total_sessions: 0,
  model_usage: [],
  daily_usage: [],
})))

vi.mock('@/api/client', () => ({
  isUserMode: isUserModeMock,
}))

vi.mock('@/api/hermes/sessions', () => ({
  fetchUsageStats: fetchUsageStatsMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))

import StatCards from '@/components/hermes/usage/StatCards.vue'
import DailyTrend from '@/components/hermes/usage/DailyTrend.vue'
import UsageView from '@/views/hermes/UsageView.vue'
import { useUsageStore } from '@/stores/hermes/usage'

function seedUsageStore() {
  const store = useUsageStore()
  store.stats = {
    total_input_tokens: 100,
    total_output_tokens: 50,
    total_cache_read_tokens: 25,
    total_cache_write_tokens: 5,
    total_reasoning_tokens: 0,
    total_cost: 1.23,
    total_api_calls: 4,
    total_sessions: 2,
    model_usage: [],
    daily_usage: [{
      date: '2026-05-07',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 25,
      cache_write_tokens: 5,
      sessions: 2,
      errors: 0,
      cost: 1.23,
    }],
  }
  return store
}

describe('usage user mode presentation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    isUserModeMock.mockReturnValue(false)
    fetchUsageStatsMock.mockClear()
    seedUsageStore()
  })

  it('hides cost cards and daily cost columns in chat plane user mode', () => {
    isUserModeMock.mockReturnValue(true)

    const cards = mount(StatCards)
    const trend = mount(DailyTrend)

    expect(cards.text()).not.toContain('usage.estimatedCost')
    expect(trend.text()).not.toContain('usage.cost')
  })

  it('keeps cost metrics outside chat plane user mode', () => {
    const cards = mount(StatCards)
    const trend = mount(DailyTrend)

    expect(cards.text()).toContain('usage.estimatedCost')
    expect(trend.text()).toContain('usage.cost')
  })

  it('shows a complete user-mode empty state without cost language', async () => {
    isUserModeMock.mockReturnValue(true)
    setActivePinia(createPinia())

    const wrapper = mount(UsageView, {
      global: {
        stubs: {
          StatCards: true,
          ModelBreakdown: true,
          DailyTrend: true,
        },
      },
    })

    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))

    const empty = wrapper.find('.usage-empty-card')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('usage.noDataTitle')
    expect(empty.text()).toContain('usage.noDataHint')
    expect(empty.text()).not.toContain('usage.estimatedCost')
    expect(empty.text()).not.toContain('usage.cost')
  })
})
