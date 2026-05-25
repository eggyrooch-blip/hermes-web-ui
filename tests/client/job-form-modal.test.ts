// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

const messageMock = vi.hoisted(() => ({
  warning: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

const settingsStoreMock = vi.hoisted(() => ({
  platforms: {} as Record<string, any>,
  fetchSettings: vi.fn(async () => {
    settingsStoreMock.platforms = {
      telegram: { token: 'telegram-token' },
      whatsapp: { enabled: true },
      qqbot: { extra: { app_id: 'qq-app', client_secret: 'qq-secret' } },
    }
  }),
}))

const jobsStoreMock = vi.hoisted(() => ({
  createJob: vi.fn(),
  updateJob: vi.fn(),
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => settingsStoreMock,
}))

vi.mock('@/stores/hermes/jobs', () => ({
  useJobsStore: () => jobsStoreMock,
}))

vi.mock('@/api/hermes/jobs', async () => {
  const actual = await vi.importActual<any>('@/api/hermes/jobs')
  return {
    ...actual,
    getJob: vi.fn(),
  }
})

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
    props: { value: { required: false }, options: { type: Array, default: () => [] } },
    emits: ['update:value'],
    template: '<select class="n-select-stub"><option v-for="option in options" :key="option.value" :value="option.value" :disabled="option.disabled">{{ option.label }}</option></select>',
  }),
  NButton: defineComponent({
    emits: ['click'],
    template: '<button class="n-button-stub" @click.prevent="$emit(\'click\')"><slot /></button>',
  }),
  useMessage: () => messageMock,
}))

import JobFormModal from '@/components/hermes/jobs/JobFormModal.vue'

describe('JobFormModal deliver targets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settingsStoreMock.platforms = {}
  })

  it('loads platform settings when the settings store has not been hydrated', async () => {
    mount(JobFormModal, {
      props: { jobId: null },
    })

    await flushPromises()

    expect(settingsStoreMock.fetchSettings).toHaveBeenCalledOnce()
  })

  it('shows every supported platform target and disables unconfigured channels', async () => {
    settingsStoreMock.platforms = {
      telegram: { token: 'telegram-token' },
      whatsapp: { enabled: false },
      qqbot: { extra: { app_id: 'qq-app', client_secret: 'qq-secret' } },
    }
    const wrapper = mount(JobFormModal, {
      props: { jobId: null },
    })

    await flushPromises()

    expect(settingsStoreMock.fetchSettings).not.toHaveBeenCalled()
    const deliverSelect = wrapper.findAll('.n-select-stub')[1]
    expect(deliverSelect.text()).toContain('jobs.feishu')
    expect(deliverSelect.text()).toContain('jobs.local')
    expect(deliverSelect.text()).toContain('Telegram')
    expect(deliverSelect.text()).toContain('Discord')
    expect(deliverSelect.text()).toContain('Slack')
    expect(deliverSelect.text()).toContain('WhatsApp')
    expect(deliverSelect.text()).toContain('Matrix')
    expect(deliverSelect.text()).toContain('WeChat')
    expect(deliverSelect.text()).toContain('WeCom')
    expect(deliverSelect.text()).toContain('DingTalk')
    expect(deliverSelect.text()).toContain('QQBot')

    const options = deliverSelect.findAll('option')
    const optionByValue = Object.fromEntries(options.map(option => [option.attributes('value'), option]))
    expect(optionByValue.telegram.attributes('disabled')).toBeUndefined()
    expect(optionByValue.qqbot.attributes('disabled')).toBeUndefined()
    expect(optionByValue.discord.attributes('disabled')).toBe('')
    expect(optionByValue.whatsapp.attributes('disabled')).toBe('')
  })
})
