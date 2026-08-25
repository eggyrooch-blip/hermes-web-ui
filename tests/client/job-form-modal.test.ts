// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const mockMessage = vi.hoisted(() => ({
  warning: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
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
  profiles: [
    { name: 'default', displayLabel: '默认智能体' },
    { name: 'ops' },
  ] as Array<Record<string, any>>,
  activeProfileName: 'default',
  fetchProfiles: vi.fn(async () => {}),
  switchProfile: vi.fn(async () => {}),
}))

const mockUploadFiles = vi.hoisted(() => vi.fn(async () => [{ name: 'brief.pdf', path: 'uploads/brief.pdf' }]))

const mockAppStore = vi.hoisted(() => ({
  modelGroups: [
    { provider: 'openai', models: ['gpt-5', 'gpt-5-mini'] },
    { provider: 'anthropic', models: ['claude-fable-5', 'gpt-5'] },
  ] as Array<Record<string, any>>,
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

vi.mock('@/api/hermes/files', () => ({ uploadFiles: mockUploadFiles }))

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
    locale: { value: 'zh-CN' },
  }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => mockMessage,
}))

import JobFormModal from '@/components/hermes/jobs/JobFormModal.vue'

function mountModal() {
  return mount(JobFormModal, {
    props: { jobId: null },
    global: { stubs: { teleport: true } },
  })
}

