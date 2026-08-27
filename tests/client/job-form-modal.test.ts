// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

const mockMessage = vi.hoisted(() => ({
  warning: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

const mockSettingsStore = vi.hoisted(() => ({
  platforms: {} as Record<string, any>,
  fetchSettings: vi.fn(async () => {
    mockSettingsStore.platforms = {
      telegram: { token: 'telegram-token' },
      discord: { token: 'discord-token' },
      slack: { token: 'slack-token' },
      whatsapp: { enabled: true },
      matrix: { token: 'matrix-token' },
      weixin: { token: 'weixin-token' },
      wecom: { extra: { bot_id: 'wecom-bot' } },
      feishu: { extra: { app_id: 'feishu-app' } },
      dingtalk: { extra: { client_id: 'dingtalk-client' } },
      qqbot: { extra: { app_id: 'qq-app', client_secret: 'qq-secret' } },
    }
  }),
}))

const mockJobsStore = vi.hoisted(() => ({
  createJob: vi.fn(),
  updateJob: vi.fn(),
}))

const mockProfilesStore = vi.hoisted(() => ({
  profiles: [] as Array<Record<string, any>>,
  fetchProfiles: vi.fn(async () => {}),
}))

const mockAppStore = vi.hoisted(() => ({
  modelGroups: [] as Array<Record<string, any>>,
  profileModelGroups: [] as Array<Record<string, any>>,
  displayModelName: (model: string) => model,
  loadModels: vi.fn(async () => {}),
}))

const mockFetchExperts = vi.hoisted(() => vi.fn(async (_profile?: string) => ({
  experts: [
    { id: 'hr-expert', name: 'HR 专家' },
    { id: 'it-expert', name: 'IT 专家' },
  ],
})))

const mockFetchSkills = vi.hoisted(() => vi.fn(async () => ({
  categories: [
    {
      name: 'local',
      description: '',
      skills: [
        { name: 'planner', description: 'Plan work' },
        { name: 'reviewer', description: 'Review work' },
        { name: 'disabled-skill', description: 'Disabled', enabled: false },
      ],
    },
  ],
  archived: [],
})))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => mockSettingsStore,
}))

vi.mock('@/stores/hermes/jobs', () => ({
  useJobsStore: () => mockJobsStore,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => mockProfilesStore,
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => mockAppStore,
}))

vi.mock('@/api/hermes/experts', () => ({
  fetchExperts: mockFetchExperts,
}))

const mockActiveProfileName = vi.hoisted(() => ({ value: 'user_a' as string | null }))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => mockActiveProfileName.value,
}))

vi.mock('@/api/hermes/jobs', async () => {
  const actual = await vi.importActual<any>('@/api/hermes/jobs')
  return {
    ...actual,
    getJob: vi.fn(),
  }
})

vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: mockFetchSkills,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NModal: defineComponent({
    template: '<div class="n-modal-stub"><slot /><slot name="footer" /></div>',
  }),
  NForm: defineComponent({ template: '<form><slot /></form>' }),
  NFormItem: defineComponent({ template: '<div><slot /></div>' }),
  NInput: defineComponent({
    props: { value: { type: String, required: false } },
    emits: ['update:value'],
    template: '<input class="n-input-stub" :value="value" @input="$emit(\'update:value\', $event.target.value)" />',
  }),
  NInputNumber: defineComponent({
    props: { value: { required: false } },
    emits: ['update:value'],
    template: '<input class="n-input-number-stub" :value="value" type="number" @input="$emit(\'update:value\', Number($event.target.value))" />',
  }),
  NSelect: defineComponent({
    props: { value: { required: false }, options: { type: Array, default: () => [] }, multiple: { type: Boolean, default: false } },
    emits: ['update:value'],
    template: '<select class="n-select-stub" :multiple="multiple" @change="$emit(\'update:value\', multiple ? Array.from($event.target.selectedOptions).map(option => option.value) : $event.target.value)"><template v-for="option in options"><optgroup v-if="option.children" :key="option.key" :label="option.label"><option v-for="child in option.children" :key="child.value" :value="child.value">{{ child.label }}</option></optgroup><option v-else :key="option.value" :value="option.value" :disabled="option.disabled">{{ option.label }}</option></template></select>',
  }),
  NButton: defineComponent({
    emits: ['click'],
    template: '<button class="n-button-stub" @click.prevent="$emit(\'click\')"><slot /></button>',
  }),
  useMessage: () => mockMessage,
}))

