// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useProfilesStore } from '@/stores/hermes/profiles'

const listJobsMock = vi.hoisted(() => vi.fn())
const fetchProfilesMock = vi.hoisted(() => vi.fn())
const switchProfileMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/hermes/jobs', () => ({
  listJobs: listJobsMock,
}))

vi.mock('@/api/hermes/profiles', () => ({
  fetchProfiles: fetchProfilesMock,
  switchProfile: switchProfileMock,
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

describe('JobsView active profile changes', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    listJobsMock.mockReset()
    listJobsMock.mockResolvedValue([])
    fetchProfilesMock.mockReset()
    fetchProfilesMock.mockResolvedValue([
      { name: 'profile-a' },
      { name: 'profile-b' },
    ])
    switchProfileMock.mockReset()
    switchProfileMock.mockResolvedValue(true)
  })

  it('reloads automation jobs when the active frontend profile changes', async () => {
    localStorage.setItem('hermes_active_profile_name', 'profile-a')
    const pinia = createPinia()
    setActivePinia(pinia)

    mount(JobsView, {
      global: {
        plugins: [pinia],
      },
    })
    await flushPromises()

    const profilesStore = useProfilesStore()
    expect(listJobsMock).toHaveBeenCalledTimes(1)

    await profilesStore.switchProfile('profile-b')
    await flushPromises()

    expect(profilesStore.activeProfileName).toBe('profile-b')
    expect(listJobsMock).toHaveBeenCalledTimes(2)
  })
})
