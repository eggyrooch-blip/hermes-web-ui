// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

import {
  buildScheduleExpression,
  DEFAULT_SCHEDULE_FREQUENCY_FIELDS,
  parseScheduleExpression,
  scheduleWeekdayOptions,
} from '@/utils/schedule-frequency'

const mockMessage = vi.hoisted(() => ({
  warning: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

const mockSettingsStore = vi.hoisted(() => ({
  platforms: { telegram: { token: 'telegram-token' } } as Record<string, any>,
  fetchSettings: vi.fn(async () => {}),
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

const mockGetJob = vi.hoisted(() => vi.fn())

vi.mock('@/stores/hermes/settings', () => ({ useSettingsStore: () => mockSettingsStore }))
vi.mock('@/stores/hermes/jobs', () => ({ useJobsStore: () => mockJobsStore }))
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => mockProfilesStore }))
vi.mock('@/stores/hermes/app', () => ({ useAppStore: () => mockAppStore }))
vi.mock('@/api/hermes/experts', () => ({ fetchExperts: vi.fn(async () => ({ experts: [] })) }))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'user_a' }))
vi.mock('@/api/hermes/skills', () => ({ fetchSkills: vi.fn(async () => ({ categories: [], archived: [] })) }))

vi.mock('@/api/hermes/jobs', async () => {
  const actual = await vi.importActual<any>('@/api/hermes/jobs')
  return { ...actual, getJob: mockGetJob }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: { value: 'en' },
  }),
}))