import JobFormModal from '@/components/hermes/jobs/JobFormModal.vue'

describe('JobFormModal deliver targets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsStore.platforms = {}
    mockAppStore.modelGroups = []
    mockAppStore.profileModelGroups = []
  })

  it('loads platform settings when the store has not been hydrated', async () => {
    mount(JobFormModal, {
      props: { jobId: null },
    })

    await flushPromises()

    expect(mockSettingsStore.fetchSettings).toHaveBeenCalledOnce()
  })

  it('shows every supported platform channel in deliver target options', async () => {
    mockSettingsStore.platforms = {
      telegram: { token: 'telegram-token' },
      whatsapp: { enabled: false },
      qqbot: { extra: { app_id: 'qq-app', client_secret: 'qq-secret' } },
    }
    const wrapper = mount(JobFormModal, {
      props: { jobId: null },
    })

    await flushPromises()

    expect(mockSettingsStore.fetchSettings).not.toHaveBeenCalled()
    const labels = wrapper.find('[data-testid="job-deliver"] .n-select-stub').text()
    expect(labels).toContain('Telegram')
    expect(labels).toContain('Discord')
    expect(labels).toContain('Slack')
    expect(labels).toContain('WhatsApp')
    expect(labels).toContain('Matrix')
    expect(labels).toContain('WeChat')
    expect(labels).toContain('WeCom')
    expect(labels).toContain('Feishu')
    expect(labels).toContain('DingTalk')
    expect(labels).toContain('QQBot')

    const options = wrapper.find('[data-testid="job-deliver"] .n-select-stub').findAll('option')
    const optionByValue = Object.fromEntries(options.map(option => [option.attributes('value'), option]))
    expect(optionByValue.telegram.attributes('disabled')).toBeUndefined()
    expect(optionByValue.qqbot.attributes('disabled')).toBeUndefined()
    expect(optionByValue.discord.attributes('disabled')).toBe('')
    expect(optionByValue.whatsapp.attributes('disabled')).toBe('')
  })

  it('submits selected skills when creating a job', async () => {
    mockSettingsStore.platforms = { telegram: { token: 'telegram-token' } }
    mockJobsStore.createJob.mockResolvedValue({ id: 'job-1' })
    const wrapper = mount(JobFormModal, {
      props: { jobId: null },
    })

    await flushPromises()
    const inputs = wrapper.findAll('.n-input-stub')
    await inputs[0].setValue('Daily research')
    await inputs[1].setValue('0 9 * * *')
    await inputs[2].setValue('summarize updates')
    await wrapper.find('[data-testid="job-skills"] .n-select-stub').setValue(['planner', 'reviewer'])
    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()

    expect(mockJobsStore.createJob).toHaveBeenCalledWith({
      name: 'Daily research',
      schedule: '0 9 * * *',
      prompt: 'summarize updates',
      deliver: 'origin',
      skills: ['planner', 'reviewer'],
      repeat: undefined,
    })
  })

  const rosterProfiles = [
    { name: 'user_a', kind: 'user', displayLabel: 'sunke' },
    { name: 'coder1', kind: 'agent', agentId: 'agent-1', displayLabel: 'coder1' },
    { name: 'shared_agent', kind: 'agent', agentId: 'agent-2', shareRole: 'editor', displayLabel: '别人的' },
    { name: 'feishu_group_x', kind: 'group', displayLabel: 'KippiesWork讨论' },
  ]

  it('agent picker mirrors the Agents hub roster (mine + groups, shared excluded)', async () => {
    mockSettingsStore.platforms = { telegram: { token: 'telegram-token' } }
    mockProfilesStore.profiles = [...rosterProfiles]
    const wrapper = mount(JobFormModal, {
      props: { jobId: null },
    })
    await flushPromises()

    // Expert catalog preloads for the DEFAULT agent (= own profile),
    // requested EXPLICITLY so a sidebar profile switch cannot retarget it.
    expect(mockFetchExperts).toHaveBeenCalledTimes(1)
    expect(mockFetchExperts).toHaveBeenCalledWith('user_a')

    const picker = wrapper.find('[data-testid="job-executor-agent"] .n-select-stub')
    const text = picker.text()
    expect(text).toContain('sunke')
    expect(text).toContain('coder1')
    expect(text).toContain('KippiesWork讨论')
    expect(text).not.toContain('别人的')
    const groups = picker.findAll('optgroup').map(group => group.attributes('label'))
    expect(groups).toEqual(['jobs.executorGroupMine', 'jobs.executorGroupGroups'])
  })

  it('switching agents reloads that agent\'s expert catalog; stale A responses are dropped', async () => {
    mockSettingsStore.platforms = { telegram: { token: 'telegram-token' } }
    mockProfilesStore.profiles = [...rosterProfiles]
    let resolveA!: (value: any) => void
    const slowA = new Promise(resolve => { resolveA = resolve })
    mockFetchExperts.mockImplementation((profile?: string) => {
      if (profile === 'coder1') return slowA as any
      return Promise.resolve({ experts: [{ id: 'g-expert', name: '群专家' }] })
    })

    const wrapper = mount(JobFormModal, { props: { jobId: null } })
    await flushPromises()

    const agentSelect = wrapper.find('[data-testid="job-executor-agent"] .n-select-stub')
    await agentSelect.setValue('coder1')
    await agentSelect.setValue('feishu_group_x')
    await flushPromises()
    resolveA({ experts: [{ id: 'a-expert', name: 'A 专家' }] })
    await flushPromises()

    expect(mockFetchExperts).toHaveBeenCalledWith('coder1')
    expect(mockFetchExperts).toHaveBeenCalledWith('feishu_group_x')
    const expertSelect = wrapper.find('[data-testid="job-executor-expert"] .n-select-stub')
    expect(expertSelect.text()).toContain('群专家')
    expect(expertSelect.text()).not.toContain('A 专家')
  })

  async function fillAndSubmit(wrapper: any, opts: { agent?: string; expert?: string } = {}) {
    if (opts.agent) {
      await wrapper.find('[data-testid="job-executor-agent"] .n-select-stub').setValue(opts.agent)
      await flushPromises()
    }
    if (opts.expert) {
      await wrapper.find('[data-testid="job-executor-expert"] .n-select-stub').setValue(opts.expert)
    }
    const inputs = wrapper.findAll('.n-input-stub')
    await inputs[0].setValue('Executor task')
    await inputs[1].setValue('0 9 * * *')
    await inputs[2].setValue('do the thing')
    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()
  }

  const basePayload = {
    name: 'Executor task',
    schedule: '0 9 * * *',
    prompt: 'do the thing',
    deliver: 'origin',
    skills: [],
    repeat: undefined,
  }

  function mountForSubmit() {
    mockSettingsStore.platforms = { telegram: { token: 'telegram-token' } }
    mockProfilesStore.profiles = [...rosterProfiles]
    mockJobsStore.createJob.mockResolvedValue({ id: 'job-1' })
    // Deterministic catalog regardless of implementations left by earlier tests.
    mockFetchExperts.mockImplementation(async (_profile?: string) => ({
      experts: [
        { id: 'hr-expert', name: 'HR 专家' },
        { id: 'ads-expert', name: '投放专家' },
      ],
    }))
    return mount(JobFormModal, { props: { jobId: null } })
  }

  it('agent-only choice submits with the profile override and no expert_id', async () => {
    const wrapper = mountForSubmit()
    await flushPromises()

    await fillAndSubmit(wrapper, { agent: 'coder1' })

    expect(mockJobsStore.createJob).toHaveBeenCalledWith(basePayload, { profile: 'coder1' })
  })

  it('own agent + expert submits expert_id with the legacy single-argument call', async () => {
    const wrapper = mountForSubmit()
    await flushPromises()

    await fillAndSubmit(wrapper, { expert: 'hr-expert' })

    expect(mockJobsStore.createJob).toHaveBeenCalledWith({
      ...basePayload,
      expert_id: 'hr-expert',
    })
  })

  it('agent + that agent\'s expert submits both profile override and expert_id', async () => {
    mockFetchExperts.mockResolvedValue({ experts: [{ id: 'ads-expert', name: '投放专家' }] })
    const wrapper = mountForSubmit()
    await flushPromises()

    await fillAndSubmit(wrapper, { agent: 'coder1', expert: 'ads-expert' })

    expect(mockJobsStore.createJob).toHaveBeenCalledWith(
      { ...basePayload, expert_id: 'ads-expert' },
      { profile: 'coder1' },
    )
  })

  it('default own agent with no expert keeps the legacy request byte-identical', async () => {
    const wrapper = mountForSubmit()
    await flushPromises()

    await fillAndSubmit(wrapper)

    expect(mockJobsStore.createJob).toHaveBeenCalledWith(basePayload)
  })

  it('sidebar profile switch while the modal is open cannot hijack the executor', async () => {
    const wrapper = mountForSubmit()
    await flushPromises()

    // Executor still shows user_a, but the sidebar switched to coder1: the
    // legacy unscoped call would inherit coder1's header — must scope instead.
    mockActiveProfileName.value = 'coder1'
    await fillAndSubmit(wrapper)

    expect(mockJobsStore.createJob).toHaveBeenCalledWith(basePayload, { profile: 'user_a' })
  })

  it('blank executor is rejected: no create call ever fires', async () => {
    mockActiveProfileName.value = null
    mockSettingsStore.platforms = { telegram: { token: 'telegram-token' } }
    mockProfilesStore.profiles = []
    const wrapper = mount(JobFormModal, { props: { jobId: null } })
    await flushPromises()

    await fillAndSubmit(wrapper)

    expect(mockJobsStore.createJob).not.toHaveBeenCalled()
    expect(mockMessage.warning).toHaveBeenCalled()
  })

  it('group rows show the Agents-page group name, never the raw identifier', async () => {
    mockSettingsStore.platforms = { telegram: { token: 'telegram-token' } }
    mockProfilesStore.profiles = [
      { name: 'user_a', kind: 'user', displayLabel: 'sunke' },
      { name: 'feishu_group_named', kind: 'group', displayLabel: 'ou_cf23e7c262-软件正版化' },
      { name: 'feishu_group_unsynced', kind: 'group', displayLabel: 'oc_1a10fb26ac51' },
    ]
    const wrapper = mount(JobFormModal, { props: { jobId: null } })
    await flushPromises()

    const text = wrapper.find('[data-testid="job-executor-agent"] .n-select-stub').text()
    expect(text).toContain('软件正版化')
    expect(text).not.toContain('ou_cf23e7c262')
    expect(text).not.toContain('oc_1a10fb26ac51')
    expect(text).toContain('agentsHub.unnamedGroup')
  })
  it('prefills a scheduled expert job, cancels with zero writes, then submits its session binding once', async () => {
    mockSettingsStore.platforms = {}
    // m0 makes the executor agent REQUIRED; a scheduled entry runs as the
    // caller's own profile, so the roster/active profile must be present.
    mockActiveProfileName.value = 'user_a'
    mockProfilesStore.profiles = [{ name: 'user_a', kind: 'user', displayLabel: 'sunke' }]
    mockJobsStore.createJob.mockResolvedValue({ id: 'job-1' })
    const wrapper = mount(JobFormModal, {
      props: {
        jobId: null,
        initialName: '资源投放工作',
        initialPrompt: '每天检查投放队列',
        initialSkills: ['planner'],
        sourceSessionId: 'session-expert',
        expertId: 'keep-resource-delivery',
        idempotencyKey: 'schedule-key-1',
      },
    })

    await flushPromises()
    const inputs = wrapper.findAll('.n-input-stub')
    expect(inputs[0].element.getAttribute('value')).toBe('资源投放工作')
    expect(inputs[2].element.getAttribute('value')).toBe('每天检查投放队列')
    // Executor picker is index 0 (m0 final form), so deliver moved to index 4.
    expect(wrapper.find('[data-testid="job-deliver"] .n-select-stub').text()).toContain('Feishu')

    await wrapper.findAll('.n-button-stub')[0].trigger('click')
    expect(mockJobsStore.createJob).not.toHaveBeenCalled()

    await inputs[1].setValue('0 9 * * *')
    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()

    expect(mockJobsStore.createJob).toHaveBeenCalledTimes(1)
    expect(mockJobsStore.createJob).toHaveBeenCalledWith({
      name: '资源投放工作',
      schedule: '0 9 * * *',
      prompt: '每天检查投放队列',
      deliver: 'feishu',
      skills: ['planner'],
      repeat: undefined,
      expert_id: 'keep-resource-delivery',
      source_session_id: 'session-expert',
      idempotency_key: 'schedule-key-1',
    })
  })

  it('offers models from the app store with follow-default first', async () => {
    mockSettingsStore.platforms = { telegram: { token: 'telegram-token' } }
    mockAppStore.modelGroups = [
      { provider: 'custom:litellm-sre', label: 'litellm-sre', models: ['deepseek-v4-flash', 'gpt-5.4'] },
    ]
    const wrapper = mount(JobFormModal, {
      props: { jobId: null },
    })
    await flushPromises()

    expect(mockAppStore.loadModels).not.toHaveBeenCalled()
    const modelSelect = wrapper.find('[data-testid="job-model"] .n-select-stub')
    const options = modelSelect.findAll('option')
    expect(options[0].attributes('value')).toBe('')
    expect(options[0].text()).toBe('jobs.modelFollowDefault')
    expect(options.map(o => o.attributes('value'))).toContain('custom:litellm-sre/deepseek-v4-flash')
  })

  it('loads models when the store has none cached', async () => {
    mockSettingsStore.platforms = { telegram: { token: 'telegram-token' } }
    mount(JobFormModal, {
      props: { jobId: null },
    })
    await flushPromises()

    expect(mockAppStore.loadModels).toHaveBeenCalledOnce()
  })

  it('sends the selected model spec on create', async () => {
    mockSettingsStore.platforms = { telegram: { token: 'telegram-token' } }
    mockAppStore.modelGroups = [
      { provider: 'custom:litellm-sre', label: 'litellm-sre', models: ['deepseek-v4-flash'] },
    ]
    mockJobsStore.createJob.mockResolvedValue({ id: 'job-1' })
    const wrapper = mount(JobFormModal, {
      props: { jobId: null },
    })
    await flushPromises()

    await wrapper.find('[data-testid="job-model"] .n-select-stub').setValue('custom:litellm-sre/deepseek-v4-flash')
    const inputs = wrapper.findAll('.n-input-stub')
    await inputs[0].setValue('Cheap daily digest')
    await inputs[1].setValue('0 9 * * *')
    await inputs[2].setValue('summarize updates')
    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()

    expect(mockJobsStore.createJob).toHaveBeenCalledWith({
      name: 'Cheap daily digest',
      schedule: '0 9 * * *',
      prompt: 'summarize updates',
      deliver: 'origin',
      skills: [],
      repeat: undefined,
      model: 'custom:litellm-sre/deepseek-v4-flash',
    })
  })

  // Follow-default already asserted implicitly: the exact-payload assertion in
  // 'submits selected skills when creating a job' has no `model` key.

  it('edit mode shows the stored model read-only and never sends model on update', async () => {
    mockSettingsStore.platforms = { telegram: { token: 'telegram-token' } }
    const { getJob } = await import('@/api/hermes/jobs')
    vi.mocked(getJob).mockResolvedValue({
      id: 'job-9',
      job_id: 'job-9',
      name: 'Old job',
      prompt: 'old prompt',
      skills: [],
      skill: null,
      model: 'custom:litellm-sre/gpt-5.4',
      schedule: '0 9 * * *',
      schedule_display: '0 9 * * *',
      deliver: 'origin',
      repeat: '',
      enabled: true,
    } as any)
    mockJobsStore.updateJob.mockResolvedValue({})
    const wrapper = mount(JobFormModal, {
      props: { jobId: 'job-9' },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="job-model"]').exists()).toBe(false)
    const readonly = wrapper.find('[data-testid="job-model-readonly"]')
    expect(readonly.exists()).toBe(true)
    expect(readonly.text()).toContain('custom:litellm-sre/gpt-5.4')

    const inputs = wrapper.findAll('.n-input-stub')
    await inputs[0].setValue('Renamed job')
    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()

    expect(mockJobsStore.updateJob).toHaveBeenCalledTimes(1)
    const payload = mockJobsStore.updateJob.mock.calls[0][1]
    expect(payload).not.toHaveProperty('model')
    expect(payload.name).toBe('Renamed job')
  })

  it('never double-prefixes a model id that is already provider-qualified', async () => {
    mockSettingsStore.platforms = { telegram: { token: 'telegram-token' } }
    mockAppStore.modelGroups = [
      { provider: 'custom:litellm-sre', label: 'litellm-sre', models: ['custom:litellm-sre/tencent-sonnet-4-6', 'bare-model'] },
    ]
    const wrapper = mount(JobFormModal, { props: { jobId: null } })
    await flushPromises()

    const values = wrapper.find('[data-testid="job-model"] .n-select-stub').findAll('option').map(o => o.attributes('value'))
    expect(values).toContain('custom:litellm-sre/tencent-sonnet-4-6')
    expect(values).not.toContain('custom:litellm-sre/custom:litellm-sre/tencent-sonnet-4-6')
    expect(values).toContain('custom:litellm-sre/bare-model')
  })

  it('offers the selected executor profile catalog, not another profile models', async () => {
    mockSettingsStore.platforms = { telegram: { token: 'telegram-token' } }
    mockProfilesStore.profiles = [
      { name: 'user_a', kind: 'user', displayLabel: 'sunke' },
      { name: 'coder1', kind: 'agent', agentId: 'agent-1', displayLabel: 'coder1' },
    ]
    mockAppStore.modelGroups = [{ provider: 'p-agg', label: 'agg', models: ['aggregate-only'] }]
    mockAppStore.profileModelGroups = [
      { profile: 'user_a', groups: [{ provider: 'p-a', label: 'A', models: ['model-a'] }] },
      { profile: 'coder1', groups: [{ provider: 'p-b', label: 'B', models: ['model-b'] }] },
    ]
    const wrapper = mount(JobFormModal, { props: { jobId: null } })
    await flushPromises()

    const modelSelect = () => wrapper.find('[data-testid="job-model"] .n-select-stub')
    expect(modelSelect().findAll('option').map(o => o.attributes('value'))).toContain('p-a/model-a')
    expect(modelSelect().findAll('option').map(o => o.attributes('value'))).not.toContain('p-b/model-b')

    // Switching the executor swaps the catalog...
    await wrapper.find('[data-testid="job-executor-agent"] .n-select-stub').setValue('coder1')
    await flushPromises()
    expect(modelSelect().findAll('option').map(o => o.attributes('value'))).toContain('p-b/model-b')
    expect(modelSelect().findAll('option').map(o => o.attributes('value'))).not.toContain('p-a/model-a')
  })

  it('drops a model selection the new executor cannot run', async () => {
    mockSettingsStore.platforms = { telegram: { token: 'telegram-token' } }
    mockProfilesStore.profiles = [
      { name: 'user_a', kind: 'user', displayLabel: 'sunke' },
      { name: 'coder1', kind: 'agent', agentId: 'agent-1', displayLabel: 'coder1' },
    ]
    mockAppStore.profileModelGroups = [
      { profile: 'user_a', groups: [{ provider: 'p-a', label: 'A', models: ['model-a'] }] },
      { profile: 'coder1', groups: [{ provider: 'p-b', label: 'B', models: ['model-b'] }] },
    ]
    mockJobsStore.createJob.mockResolvedValue({ id: 'job-1' })
    const wrapper = mount(JobFormModal, { props: { jobId: null } })
    await flushPromises()

    await wrapper.find('[data-testid="job-model"] .n-select-stub').setValue('p-a/model-a')
    await wrapper.find('[data-testid="job-executor-agent"] .n-select-stub').setValue('coder1')
    await flushPromises()

    const inputs = wrapper.findAll('.n-input-stub')
    await inputs[0].setValue('X')
    await inputs[1].setValue('0 9 * * *')
    await inputs[2].setValue('p')
    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()

    // The stale selection must not ride along to an executor that cannot run it.
    const payload = mockJobsStore.createJob.mock.calls[0][0]
    expect(payload.model).toBeUndefined()
  })

  it('marks disabled models unselectable and drops a selection disabled under the new executor', async () => {
    mockSettingsStore.platforms = { telegram: { token: 'telegram-token' } }
    mockProfilesStore.profiles = [
      { name: 'user_a', kind: 'user', displayLabel: 'sunke' },
      { name: 'coder1', kind: 'agent', agentId: 'agent-1', displayLabel: 'coder1' },
    ]
    mockAppStore.profileModelGroups = [
      { profile: 'user_a', groups: [{ provider: 'p', label: 'P', models: ['ok-model', 'dead-model'], model_meta: { 'dead-model': { disabled: true } } }] },
      { profile: 'coder1', groups: [{ provider: 'p', label: 'P', models: ['ok-model'], model_meta: { 'ok-model': { disabled: true } } }] },
    ]
    mockJobsStore.createJob.mockResolvedValue({ id: 'job-1' })
    const wrapper = mount(JobFormModal, { props: { jobId: null } })
    await flushPromises()

    const options = wrapper.find('[data-testid="job-model"] .n-select-stub').findAll('option')
    const byValue = Object.fromEntries(options.map(o => [o.attributes('value'), o]))
    expect(byValue['p/dead-model'].attributes('disabled')).toBe('')
    expect(byValue['p/ok-model'].attributes('disabled')).toBeUndefined()

    // Selecting a model that is DISABLED under the next executor must not ride along.
    await wrapper.find('[data-testid="job-model"] .n-select-stub').setValue('p/ok-model')
    await wrapper.find('[data-testid="job-executor-agent"] .n-select-stub').setValue('coder1')
    await flushPromises()

    const inputs = wrapper.findAll('.n-input-stub')
    await inputs[0].setValue('X')
    await inputs[1].setValue('0 9 * * *')
    await inputs[2].setValue('p')
    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()

    expect(mockJobsStore.createJob.mock.calls[0][0].model).toBeUndefined()
  })
})
