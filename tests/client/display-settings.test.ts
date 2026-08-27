// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
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
  },
  saveSection: vi.fn().mockResolvedValue(undefined),
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
          NSwitch: true,
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
})