vi.mock('naive-ui', () => ({
  NModal: defineComponent({ template: '<div class="n-modal-stub"><slot /><slot name="footer" /></div>' }),
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

const NAME_INPUT = 0
const SCHEDULE_INPUT = 1
const PROMPT_INPUT = 2

function frequencySelect(wrapper: any) {
  return wrapper.find('[data-testid="job-schedule-frequency"] .n-select-stub')
}

// The NSelect stub renders a bare <select>, so a testid put on the component
// lands on that element itself rather than on a wrapper around it.
function hourSelect(wrapper: any) {
  return wrapper.find('[data-testid="job-schedule-hour"]')
}

function timeMinuteSelect(wrapper: any) {
  return wrapper.find('[data-testid="job-schedule-time-minute"]')
}

function scheduleInput(wrapper: any) {
  return wrapper.findAll('.n-input-stub')[SCHEDULE_INPUT]
}

function scheduleValue(wrapper: any): string {
  return (scheduleInput(wrapper).element as HTMLInputElement).value
}

async function mountForm(props: Record<string, unknown> = { jobId: null }) {
  const wrapper = mount(JobFormModal, { props: props as any })
  await flushPromises()
  return wrapper
}

async function fillRequiredCopy(wrapper: any) {
  const inputs = wrapper.findAll('.n-input-stub')
  await inputs[NAME_INPUT].setValue('Daily digest')
  await inputs[PROMPT_INPUT].setValue('summarize updates')
}

async function submit(wrapper: any) {
  await wrapper.findAll('.n-button-stub')[1].trigger('click')
  await flushPromises()
}

describe('schedule frequency to Cron translation', () => {
  it('builds the documented expression for every non-custom frequency', () => {
    const base = { ...DEFAULT_SCHEDULE_FREQUENCY_FIELDS, hour: 14, minute: 30, weekday: 3, monthDay: 17 }
    expect(buildScheduleExpression({ ...base, frequency: 'every-minute' })).toBe('* * * * *')
    expect(buildScheduleExpression({ ...base, frequency: 'every-5-minutes' })).toBe('*/5 * * * *')
    expect(buildScheduleExpression({ ...base, frequency: 'every-30-minutes' })).toBe('*/30 * * * *')
    expect(buildScheduleExpression({ ...base, frequency: 'hourly' })).toBe('30 * * * *')
    expect(buildScheduleExpression({ ...base, frequency: 'daily' })).toBe('30 14 * * *')
    expect(buildScheduleExpression({ ...base, frequency: 'weekly' })).toBe('30 14 * * 3')
    expect(buildScheduleExpression({ ...base, frequency: 'monthly' })).toBe('30 14 17 * *')
  })

  it('never invents an expression for custom, so the operator must type one', () => {
    expect(buildScheduleExpression({ ...DEFAULT_SCHEDULE_FREQUENCY_FIELDS, frequency: 'custom' })).toBe('')
  })

  it('round-trips a generated expression back to the same fields', () => {
    for (const frequency of ['every-minute', 'every-5-minutes', 'every-30-minutes', 'hourly', 'daily', 'weekly', 'monthly'] as const) {
      const fields = { ...DEFAULT_SCHEDULE_FREQUENCY_FIELDS, frequency, hour: 14, minute: 30, weekday: 3, monthDay: 17 }
      const parsed = parseScheduleExpression(buildScheduleExpression(fields))
      expect(parsed.frequency, frequency).toBe(frequency)
    }
    expect(parseScheduleExpression('30 14 * * *')).toMatchObject({ frequency: 'daily', hour: 14, minute: 30 })
    expect(parseScheduleExpression('30 14 * * 3')).toMatchObject({ frequency: 'weekly', weekday: 3 })
    expect(parseScheduleExpression('30 14 17 * *')).toMatchObject({ frequency: 'monthly', monthDay: 17 })
  })

  it('resolves shorthand aliases instead of treating them as custom', () => {
    expect(parseScheduleExpression('@hourly').frequency).toBe('hourly')
    expect(parseScheduleExpression('@daily')).toMatchObject({ frequency: 'daily', hour: 0, minute: 0 })
    expect(parseScheduleExpression('@weekly')).toMatchObject({ frequency: 'weekly', weekday: 0 })
    expect(parseScheduleExpression('@monthly')).toMatchObject({ frequency: 'monthly', monthDay: 1 })
  })

  it('falls back to custom for expressions the visual controls cannot represent', () => {
    for (const expression of ['', 'nonsense', '0 9 * *', '0 9 * * * *', '0 9 1 6 1', '*/7 9 * * *', '99 9 * * *']) {
      expect(parseScheduleExpression(expression).frequency, expression).toBe('custom')
    }
  })

  it('orders weekday options so index 0 is Sunday, matching the Cron field', () => {
    const options = scheduleWeekdayOptions('en-US')
    expect(options).toHaveLength(7)
    expect(options[0]).toMatchObject({ label: 'Sunday', value: 0 })
    expect(options[6]).toMatchObject({ label: 'Saturday', value: 6 })
  })
})

describe('JobFormModal requires an explicit Cron expression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsStore.platforms = { telegram: { token: 'telegram-token' } }
    mockJobsStore.createJob.mockResolvedValue({ id: 'job-1' })
  })

  it('starts with no frequency chosen and an empty Cron field', async () => {
    const wrapper = await mountForm()

    expect(scheduleValue(wrapper)).toBe('')
    // No frequency picked yet, so none of the frequency-specific fields render.
    expect(hourSelect(wrapper).exists()).toBe(false)
    expect(wrapper.find('[data-testid="job-schedule-weekday"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="job-schedule-month-day"]').exists()).toBe(false)
  })

  it('refuses to save while the Cron field is empty', async () => {
    const wrapper = await mountForm()
    await fillRequiredCopy(wrapper)

    await submit(wrapper)

    expect(mockMessage.warning).toHaveBeenCalledWith('jobs.scheduleRequired')
    expect(mockJobsStore.createJob).not.toHaveBeenCalled()
  })

  it('refuses to save when the Cron field holds only whitespace', async () => {
    const wrapper = await mountForm()
    await fillRequiredCopy(wrapper)
    await scheduleInput(wrapper).setValue('   ')

    await submit(wrapper)

    expect(mockMessage.warning).toHaveBeenCalledWith('jobs.scheduleRequired')
    expect(mockJobsStore.createJob).not.toHaveBeenCalled()
  })

  it('writes the chosen frequency into the visible Cron field and saves it', async () => {
    const wrapper = await mountForm()
    await fillRequiredCopy(wrapper)
    await frequencySelect(wrapper).setValue('daily')
    await flushPromises()

    expect(scheduleValue(wrapper)).toBe('0 9 * * *')

    await submit(wrapper)

    expect(mockJobsStore.createJob).toHaveBeenCalledWith(expect.objectContaining({ schedule: '0 9 * * *' }))
  })

  it('regenerates the expression when the hour and minute change', async () => {
    const wrapper = await mountForm()
    await frequencySelect(wrapper).setValue('daily')
    await flushPromises()

    await hourSelect(wrapper).setValue('14')
    await flushPromises()
    await timeMinuteSelect(wrapper).setValue('30')
    await flushPromises()

    expect(scheduleValue(wrapper)).toBe('30 14 * * *')
  })

  it('exposes a weekday picker for weekly and a day picker for monthly', async () => {
    const wrapper = await mountForm()

    await frequencySelect(wrapper).setValue('weekly')
    await flushPromises()
    expect(wrapper.find('[data-testid="job-schedule-weekday"]').exists()).toBe(true)
    await wrapper.find('[data-testid="job-schedule-weekday"] .n-select-stub').setValue('3')
    await flushPromises()
    expect(scheduleValue(wrapper)).toBe('0 9 * * 3')

    await frequencySelect(wrapper).setValue('monthly')
    await flushPromises()
    expect(wrapper.find('[data-testid="job-schedule-month-day"]').exists()).toBe(true)
    await wrapper.find('[data-testid="job-schedule-month-day"] .n-select-stub').setValue('17')
    await flushPromises()
    expect(scheduleValue(wrapper)).toBe('0 9 17 * *')
  })

  it('clears the expression when the operator picks custom, so nothing is inherited', async () => {
    const wrapper = await mountForm()
    await fillRequiredCopy(wrapper)
    await frequencySelect(wrapper).setValue('daily')
    await flushPromises()
    expect(scheduleValue(wrapper)).toBe('0 9 * * *')

    await frequencySelect(wrapper).setValue('custom')
    await flushPromises()

    expect(scheduleValue(wrapper)).toBe('')
    await submit(wrapper)
    expect(mockMessage.warning).toHaveBeenCalledWith('jobs.scheduleRequired')
    expect(mockJobsStore.createJob).not.toHaveBeenCalled()
  })

  it('saves a hand-typed expression and stops the time controls from overwriting it', async () => {
    const wrapper = await mountForm()
    await fillRequiredCopy(wrapper)
    await frequencySelect(wrapper).setValue('daily')
    await flushPromises()
    await scheduleInput(wrapper).setValue('15 3 */2 * 1-5')
    await flushPromises()

    // A hand-typed expression the pickers cannot produce switches to custom,
    // so their inputs disappear and cannot clobber it.
    expect(hourSelect(wrapper).exists()).toBe(false)
    expect(scheduleValue(wrapper)).toBe('15 3 */2 * 1-5')

    await submit(wrapper)

    expect(mockJobsStore.createJob).toHaveBeenCalledWith(expect.objectContaining({ schedule: '15 3 */2 * 1-5' }))
  })

  it('prefills the frequency controls from a saved job instead of showing a blank picker', async () => {
    mockGetJob.mockResolvedValue({
      id: 'job-7',
      name: 'Weekly report',
      schedule: '30 14 * * 3',
      schedule_display: '30 14 * * 3',
      prompt: 'write the report',
      deliver: 'origin',
      skills: [],
      repeat: null,
    })

    const wrapper = await mountForm({ jobId: 'job-7' })

    expect(scheduleValue(wrapper)).toBe('30 14 * * 3')
    // Weekly is what the stored expression parses to, so its pickers render.
    expect(wrapper.find('[data-testid="job-schedule-weekday"]').exists()).toBe(true)
    expect(hourSelect(wrapper).exists()).toBe(true)
    expect(wrapper.find('[data-testid="job-schedule-month-day"]').exists()).toBe(false)
  })
})
