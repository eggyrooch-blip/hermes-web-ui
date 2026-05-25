// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@multiavatar/multiavatar', () => ({
  default: (seed: string) => `<svg data-seed="${seed}"></svg>`,
}))

describe('ProfileAvatar', () => {
  it('renders a generated avatar from the profile name by default', async () => {
    const ProfileAvatar = (await import('@/components/hermes/profiles/ProfileAvatar.vue')).default

    const wrapper = mount(ProfileAvatar, {
      props: { name: 'feishu_user_a', size: 32 },
    })

    expect(wrapper.find('.profile-avatar-view').attributes('style')).toContain('width: 32px')
    expect(wrapper.find('.profile-avatar-svg').html()).toContain('data-seed="feishu_user_a"')
  })

  it('prefers image avatars without exposing generated SVG markup', async () => {
    const ProfileAvatar = (await import('@/components/hermes/profiles/ProfileAvatar.vue')).default

    const wrapper = mount(ProfileAvatar, {
      props: {
        name: 'feishu_user_a',
        avatar: {
          type: 'image',
          dataUrl: 'data:image/png;base64,abc',
        },
      },
    })

    expect(wrapper.find('img.profile-avatar-image').attributes('src')).toBe('data:image/png;base64,abc')
    expect(wrapper.find('.profile-avatar-svg').exists()).toBe(false)
  })
})
