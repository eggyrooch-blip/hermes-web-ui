// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const isUserModeMock = vi.hoisted(() => vi.fn(() => false))
const saveSectionMock = vi.hoisted(() => vi.fn())
const setBrightnessMock = vi.hoisted(() => vi.fn())
const setStyleMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  isUserMode: isUserModeMock,
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => ({
    display: {
      streaming: true,
      compact: false,
      show_reasoning: true,
      show_cost: true,
      inline_diffs: false,
      bell_on_complete: false,
      busy_input_mode: 'off',
    },
    saveSection: saveSectionMock,
  }),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({
    brightness: 'dark',
    style: 'ink',
    setBrightness: setBrightnessMock,
    setStyle: setStyleMock,
  }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NSelect: {
    props: ['value', 'options'],
    emits: ['update:value'],
    template: '<button class="theme-select" @click="$emit(\'update:value\', options?.[1]?.value)">{{ options?.map(o => o.label).join(" ") }}</button>',
  },
  NSwitch: {
    props: ['value'],
    emits: ['update:value'],
    template: '<button class="setting-switch" @click="$emit(\'update:value\', !value)">switch</button>',
  },
  useMessage: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
}))

import DisplaySettings from '@/components/hermes/settings/DisplaySettings.vue'

describe('DisplaySettings user mode labels', () => {
  beforeEach(() => {
    isUserModeMock.mockReturnValue(false)
    saveSectionMock.mockClear()
    setBrightnessMock.mockClear()
    setStyleMock.mockClear()
  })

  it('labels show_cost as token usage instead of cost in chat plane user mode', () => {
    isUserModeMock.mockReturnValue(true)

    const wrapper = mount(DisplaySettings)

    expect(wrapper.text()).toContain('settings.display.showTokenUsage')
    expect(wrapper.text()).toContain('settings.display.showTokenUsageHint')
    expect(wrapper.text()).not.toContain('settings.display.showCost')
    expect(wrapper.text()).not.toContain('settings.display.showCostHint')
  })

  it('exposes theme style selection in display settings', async () => {
    const wrapper = mount(DisplaySettings)

    expect(wrapper.text()).toContain('settings.display.style')
    expect(wrapper.text()).toContain('settings.display.styleHint')
    expect(wrapper.text()).toContain('settings.display.styleInk')
    expect(wrapper.text()).toContain('settings.display.styleComic')

    await wrapper.findAll('.theme-select')[1].trigger('click')
    expect(setStyleMock).toHaveBeenCalledWith('comic')
  })
})
