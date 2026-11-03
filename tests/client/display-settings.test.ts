// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { CHAT_INPUT_HEIGHT_DEFAULT, CHAT_INPUT_HEIGHT_MAX, CHAT_INPUT_HEIGHT_MIN } from '@/utils/chat-input-height'

const mockSettingsStore = vi.hoisted(() => ({
  display: {
    streaming: true,
    compact: false,
    show_reasoning: true,
    show_cost: false,
    inline_diffs: true,
    bell_on_complete: false,
    notify_on_complete: false,
    busy_input_mode: 'interrupt',
  } as Record<string, unknown>,
  saveSection: vi.fn().mockResolvedValue(undefined),
}))

const notificationMocks = vi.hoisted(() => ({
  requestPermission: vi.fn(),
  showSystem: vi.fn(),
  showCompletion: vi.fn(),
}))

vi.mock('@/utils/completion-notification', () => ({
  requestCompletionNotificationPermission: notificationMocks.requestPermission,
  showSystemNotification: notificationMocks.showSystem,
  showCompletionNotification: notificationMocks.showCompletion,
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => mockSettingsStore,
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({
    brightness: 'system',
    setBrightness: vi.fn(),
  }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<any>('naive-ui')
  return {
    ...actual,
    NSwitch: {
      name: 'NSwitch',
      inheritAttrs: false,
      props: ['value'],
      emits: ['update:value'],
      template: '<span class="n-switch-stub" :data-on="String(value)" />',
    },
    NInputNumber: {
      name: 'NInputNumber',
      inheritAttrs: false,
      props: ['value', 'min', 'max'],
      emits: ['update:value'],
      template: '<input class="n-input-number-stub" :value="value" />',
    },
    useMessage: () => ({
      success: vi.fn(),
      error: vi.fn(),
    }),
  }
})

import DisplaySettings from '@/components/hermes/settings/DisplaySettings.vue'

describe('DisplaySettings', () => {
  beforeEach(() => {
    mockSettingsStore.display = {
      streaming: true,
      compact: false,
      show_reasoning: true,
      show_cost: false,
      inline_diffs: true,
      bell_on_complete: false,
      notify_on_complete: false,
      busy_input_mode: 'interrupt',
    }
    mockSettingsStore.saveSection.mockClear()
    notificationMocks.requestPermission.mockReset()
    notificationMocks.requestPermission.mockResolvedValue({ granted: true })
    notificationMocks.showSystem.mockReset()
    notificationMocks.showSystem.mockResolvedValue(true)
    notificationMocks.showCompletion.mockReset()
    notificationMocks.showCompletion.mockResolvedValue(true)
  })

  function mountDisplaySettings() {
    return mount(DisplaySettings, {
      global: {
        stubs: {
          SettingRow: {
            props: ['label', 'hint'],
            template: '<div class="setting-row"><div class="setting-row-label">{{ label }}</div><div class="setting-row-hint">{{ hint }}</div><slot /></div>',
          },
          NSelect: true,
        },
      },
    })
  }

  it('does not expose the unwired busy input mode toggle', () => {
    const wrapper = mountDisplaySettings()

    expect(wrapper.text()).not.toContain('settings.display.busyInputMode')
    expect(wrapper.text()).not.toContain('settings.display.busyInputModeHint')
  })

  it('saves a clamped chat input height from display settings', async () => {
    mockSettingsStore.display.chat_input_height = 144
    const wrapper = mountDisplaySettings()
    const input = wrapper.getComponent({ name: 'NInputNumber' })

    expect(wrapper.text()).toContain('settings.display.chatInputHeight')
    expect(input.props('value')).toBe(144)
    expect(input.props('min')).toBe(CHAT_INPUT_HEIGHT_MIN)
    expect(input.props('max')).toBe(CHAT_INPUT_HEIGHT_MAX)

    await input.vm.$emit('update:value', CHAT_INPUT_HEIGHT_MAX + 25)

    expect(mockSettingsStore.saveSection).toHaveBeenCalledWith('display', {
      chat_input_height: CHAT_INPUT_HEIGHT_MAX,
    })
  })

  it('uses the default chat input height when the setting is missing', () => {
    const wrapper = mountDisplaySettings()
    const input = wrapper.getComponent({ name: 'NInputNumber' })

    expect(input.props('value')).toBe(CHAT_INPUT_HEIGHT_DEFAULT)
  })

  function approvalRow(wrapper: ReturnType<typeof mountDisplaySettings>) {
    const row = wrapper.findAll('.setting-row')
      .find(candidate => candidate.text().includes('settings.display.notifyOnApproval'))
    if (!row) throw new Error('Approval Notification row not rendered')
    return row
  }

  it('renders the approval notification switch as on when the setting has never been saved', () => {
    const wrapper = mountDisplaySettings()
    const toggle = approvalRow(wrapper).getComponent({ name: 'NSwitch' })

    // Default ON: an absent `notify_on_approval` must not read as off.
    expect(toggle.props('value')).toBe(true)
  })

  it('saves notify_on_approval and only asks for permission when the switch is turned on', async () => {
    const wrapper = mountDisplaySettings()
    const toggle = approvalRow(wrapper).getComponent({ name: 'NSwitch' })

    // Mounting the settings page must never prompt for notification permission.
    expect(notificationMocks.requestPermission).not.toHaveBeenCalled()

    await toggle.vm.$emit('update:value', false)
    await flushPromises()

    expect(mockSettingsStore.saveSection).toHaveBeenCalledWith('display', { notify_on_approval: false })
    // Turning it OFF needs no permission.
    expect(notificationMocks.requestPermission).not.toHaveBeenCalled()

    mockSettingsStore.display.notify_on_approval = false
    await toggle.vm.$emit('update:value', true)
    await flushPromises()

    expect(notificationMocks.requestPermission).toHaveBeenCalledTimes(1)
    expect(mockSettingsStore.saveSection).toHaveBeenCalledWith('display', { notify_on_approval: true })
  })

  it('does not save the switch when the browser refuses notification permission', async () => {
    notificationMocks.requestPermission.mockResolvedValue({ granted: false, reason: 'denied' })
    mockSettingsStore.display.notify_on_approval = false
    const wrapper = mountDisplaySettings()
    const toggle = approvalRow(wrapper).getComponent({ name: 'NSwitch' })

    await toggle.vm.$emit('update:value', true)
    await flushPromises()

    expect(notificationMocks.requestPermission).toHaveBeenCalledTimes(1)
    expect(mockSettingsStore.saveSection).not.toHaveBeenCalled()
  })

  it('asks for permission and sends a notification from the Test button without saving', async () => {
    const wrapper = mountDisplaySettings()
    const button = approvalRow(wrapper).findAll('button').find(el => el.text().includes('notifyOnApprovalTestButton'))
    if (!button) throw new Error('Approval Notification test button not rendered')

    await button.trigger('click')
    await flushPromises()

    expect(notificationMocks.requestPermission).toHaveBeenCalledTimes(1)
    expect(notificationMocks.showSystem).toHaveBeenCalledTimes(1)
    expect(mockSettingsStore.saveSection).not.toHaveBeenCalled()
  })
})
