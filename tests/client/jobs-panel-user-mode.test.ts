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
  default: { props: ['job', 'selected'], template: '<article class="job-card-stub" />' },
}))

import JobsPanel from '@/components/hermes/jobs/JobsPanel.vue'

describe('JobsPanel user-mode gateway state', () => {
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
      props: { selectedJobId: null },
    })

    expect(wrapper.find('.wake-gateway-button').exists()).toBe(false)
  })

  it('does not expose manual memory release in user mode', () => {
    jobsStoreMock.gatewayUnavailable = false

    const wrapper = mount(JobsPanel, {
      props: { selectedJobId: null },
    })

    expect(wrapper.find('.sleep-gateway-button').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('jobs.releaseMemory')
  })

  it('does not show API-only memory release in ops mode', () => {
    isUserModeMock.mockReturnValue(false)

    const wrapper = mount(JobsPanel, {
      props: { selectedJobId: null },
    })

    expect(wrapper.find('.sleep-gateway-button').exists()).toBe(false)
  })
})
