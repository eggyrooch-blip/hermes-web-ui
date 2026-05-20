// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProfileSelector from '@/components/layout/ProfileSelector.vue'

const profilesStoreMock = vi.hoisted(() => ({
  profiles: [
    { name: 'feishu_g41a5b5g', active: true, model: '', gateway: '', alias: '' },
  ],
  activeProfileName: 'feishu_g41a5b5g',
  switching: false,
  fetchProfiles: vi.fn(),
  switchProfile: vi.fn(),
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
    props: ['title', 'size', 'quaternary', 'circle'],
    emits: ['click'],
    template: '<button type="button" :title="title" @click="$emit(\'click\')"><slot /></button>',
  },
  useMessage: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
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
