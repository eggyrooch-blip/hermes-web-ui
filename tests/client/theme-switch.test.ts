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
  it('renders the comic-style and brightness controls', async () => {
    const wrapper = mount(ThemeSwitch)
    const buttons = wrapper.findAll('button.theme-switch')

    // Upstream renders both a comic-style toggle and a brightness toggle.
    expect(buttons).toHaveLength(2)

    const comicButton = wrapper.find('button[title="Comic style"]')
    expect(comicButton.exists()).toBe(true)

    const brightnessButton = wrapper.find('button[title="Dark mode"]')
    expect(brightnessButton.exists()).toBe(true)

    await brightnessButton.trigger('click')
    expect(toggleBrightnessMock).toHaveBeenCalled()

    await comicButton.trigger('click')
    expect(toggleStyleMock).toHaveBeenCalled()
  })
})
