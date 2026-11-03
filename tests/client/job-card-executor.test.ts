// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

const mockJobsStore = vi.hoisted(() => ({
  pauseJob: vi.fn(),
  resumeJob: vi.fn(),
  runJob: vi.fn(),
  deleteJob: vi.fn(),
}))

const mockProfilesStore = vi.hoisted(() => ({
  profiles: [] as Array<Record<string, any>>,
}))

const mockFetchExperts = vi.hoisted(() => vi.fn(async (_profile?: string) => ({
  experts: [{ id: 'exp_47d', name: 'HR 专家' }],
})))

vi.mock('@/stores/hermes/jobs', () => ({
  useJobsStore: () => mockJobsStore,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => mockProfilesStore,
}))

vi.mock('@/api/hermes/experts', () => ({
  fetchExperts: mockFetchExperts,
}))

const mockActiveProfileName = vi.hoisted(() => ({ value: 'prof_a' as string | null }))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => mockActiveProfileName.value,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: defineComponent({ template: '<button><slot /></button>' }),
  NTooltip: defineComponent({ template: '<span><slot name="trigger" /><slot /></span>' }),
  useMessage: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

import JobCard from '@/components/hermes/jobs/JobCard.vue'

function baseJob(overrides: Record<string, any> = {}) {
  return {
    job_id: 'abc123abc123',
    id: 'abc123abc123',
    name: 'agent task',
    prompt: 'p',
    skills: [],
    skill: null,
    model: null,
    provider: null,
    base_url: null,
    script: null,
    schedule: '0 9 * * *',
    schedule_display: '0 9 * * *',
    repeat: '∞',
    enabled: true,
    state: 'scheduled',
    paused_at: null,
    paused_reason: null,
    created_at: '2026-08-17T00:00:00Z',
    next_run_at: null,
    last_run_at: null,
    last_status: null,
    last_error: null,
    deliver: 'feishu',
    origin: null,
    last_delivery_error: null,
    ...overrides,
  }
}

describe('JobCard executor chip (M-0)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockActiveProfileName.value = 'prof_a'
    mockProfilesStore.profiles = [
      { name: 'agent_prof', kind: 'agent', agentId: 'agent-1', displayLabel: '会务助理' },
    ]
  })

  it('resolves the expert badge to the catalog name, id only as fallback', async () => {
    const wrapper = mount(JobCard, {
      props: { job: baseJob({ agent_id: 'agent-1', expert_id: 'exp_47d' }) as any },
    })
    await flushPromises()

    const chip = wrapper.find('[data-testid="job-executor"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('会务助理')
    expect(chip.text()).toContain('HR 专家')
    expect(chip.text()).not.toContain('exp_47d')
    expect(mockFetchExperts).toHaveBeenCalledWith('agent_prof')
  })

  it('falls back to the raw expert id when the catalog fetch fails', async () => {
    // Distinct profile so the module-level per-profile cache cannot serve a
    // catalog resolved by an earlier test.
    mockProfilesStore.profiles = [
      { name: 'agent_prof_b', kind: 'agent', agentId: 'agent-2', displayLabel: '另一位' },
    ]
    mockFetchExperts.mockRejectedValueOnce(new Error('catalog down'))
    const wrapper = mount(JobCard, {
      props: { job: baseJob({ agent_id: 'agent-2', expert_id: 'exp_47d' }) as any },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="job-executor"]').text()).toContain('exp_47d')
  })

  it('renders no executor chip for legacy jobs', async () => {
    const wrapper = mount(JobCard, { props: { job: baseJob() as any } })
    await flushPromises()

    expect(wrapper.find('[data-testid="job-executor"]').exists()).toBe(false)
    expect(mockFetchExperts).not.toHaveBeenCalled()
  })

  it('expert-only badges never leak names across a profile switch (A→B)', async () => {
    mockProfilesStore.profiles = []
    mockFetchExperts.mockImplementation(async (profile?: string) => ({
      experts: [{ id: 'exp_shared', name: profile === 'prof_a' ? 'A 的投放专家' : 'B 的投放专家' }],
    }))

    mockActiveProfileName.value = 'prof_a'
    const wrapperA = mount(JobCard, {
      props: { job: baseJob({ expert_id: 'exp_shared' }) as any },
    })
    await flushPromises()
    expect(wrapperA.find('[data-testid="job-executor"]').text()).toContain('A 的投放专家')

    // Switch profile: the SAME expert id must resolve through B's catalog,
    // never A's cached one.
    mockActiveProfileName.value = 'prof_b'
    const wrapperB = mount(JobCard, {
      props: { job: baseJob({ expert_id: 'exp_shared' }) as any },
    })
    await flushPromises()
    expect(wrapperB.find('[data-testid="job-executor"]').text()).toContain('B 的投放专家')

    expect(mockFetchExperts).toHaveBeenCalledWith('prof_a')
    expect(mockFetchExperts).toHaveBeenCalledWith('prof_b')
  })

  it('expert-only badge keeps the raw id when the active profile is unknown', async () => {
    mockProfilesStore.profiles = []
    mockActiveProfileName.value = null
    const wrapper = mount(JobCard, {
      props: { job: baseJob({ expert_id: 'exp_solo' }) as any },
    })
    await flushPromises()

    expect(mockFetchExperts).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="job-executor"]').text()).toContain('exp_solo')
  })
})
