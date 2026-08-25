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
  it('renders the comic-style toggle and the shared light/dark segmented control', async () => {
    // Light/dark now lives in the shared KpThemeSeg component (the prototype's
    // 浅色/深色 segmented control), used identically in both sidebars. Stub it —
    // it pulls in i18n — and assert it is composed in alongside the comic toggle.
    const wrapper = mount(ThemeSwitch, {
      global: {
        stubs: {
          KpThemeSeg: { template: '<span class="kp-theme-seg-stub" />' },
        },
      },
    })

    const comicButton = wrapper.find('button[title="Comic style"]')
    expect(comicButton.exists()).toBe(true)
    await comicButton.trigger('click')
    expect(toggleStyleMock).toHaveBeenCalled()

    // The brightness affordance is the shared segmented control.
    expect(wrapper.find('.kp-theme-seg-stub').exists()).toBe(true)
  })
})
