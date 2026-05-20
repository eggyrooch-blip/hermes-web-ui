// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

const toggleBrightnessMock = vi.hoisted(() => vi.fn())

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({
    isDark: false,
    isComic: false,
    toggleBrightness: toggleBrightnessMock,
  }),
}))

import ThemeSwitch from '@/components/layout/ThemeSwitch.vue'

describe('ThemeSwitch', () => {
  it('renders only the brightness control in the sidebar shortcut', async () => {
    const wrapper = mount(ThemeSwitch)
    const buttons = wrapper.findAll('button.theme-switch')

    expect(buttons).toHaveLength(1)
    expect(wrapper.find('button[title="Comic style"]').exists()).toBe(false)
    expect(buttons[0].attributes('title')).toBe('Dark mode')

    await buttons[0].trigger('click')
    expect(toggleBrightnessMock).toHaveBeenCalled()
  })
})
