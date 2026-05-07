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
    props: ['disabled', 'loading'],
    emits: ['click'],
    template: '<button class="n-button" :disabled="disabled" @click="$emit(\'click\')"><slot name="icon" /><slot /></button>',
  },
  NSpin: {
    props: ['show'],
    template: '<div><slot /></div>',
  },
}))

vi.mock('@/components/hermes/jobs/JobsPanel.vue', () => ({
  default: { props: ['selectedJobId'], template: '<div>JobsPanel</div>' },
}))
vi.mock('@/components/hermes/jobs/JobRunHistory.vue', () => ({
  default: { props: ['selectedJobId', 'jobNameMap'], template: '<div>JobRunHistory</div>' },
}))
vi.mock('@/components/hermes/jobs/JobFormModal.vue', () => ({
  default: { props: ['jobId'], template: '<div class="job-form-modal">JobFormModal</div>' },
}))

import JobsView from '@/views/hermes/JobsView.vue'
describe('JobsView gateway unavailable state', () => {
  beforeEach(() => {
    jobsStoreMock.jobs = []
    jobsStoreMock.loading = false
    jobsStoreMock.gatewayUnavailable = false
    jobsStoreMock.fetchJobs.mockClear()
    isUserModeMock.mockReturnValue(true)
  })

  it('does not open the create modal while the bound gateway is unavailable', async () => {
    jobsStoreMock.gatewayUnavailable = true

    const wrapper = mount(JobsView)
    const createButton = wrapper.find('.create-job-button')

    expect(createButton.attributes('disabled')).toBeDefined()

    await createButton.trigger('click')

    expect(wrapper.find('.job-form-modal').exists()).toBe(false)
  })

  it('does not expose runtime memory release from the page header when jobs are loaded', async () => {
    jobsStoreMock.jobs = [{ id: 'job-1', job_id: 'job-1', name: 'cleanup' }]

    const wrapper = mount(JobsView)
    const releaseButton = wrapper.find('.release-memory-button')

    expect(releaseButton.exists()).toBe(false)
  })

  it('does not show runtime memory release when the bound gateway is unavailable', async () => {
    jobsStoreMock.gatewayUnavailable = true

    const wrapper = mount(JobsView)

    expect(wrapper.find('.release-memory-button').exists()).toBe(false)
  })

  it('does not show API-only memory release in ops mode', async () => {
    isUserModeMock.mockReturnValue(false)
    jobsStoreMock.jobs = [{ id: 'job-1', job_id: 'job-1', name: 'cleanup' }]

    const wrapper = mount(JobsView)

    expect(wrapper.find('.release-memory-button').exists()).toBe(false)
  })
})
