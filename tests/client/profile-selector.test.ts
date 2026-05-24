// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProfileSelector from '@/components/layout/ProfileSelector.vue'

const profilesStoreMock = vi.hoisted(() => ({
  profiles: [
    { name: 'feishu_g41a5b5g', active: true, model: '', gateway: '', alias: '', avatar: { type: 'generated', seed: 'current-seed' } },
  ],
  activeProfileName: 'feishu_g41a5b5g',
  activeProfile: { name: 'feishu_g41a5b5g', active: true, model: '', gateway: '', alias: '', avatar: { type: 'generated', seed: 'current-seed' } },
  switching: false,
  fetchProfiles: vi.fn(),
  switchProfile: vi.fn(),
  updateAvatar: vi.fn(),
  deleteAvatar: vi.fn(),
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStoreMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const values: Record<string, string> = {
        'sidebar.profiles': 'Profiles',
        'profiles.create': 'Create Profile',
        'profiles.avatar.customize': 'Customize Avatar',
        'profiles.avatar.randomize': 'Randomize',
        'profiles.avatar.reset': 'Reset',
        'profiles.avatar.updateSuccess': 'Avatar updated',
        'profiles.avatar.updateFailed': 'Avatar update failed',
        'profiles.avatar.resetSuccess': 'Avatar reset',
        'profiles.avatar.resetFailed': 'Avatar reset failed',
        'profiles.switchSuccess': `Switched ${params?.name || ''}`,
        'profiles.switchFailed': 'Switch failed',
      }
      return values[key] || key
    },
  }),
}))

vi.mock('naive-ui', () => ({
  NSelect: {
    props: ['value', 'options', 'loading', 'size'],
    template: '<select><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
  },
  NButton: {
    props: ['title', 'size', 'quaternary', 'circle', 'secondary', 'type', 'loading'],
    emits: ['click'],
    template: '<button type="button" :title="title" @click="$emit(\'click\')"><slot /></button>',
  },
  NModal: {
    props: ['show', 'title', 'preset'],
    emits: ['update:show'],
    template: '<div v-if="show" class="n-modal"><slot /></div>',
  },
  useMessage: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('@multiavatar/multiavatar', () => ({
  default: (seed: string) => `<svg data-seed="${seed}"></svg>`,
}))

vi.mock('@/components/hermes/profiles/ProfileCreateModal.vue', () => ({
  default: {
    emits: ['saved', 'close'],
    template: '<div class="profile-create-modal"><button class="save-created" @click="$emit(\'saved\')">saved</button><button @click="$emit(\'close\')">close</button></div>',
  },
}))

describe('ProfileSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    profilesStoreMock.profiles = [
      { name: 'feishu_g41a5b5g', active: true, model: '', gateway: '', alias: '', avatar: { type: 'generated', seed: 'current-seed' } },
    ]
    profilesStoreMock.activeProfileName = 'feishu_g41a5b5g'
    profilesStoreMock.activeProfile = { name: 'feishu_g41a5b5g', active: true, model: '', gateway: '', alias: '', avatar: { type: 'generated', seed: 'current-seed' } }
  })

  it('shows the active profile avatar beside the upstream selector', () => {
    const wrapper = mount(ProfileSelector)

    expect(wrapper.find('.profile-selector-avatar .profile-avatar-view').exists()).toBe(true)
    expect(wrapper.find('.profile-avatar-svg').html()).toContain('data-seed="current-seed"')
  })

  it('randomizes the active profile avatar through the owner-scoped profile store', async () => {
    profilesStoreMock.updateAvatar.mockResolvedValue({ type: 'generated', seed: 'new-seed' })
    const wrapper = mount(ProfileSelector)

    await wrapper.find('button[title="Customize Avatar"]').trigger('click')
    await wrapper.find('.avatar-random').trigger('click')

    expect(profilesStoreMock.updateAvatar).toHaveBeenCalledWith(
      'feishu_g41a5b5g',
      expect.objectContaining({ type: 'generated' }),
    )
  })

  it('resets the active profile avatar through the owner-scoped profile store', async () => {
    profilesStoreMock.deleteAvatar.mockResolvedValue(undefined)
    const wrapper = mount(ProfileSelector)

    await wrapper.find('button[title="Customize Avatar"]').trigger('click')
    await wrapper.find('.avatar-reset').trigger('click')

    expect(profilesStoreMock.deleteAvatar).toHaveBeenCalledWith('feishu_g41a5b5g')
  })

  it('opens the upstream create profile modal from the selector and refreshes after save', async () => {
    const wrapper = mount(ProfileSelector)

    const createButton = wrapper.find('button[title="Create Profile"]')
    expect(createButton.exists()).toBe(true)

    await createButton.trigger('click')
    expect(wrapper.find('.profile-create-modal').exists()).toBe(true)

    await wrapper.find('.save-created').trigger('click')
    expect(profilesStoreMock.fetchProfiles).toHaveBeenCalled()
  })
})
