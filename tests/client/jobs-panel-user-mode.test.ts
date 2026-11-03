// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const jobsStoreMock = vi.hoisted(() => ({
  jobs: [],
  loading: false,
  gatewayUnavailable: false,
  fetchJobs: vi.fn(),
}))

const isUserModeMock = vi.hoisted(() => vi.fn(() => true))

vi.mock('@/stores/hermes/jobs', () => ({
  useJobsStore: () => jobsStoreMock,
}))

vi.mock('@/api/client', () => ({
  isUserMode: isUserModeMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NButton: {
    props: ['disabled', 'loading', 'type', 'size'],
    emits: ['click'],
    template: '<button class="n-button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
}))

vi.mock('@/components/hermes/jobs/JobCard.vue', () => ({
  default: { props: ['job', 'selected'], template: '<article class="job-card-stub" :data-job-id="job.id">{{ job.name }}</article>' },
}))

import JobsPanel from '@/components/hermes/jobs/JobsPanel.vue'

describe('JobsPanel user-mode gateway state', () => {
  const panelProps = {
    selectedJobId: null,
    sortBy: 'name' as const,
    sortAsc: true,
  }

  beforeEach(() => {
    jobsStoreMock.jobs = []
    jobsStoreMock.loading = false
    jobsStoreMock.gatewayUnavailable = false
    jobsStoreMock.fetchJobs.mockClear()
    isUserModeMock.mockReturnValue(true)
  })

  it('does not expose a manual wake action when the bound gateway is unavailable', () => {
    jobsStoreMock.gatewayUnavailable = true

    const wrapper = mount(JobsPanel, {
      props: panelProps,
    })

    expect(wrapper.find('.wake-gateway-button').exists()).toBe(false)
  })

  it('does not expose manual memory release in user mode', () => {
    jobsStoreMock.gatewayUnavailable = false

    const wrapper = mount(JobsPanel, {
      props: panelProps,
    })

    expect(wrapper.find('.sleep-gateway-button').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('jobs.releaseMemory')
  })

  it('does not show API-only memory release in ops mode', () => {
    isUserModeMock.mockReturnValue(false)

    const wrapper = mount(JobsPanel, {
      props: panelProps,
    })

    expect(wrapper.find('.sleep-gateway-button').exists()).toBe(false)
  })

  it('sorts jobs by name and creation order according to props', async () => {
    jobsStoreMock.jobs = [
      { id: '1', job_id: '1', name: 'beta' },
      { id: '2', job_id: '2', name: 'alpha' },
      { id: '3', job_id: '3', name: 'gamma' },
    ]

    const wrapper = mount(JobsPanel, {
      props: panelProps,
    })

    expect(wrapper.findAll('.job-card-stub').map(card => card.text())).toEqual(['alpha', 'beta', 'gamma'])

    await wrapper.setProps({ sortBy: 'time', sortAsc: false })

    expect(wrapper.findAll('.job-card-stub').map(card => card.text())).toEqual(['gamma', 'alpha', 'beta'])
  })
})
