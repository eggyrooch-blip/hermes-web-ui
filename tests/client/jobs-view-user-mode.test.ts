// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

// Upstream JobsView.vue (post-rebaseline) reads two Pinia stores at setup:
// useJobsStore() and useProfilesStore(). On mount it runs reloadJobsForProfile,
// which calls ensureProfileSelection() (-> profilesStore.fetchProfiles() when no
// profile is active yet) BEFORE jobsStore.fetchJobs(). We mock both stores so the
// component never touches a real Pinia instance.
//
// The fork-era "gateway-manager" surface this file used to test
// (gatewayUnavailable gating, .create-job-button disabled, .release-memory-button
// "runtime memory release") was deleted in the rebaseline: broker-only, no local
// gateway. Those assertions tested DELETED features and were removed. The one
// surviving real semantic — profile selection must precede profile-scoped job
// loading — is verified below.

const jobsStoreMock = vi.hoisted(() => ({
  jobs: [] as Array<{ id: string; job_id: string; name: string }>,
  loading: false,
  fetchJobs: vi.fn(),
}))

const profilesStoreMock = vi.hoisted(() => ({
  profiles: [] as Array<{ name: string }>,
  activeProfileName: null as string | null,
  fetchProfiles: vi.fn(),
}))

vi.mock('@/stores/hermes/jobs', () => ({
  useJobsStore: () => jobsStoreMock,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStoreMock,
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
  NTooltip: {
    template: '<span class="n-tooltip"><slot name="trigger" /><slot /></span>',
  },
}))

vi.mock('@/components/hermes/jobs/JobsPanel.vue', () => ({
  default: { props: ['selectedJobId'], template: '<div>JobsPanel</div>' },
}))
vi.mock('@/components/hermes/jobs/JobRunHistory.vue', () => ({
  default: { props: ['selectedJobId', 'jobNameMap', 'profileKey'], template: '<div>JobRunHistory</div>' },
}))
vi.mock('@/components/hermes/jobs/JobFormModal.vue', () => ({
  default: { props: ['jobId'], template: '<div class="job-form-modal">JobFormModal</div>' },
}))

import JobsView from '@/views/hermes/JobsView.vue'

describe('JobsView profile-scoped loading', () => {
  beforeEach(() => {
    jobsStoreMock.jobs = []
    jobsStoreMock.loading = false
    jobsStoreMock.fetchJobs.mockClear()
    profilesStoreMock.profiles = []
    profilesStoreMock.activeProfileName = null
    profilesStoreMock.fetchProfiles.mockReset()
    profilesStoreMock.fetchProfiles.mockResolvedValue(undefined)
  })

  it('initializes the active profile before loading profile-scoped jobs', async () => {
    mount(JobsView)
    await flushPromises()

    // No profile active and empty profile list -> ensureProfileSelection must
    // fetch profiles, and it must happen before jobs are loaded.
    expect(profilesStoreMock.fetchProfiles).toHaveBeenCalled()
    expect(jobsStoreMock.fetchJobs).toHaveBeenCalled()
    expect(profilesStoreMock.fetchProfiles.mock.invocationCallOrder[0]).toBeLessThan(
      jobsStoreMock.fetchJobs.mock.invocationCallOrder[0],
    )
  })

  it('skips re-fetching profiles when one is already active', async () => {
    profilesStoreMock.activeProfileName = 'default'
    profilesStoreMock.profiles = [{ name: 'default' }]

    mount(JobsView)
    await flushPromises()

    expect(profilesStoreMock.fetchProfiles).not.toHaveBeenCalled()
    expect(jobsStoreMock.fetchJobs).toHaveBeenCalled()
  })
})
