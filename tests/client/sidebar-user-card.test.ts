// @vitest-environment jsdom
//
// Regression guard: the sidebar user card must NOT render the raw profile id
// (e.g. feishu_g41a5b5g) — sunke asked for that redundant line to be removed.
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import SidebarUserCard from '@/components/layout/SidebarUserCard.vue'

describe('SidebarUserCard', () => {
  it('does not render the profile id line', () => {
    const wrapper = mount(SidebarUserCard, {
      props: {
        user: { name: '孙可', profile: 'feishu_g41a5b5g', avatarUrl: null },
        connected: true,
      },
    })
    // The profile-id span is gone...
    expect(wrapper.find('.user-profile').exists()).toBe(false)
    // ...and the raw id text is nowhere in the rendered card.
    expect(wrapper.text()).not.toContain('feishu_g41a5b5g')
    // The display name is still shown.
    expect(wrapper.text()).toContain('孙可')
  })
})