describe('JobFormModal (prototype NewAutoDrawer)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsStore.platforms = {}
    mockAppStore.modelGroups = []
    mockAppStore.profileModelGroups = []
    mockProfilesStore.profiles = [
      { name: 'default', displayLabel: '默认智能体' },
      { name: 'ops' },
    ]
    mockProfilesStore.activeProfileName = 'default'
    mockActiveProfileName.value = 'user_a'
  })

  it('loads platform settings when the store has not been hydrated', async () => {
    mountModal()
    await flushPromises()
    expect(mockSettingsStore.fetchSettings).toHaveBeenCalledOnce()
  })

  it('shows every supported platform channel in the deliver menu with configured state', async () => {
    mockSettingsStore.platforms = {
      telegram: { token: 'telegram-token' },
      whatsapp: { enabled: false },
      qqbot: { extra: { app_id: 'qq-app', client_secret: 'qq-secret' } },
    }
    const wrapper = mountModal()
    await flushPromises()

    expect(mockSettingsStore.fetchSettings).not.toHaveBeenCalled()

    await wrapper.find('[data-testid="af-deliver"]').trigger('click')
    for (const key of ['telegram', 'discord', 'slack', 'whatsapp', 'matrix', 'weixin', 'wecom', 'feishu', 'dingtalk', 'qqbot']) {
      expect(wrapper.find(`[data-testid="af-deliver-${key}"]`).exists()).toBe(true)
    }
    expect(wrapper.find('[data-testid="af-deliver-telegram"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="af-deliver-qqbot"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="af-deliver-discord"]').attributes('disabled')).toBe('')
    expect(wrapper.find('[data-testid="af-deliver-whatsapp"]').attributes('disabled')).toBe('')
  })

  it('creates an interval job with attached skills (default 每 1 小时)', async () => {
    mockSettingsStore.platforms = { telegram: { token: 'telegram-token' } }
    mockJobsStore.createJob.mockResolvedValue({ id: 'job-1' })
    const wrapper = mountModal()
    await flushPromises()

    await wrapper.find('[data-testid="af-name"]').setValue('Daily research')
    await wrapper.find('[data-testid="af-prompt"]').setValue('summarize updates')

    // Attach two skills through the + menu (disabled skills are filtered out).
    // The menu is two-level now, like the composer's AddMenu: level 1 is
    // 添加文件 / 技能 ›, and the skill list is the flyout off the 技能 row.
    await wrapper.find('[data-testid="af-add"]').trigger('click')
    expect(wrapper.find('[data-testid="af-skill-planner"]').exists()).toBe(false)
    await wrapper.find('[data-testid="af-add-skills"]').trigger('mouseenter')
    expect(wrapper.find('[data-testid="af-skill-disabled-skill"]').exists()).toBe(false)
    await wrapper.find('[data-testid="af-skill-planner"]').trigger('click')
    await wrapper.find('[data-testid="af-add"]').trigger('click')
    await wrapper.find('[data-testid="af-add-skills"]').trigger('mouseenter')
    await wrapper.find('[data-testid="af-skill-reviewer"]').trigger('click')

    await wrapper.find('[data-testid="af-create"]').trigger('click')
    await flushPromises()

    expect(mockJobsStore.createJob).toHaveBeenCalledWith({
      name: 'Daily research',
      schedule: '0 * * * *',
      prompt: 'summarize updates',
      deliver: 'origin',
      skills: ['planner', 'reviewer'],
      repeat: undefined,
    })
  })

  it('attaches a file through the + menu by uploading it and writing its workspace path into the prompt', async () => {
    // A job carries no file field — prompt / skills / deliver is all it has — so
    // the only honest "attach a file" is: upload now, reference the path the run
    // broker hands to the tools.
    const wrapper = mountModal()
    await flushPromises()
    await wrapper.find('[data-testid="af-prompt"]').setValue('read this')

    await wrapper.find('[data-testid="af-add"]').trigger('click')
    const fileRow = wrapper.find('[data-testid="af-add-file"]')
    expect(fileRow.exists()).toBe(true)

    // The row opens the OS picker; drive the change event the picker would fire.
    const input = wrapper.find('input[type="file"]')
    Object.defineProperty(input.element, 'files', {
      value: [new File(['x'], 'brief.pdf')],
      configurable: true,
    })
    await input.trigger('change')
    await flushPromises()

    expect(mockUploadFiles).toHaveBeenCalled()
    expect((wrapper.find('[data-testid="af-prompt"]').element as HTMLTextAreaElement).value)
      .toContain('/workspace/uploads/brief.pdf')
  })

  it('states where the job runs without pretending it is a picker', async () => {
    // The composer's pill is a status statement; this one says the same thing in
    // the same words, and the deliver TARGET moved out to its own form field.
    const wrapper = mountModal()
    await flushPromises()

    const scope = wrapper.find('[data-testid="af-scope"]')
    expect(scope.exists()).toBe(true)
    expect(scope.element.tagName).toBe('SPAN')
    // The deliver trigger is no longer inside the prompt box.
    const box = wrapper.find('.chat-input-area')
    expect(box.find('[data-testid="af-deliver"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="af-deliver"]').exists()).toBe(true)
  })

  it('sends a picked model on the create payload, with no follow-up update', async () => {
    // Set the catalog HERE: beforeEach clears it, so relying on another test to
    // have populated it makes this pass or fail by execution order.
    mockAppStore.modelGroups = [
      { provider: 'openai', models: ['gpt-5', 'gpt-5-mini'] },
      { provider: 'anthropic', models: ['claude-fable-5', 'gpt-5'] },
    ]
    mockJobsStore.createJob.mockResolvedValue({ job_id: 'job-9' })
    mockJobsStore.updateJob.mockResolvedValue({ job_id: 'job-9' })
    const wrapper = mountModal()
    await flushPromises()

    await wrapper.find('[data-testid="af-name"]').setValue('Model job')
    await wrapper.find('[data-testid="af-prompt"]').setValue('do work')

    await wrapper.find('[data-testid="af-model"]').trigger('click')
    // Provider-qualified: the same bare name under two providers is two
    // DIFFERENT models, so both are offered — and a bare 'gpt-5' is a spec the
    // run could not resolve at all.
    expect(wrapper.find('[data-testid="af-model-openai/gpt-5"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="af-model-anthropic/gpt-5"]').exists()).toBe(true)
    await wrapper.find('[data-testid="af-model-anthropic/claude-fable-5"]').trigger('click')
    expect(wrapper.find('[data-testid="af-model"]').text()).toContain('claude-fable-5')

    await wrapper.find('[data-testid="af-create"]').trigger('click')
    await flushPromises()

    // create accepts `model` — no follow-up update, and none is fired.
    expect(mockJobsStore.createJob.mock.calls[0][0].model).toBe('anthropic/claude-fable-5')
    expect(mockJobsStore.updateJob).not.toHaveBeenCalled()
  })

  it('defaults the executor pill to the caller and never switches the sidebar', async () => {
    mockProfilesStore.profiles = [
      { name: 'user_a', kind: 'user', displayLabel: 'sunke' },
      { name: 'ops', kind: 'agent', agentId: 'agent-ops', displayLabel: 'ops' },
    ]
    const wrapper = mountModal()
    await flushPromises()

    // Defaults to the caller's own profile — the executor is REQUIRED, so there
    // is nothing for a placeholder to mean.
    expect(wrapper.find('[data-testid="af-agent"]').text()).toContain('sunke')

    await wrapper.find('[data-testid="af-agent"]').trigger('click')
    await wrapper.find('[data-testid="af-agent-ops"]').trigger('click')
    await flushPromises()
    // Picking an executor is a per-job choice carried on the request; switching
    // the whole app's profile as a side effect is the bug this pins shut.
    expect(mockProfilesStore.switchProfile).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="af-agent"]').text()).toContain('ops')
  })

  it('attaches a skill from the slash panel and clears the prompt', async () => {
    const wrapper = mountModal()
    await flushPromises()

    await wrapper.find('[data-testid="af-prompt"]').setValue('/plan')
    expect(wrapper.find('[data-testid="af-slash-planner"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="af-slash-reviewer"]').exists()).toBe(false)

    await wrapper.find('[data-testid="af-slash-planner"]').trigger('click')
    expect(wrapper.find('[data-testid="af-attach-planner"]').exists()).toBe(true)
    expect((wrapper.find('[data-testid="af-prompt"]').element as HTMLTextAreaElement).value).toBe('')
  })

  it('builds a weekly cron and keeps 创建 disabled until a time is picked', async () => {
    mockJobsStore.createJob.mockResolvedValue({ id: 'job-2' })
    const wrapper = mountModal()
    await flushPromises()

    await wrapper.find('[data-testid="af-name"]').setValue('Weekly digest')
    await wrapper.find('[data-testid="af-prompt"]').setValue('weekly summary')
    await wrapper.find('[data-testid="af-trigger-type"]').setValue('weekly')

    // No time yet — the primary button is disabled.
    expect(wrapper.find('[data-testid="af-create"]').attributes('disabled')).toBe('')

    await wrapper.find('[data-testid="af-time"]').trigger('click')
    const cols = wrapper.findAll('.af-time-col')
    await cols[0].findAll('.af-time-item')[9].trigger('click') // 09
    await cols[1].findAll('.af-time-item')[30].trigger('click') // :30
    await wrapper.find('[data-testid="af-weekday-3"]').trigger('click') // 周四

    expect(wrapper.find('[data-testid="af-create"]').attributes('disabled')).toBeUndefined()
    await wrapper.find('[data-testid="af-create"]').trigger('click')
    await flushPromises()

    expect(mockJobsStore.createJob).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Weekly digest',
      schedule: '30 9 * * 4',
    }))
  })

  const rosterProfiles = [
    { name: 'user_a', kind: 'user', displayLabel: 'sunke' },
    { name: 'coder1', kind: 'agent', agentId: 'agent-1', displayLabel: 'coder1' },
    { name: 'shared_agent', kind: 'agent', agentId: 'agent-2', shareRole: 'editor', displayLabel: '别人的' },
    { name: 'feishu_group_x', kind: 'group', displayLabel: 'KippiesWork讨论' },
  ]

  // 执行者 (sunke 2026-08-17 ruling, re-wired onto the Keep sheet 2026-08-21):
  // the executor AGENT is required and defaults to the caller's own profile;
  // the EXPERT is optional and comes from the SELECTED agent's catalog. The
  // controls are the sheet's context-bar pills, not the old NSelect form rows,
  // so these assertions drive af-agent / af-expert / af-model.
  async function openSheet() {
    mockSettingsStore.platforms = { telegram: { token: 'telegram-token' } }
    const wrapper = mount(JobFormModal, {
      props: { jobId: null },
      global: { stubs: { teleport: true } },
    })
    await flushPromises()
    return wrapper
  }

  async function fillRequiredAndCreate(wrapper: any) {
    // Default trigger is 间隔触发 每 1 小时, so the schedule needs no input.
    await wrapper.find('[data-testid="af-name"]').setValue('Daily research')
    await wrapper.find('[data-testid="af-prompt"]').setValue('summarize updates')
    await wrapper.find('[data-testid="af-create"]').trigger('click')
    await flushPromises()
  }

  async function pickAgent(wrapper: any, profile: string) {
    await wrapper.find('[data-testid="af-agent"]').trigger('click')
    await wrapper.find(`[data-testid="af-agent-${profile}"]`).trigger('click')
    await flushPromises()
  }

  async function pickExpert(wrapper: any, expertId: string) {
    await wrapper.find('[data-testid="af-expert"]').trigger('click')
    await wrapper.find(`[data-testid="af-expert-${expertId}"]`).trigger('click')
    await flushPromises()
  }

  it('takes the 跟随默认 model label from i18n, not a hardcoded "Auto"', async () => {
    mockAppStore.modelGroups = [{ provider: 'openai', models: ['gpt-5'] }]
    const wrapper = mountModal()
    await flushPromises()

    // The chip's resting state and the menu's first row both mean "follow the
    // profile default" — a literal 'Auto' there is invisible to all ten locales.
    expect(wrapper.find('[data-testid="af-model"]').text()).toContain('jobs.modelFollowDefault')
    await wrapper.find('[data-testid="af-model"]').trigger('click')
    expect(wrapper.find('[data-testid="af-model-auto"]').text()).toContain('jobs.modelFollowDefault')
    expect(wrapper.find('[data-testid="af-model"]').text()).not.toContain('Auto')
  })

  it('agent menu mirrors the Agents hub roster (mine + groups, shared excluded)', async () => {
    mockProfilesStore.profiles = [...rosterProfiles]
    const wrapper = await openSheet()

    // The expert catalog preloads for the DEFAULT agent (= own profile),
    // requested EXPLICITLY so a sidebar profile switch cannot retarget it.
    expect(mockFetchExperts).toHaveBeenCalledTimes(1)
    expect(mockFetchExperts).toHaveBeenCalledWith('user_a')

    await wrapper.find('[data-testid="af-agent"]').trigger('click')
    expect(wrapper.find('[data-testid="af-agent-user_a"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="af-agent-coder1"]').exists()).toBe(true)
    // Group rows carry the Agents-page group NAME, never the raw ou_/oc_ id.
    expect(wrapper.find('[data-testid="af-agent-feishu_group_x"]').text()).toContain('KippiesWork讨论')
    // Shared-with-me stays out: the BFF profile resolver only honors owned.
    expect(wrapper.find('[data-testid="af-agent-shared_agent"]').exists()).toBe(false)
  })

  it("switching agents reloads that agent's expert catalog and drops the old pick", async () => {
    mockProfilesStore.profiles = [...rosterProfiles]
    const wrapper = await openSheet()
    await pickExpert(wrapper, 'hr-expert')
    expect(wrapper.find('[data-testid="af-expert"]').text()).toContain('HR 专家')

    await pickAgent(wrapper, 'coder1')

    expect(mockFetchExperts).toHaveBeenLastCalledWith('coder1')
    // The previous agent's expert must not survive the switch.
    expect(wrapper.find('[data-testid="af-expert"]').text()).not.toContain('HR 专家')
  })

  it('agent-only choice submits with the profile override and no expert_id', async () => {
    mockProfilesStore.profiles = [...rosterProfiles]
    const wrapper = await openSheet()
    await pickAgent(wrapper, 'coder1')
    await fillRequiredAndCreate(wrapper)

    expect(mockJobsStore.createJob).toHaveBeenCalledTimes(1)
    const [payload, options] = mockJobsStore.createJob.mock.calls[0]
    expect(options).toEqual({ profile: 'coder1' })
    expect(payload.expert_id).toBeUndefined()
  })

  it('default own agent with no expert keeps the legacy single-argument request', async () => {
    mockProfilesStore.profiles = [...rosterProfiles]
    const wrapper = await openSheet()
    await fillRequiredAndCreate(wrapper)

    expect(mockJobsStore.createJob).toHaveBeenCalledTimes(1)
    const [payload, options] = mockJobsStore.createJob.mock.calls[0]
    expect(options).toBeUndefined()
    expect(payload.expert_id).toBeUndefined()
    expect(payload.model).toBeUndefined()
  })

  it('own agent + expert submits expert_id with the legacy single-argument call', async () => {
    mockProfilesStore.profiles = [...rosterProfiles]
    const wrapper = await openSheet()
    await pickExpert(wrapper, 'it-expert')
    await fillRequiredAndCreate(wrapper)

    const [payload, options] = mockJobsStore.createJob.mock.calls[0]
    expect(options).toBeUndefined()
    expect(payload.expert_id).toBe('it-expert')
  })

  it("another agent + that agent's expert submits both the override and expert_id", async () => {
    mockProfilesStore.profiles = [...rosterProfiles]
    const wrapper = await openSheet()
    await pickAgent(wrapper, 'coder1')
    await pickExpert(wrapper, 'hr-expert')
    await fillRequiredAndCreate(wrapper)

    const [payload, options] = mockJobsStore.createJob.mock.calls[0]
    expect(options).toEqual({ profile: 'coder1' })
    expect(payload.expert_id).toBe('hr-expert')
  })

  it('a sidebar profile switch while the sheet is open cannot hijack the executor', async () => {
    mockProfilesStore.profiles = [...rosterProfiles]
    const wrapper = await openSheet()
    await pickAgent(wrapper, 'coder1')

    // The sidebar moves on to another profile mid-edit.
    mockActiveProfileName.value = 'someone_else'
    await fillRequiredAndCreate(wrapper)

    const [, options] = mockJobsStore.createJob.mock.calls[0]
    expect(options).toEqual({ profile: 'coder1' })
  })

  it('a blank executor is rejected: no create call ever fires', async () => {
    mockProfilesStore.profiles = [...rosterProfiles]
    mockActiveProfileName.value = null
    const wrapper = await openSheet()
    await fillRequiredAndCreate(wrapper)

    expect(mockJobsStore.createJob).not.toHaveBeenCalled()
  })

  it("offers the selected executor's own model catalog, not another profile's", async () => {
    mockProfilesStore.profiles = [...rosterProfiles]
    mockAppStore.profileModelGroups = [
      { profile: 'user_a', groups: [{ provider: 'openai', label: 'OpenAI', models: ['gpt-5'] }] },
      { profile: 'coder1', groups: [{ provider: 'anthropic', label: 'Anthropic', models: ['claude-fable-5'] }] },
    ]
    const wrapper = await openSheet()

    await wrapper.find('[data-testid="af-model"]').trigger('click')
    expect(wrapper.find('[data-testid="af-model-openai/gpt-5"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="af-model-anthropic/claude-fable-5"]').exists()).toBe(false)

    // The chip is a toggle and the menu is still open (agent/model menus are
    // independent state) — clicking it again here would close it.
    await pickAgent(wrapper, 'coder1')
    expect(wrapper.find('[data-testid="af-model-anthropic/claude-fable-5"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="af-model-openai/gpt-5"]').exists()).toBe(false)
  })

  it('sends the selected model spec on create', async () => {
    mockProfilesStore.profiles = [...rosterProfiles]
    mockAppStore.profileModelGroups = [
      { profile: 'user_a', groups: [{ provider: 'openai', label: 'OpenAI', models: ['gpt-5'] }] },
    ]
    const wrapper = await openSheet()

    await wrapper.find('[data-testid="af-model"]').trigger('click')
    await wrapper.find('[data-testid="af-model-openai/gpt-5"]').trigger('click')
    await fillRequiredAndCreate(wrapper)

    expect(mockJobsStore.createJob.mock.calls[0][0].model).toBe('openai/gpt-5')
  })

  it('never double-prefixes a model id that is already provider-qualified', async () => {
    mockProfilesStore.profiles = [...rosterProfiles]
    mockAppStore.profileModelGroups = [
      {
        profile: 'user_a',
        groups: [{ provider: 'custom:litellm-sre', label: 'LiteLLM', models: ['custom:litellm-sre/tencent-sonnet-4-6'] }],
      },
    ]
    const wrapper = await openSheet()

    await wrapper.find('[data-testid="af-model"]').trigger('click')
    expect(wrapper.find('[data-testid="af-model-custom:litellm-sre/tencent-sonnet-4-6"]').exists()).toBe(true)
  })

  it('leaves disabled models out and drops a pick the new executor cannot run', async () => {
    mockProfilesStore.profiles = [...rosterProfiles]
    mockAppStore.profileModelGroups = [
      {
        profile: 'user_a',
        groups: [{
          provider: 'p',
          label: 'P',
          models: ['ok-model', 'dead-model'],
          model_meta: { 'dead-model': { disabled: true } },
        }],
      },
      { profile: 'coder1', groups: [{ provider: 'q', label: 'Q', models: ['other'] }] },
    ]
    const wrapper = await openSheet()

    await wrapper.find('[data-testid="af-model"]').trigger('click')
    // A disabled model would fail (or silently fall back) on a scheduled run.
    expect(wrapper.find('[data-testid="af-model-p/dead-model"]').exists()).toBe(false)
    await wrapper.find('[data-testid="af-model-p/ok-model"]').trigger('click')

    // The new executor has no p/ok-model, so the selection must not ride along.
    await pickAgent(wrapper, 'coder1')
    await fillRequiredAndCreate(wrapper)
    expect(mockJobsStore.createJob.mock.calls[0][0].model).toBeUndefined()
  })
})
