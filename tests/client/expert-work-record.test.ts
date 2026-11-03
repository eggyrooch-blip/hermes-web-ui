// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchRecord = vi.hoisted(() => vi.fn())

vi.mock('@/api/hermes/experts', () => ({
  fetchExpertWorkRecord: fetchRecord,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (
    params ? `${key}:${JSON.stringify(params)}` : key
  ) }),
}))

import ExpertWorkRecord from '@/components/hermes/expert/ExpertWorkRecord.vue'

const userRecord = {
  expert_id: 'expert-x',
  mode: 'user' as const,
  window_days: 30,
  partitions: {
    sessions: { status: 'available' as const, items: [{ id: 'session-a', title: '投放复盘', last_active: 100, status: 'completed' }] },
    jobs: { status: 'unavailable' as const, items: [] },
    feedback: { status: 'available' as const, items: [{ session_id: 'session-a', run_id: 'run-a', rating: 'up' as const, reason: null, updated_at: 101 }] },
  },
}

describe('ExpertWorkRecord', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchRecord.mockImplementation(async (_id: string, view?: 'maintainer') => {
      if (view === 'maintainer') throw new Error('API Error 404: not found')
      return userRecord
    })
  })

  it('shows only the current user summaries and explicit unavailable partitions', async () => {
    const wrapper = mount(ExpertWorkRecord, { props: { expertId: 'expert-x' } })
    await flushPromises()

    expect(wrapper.get('[data-work-record]').text()).toContain('expert.workRecord.title')
    expect(wrapper.get('[data-work-sessions]').text()).toContain('投放复盘')
    expect(wrapper.get('[data-work-jobs]').text()).toContain('expert.workRecord.unavailable')
    expect(wrapper.get('[data-work-feedback]').text()).toContain('expert.workRecord.positive')
    expect(fetchRecord).toHaveBeenCalledWith('expert-x')
    expect(fetchRecord).toHaveBeenCalledWith('expert-x', 'maintainer')
  })

  it('replaces user details with identifier-free maintainer aggregates', async () => {
    fetchRecord.mockImplementation(async (_id: string, view?: 'maintainer') => view === 'maintainer'
      ? {
          expert_id: 'expert-x', mode: 'maintainer', window_days: 30,
          partitions: {
            sessions: { status: 'available', count: 7, active: 2, completed: 5 },
            jobs: { status: 'unavailable' },
            feedback: { status: 'available', count: 4, positive: 3, negative: 1, positive_rate: 0.75 },
          },
        }
      : userRecord)

    const wrapper = mount(ExpertWorkRecord, { props: { expertId: 'expert-x' } })
    await flushPromises()

    const text = wrapper.get('[data-work-record]').text()
    expect(text).toContain('expert.workRecord.maintainerTitle')
    expect(text).toContain('expert.workRecord.sessionCount:{"count":7}')
    expect(text).toContain('expert.workRecord.positiveRate:{"rate":75}')
    expect(text).not.toContain('投放复盘')
    expect(text).not.toContain('session-a')
  })

  it('renders stable empty states without generated summaries', async () => {
    fetchRecord.mockImplementation(async (_id: string, view?: 'maintainer') => {
      if (view === 'maintainer') throw new Error('API Error 404: not found')
      return {
        ...userRecord,
        partitions: {
          sessions: { status: 'available', items: [] },
          jobs: { status: 'available', items: [] },
          feedback: { status: 'available', items: [] },
        },
      }
    })
    const wrapper = mount(ExpertWorkRecord, { props: { expertId: 'expert-x' } })
    await flushPromises()

    expect(wrapper.findAll('[data-empty]')).toHaveLength(3)
    expect(wrapper.text()).not.toContain('summary')
  })
})
