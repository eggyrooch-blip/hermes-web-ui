// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

const toggleBrightnessMock = vi.hoisted(() => vi.fn())
const toggleStyleMock = vi.hoisted(() => vi.fn())

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({
    isDark: false,
    isComic: false,
    toggleBrightness: toggleBrightnessMock,
    toggleStyle: toggleStyleMock,
  }),
}))

import ThemeSwitch from '@/components/layout/ThemeSwitch.vue'

describe('ThemeSwitch', () => {
  it('renders both style and brightness controls', async () => {
    const wrapper = mount(ThemeSwitch)
    const buttons = wrapper.findAll('button.theme-switch')

    expect(buttons).toHaveLength(2)
    expect(buttons[0].attributes('title')).toBe('Comic style')
    expect(buttons[1].attributes('title')).toBe('Dark mode')

    await buttons[0].trigger('click')
    await buttons[1].trigger('click')
    expect(toggleStyleMock).toHaveBeenCalled()
    expect(toggleBrightnessMock).toHaveBeenCalled()
  })
})
