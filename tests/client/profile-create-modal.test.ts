// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProfileCreateModal from '@/components/hermes/profiles/ProfileCreateModal.vue'

const profilesStoreMock = vi.hoisted(() => ({
  createProfile: vi.fn(),
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStoreMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const values: Record<string, string> = {
        'profiles.create': 'Create Profile',
        'profiles.name': 'Profile name',
        'profiles.namePlaceholder': 'profile name',
        'profiles.nameValidation': 'Only lowercase letters, numbers, underscores, and hyphens are allowed',
        'profiles.cloneFromCurrent': 'Clone current profile',
        'profiles.cloneCleanupNotice': 'Credentials will be cleaned after cloning',
        'profiles.createSuccess': `Created ${params?.name || ''}`,
        'profiles.createFailed': 'Create failed',
        'profiles.rolePreset': 'Role preset',
        'profiles.rolePresetCoder': 'Coder',
        'profiles.rolePresetResearcher': 'Researcher',
        'profiles.rolePresetWriter': 'Writer',
        'profiles.rolePresetOperator': 'Operator',
        'profiles.rolePresetCustom': 'Custom',
        'profiles.roleDescription': 'Role description',
        'profiles.roleDescriptionPlaceholder': 'Describe this profile role',
        'profiles.rolePresetCoderDescription': 'Software engineering agent for coding, debugging, tests, repo navigation, and pull request work.',
        'common.cancel': 'Cancel',
        'common.create': 'Create',
      }
      return values[key] || key
    },
  }),
}))

vi.mock('naive-ui', () => {
  const passthrough = { template: '<div><slot /><slot name="footer" /></div>' }
  return {
    NModal: passthrough,
    NForm: passthrough,
    NFormItem: {
      props: ['label'],
      template: '<label><span>{{ label }}</span><slot /></label>',
    },
    NText: passthrough,
    NButton: {
      props: ['loading', 'type'],
      emits: ['click'],
      template: '<button type="button" @click="$emit(\'click\')"><slot /></button>',
    },
    NSwitch: {
      props: ['value'],
      emits: ['update:value'],
      template: '<input type="checkbox" :checked="value" @change="$emit(\'update:value\', $event.target.checked)" />',
    },
    NInput: {
      props: ['value', 'placeholder', 'type'],
      emits: ['update:value', 'input'],
      template: `
        <textarea
          v-if="type === 'textarea'"
          :value="value"
          :placeholder="placeholder"
          @input="$emit('update:value', $event.target.value); $emit('input', $event.target.value)"
        />
        <input
          v-else
          :value="value"
          :placeholder="placeholder"
          @input="$emit('update:value', $event.target.value); $emit('input', $event.target.value)"
        />
      `,
    },
    NRadioGroup: {
      props: ['value'],
      emits: ['update:value'],
      template: '<div><slot /></div>',
    },
    NRadioButton: {
      props: ['value'],
      template: '<button type="button"><slot /></button>',
    },
    useMessage: () => ({
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    }),
  }
})

describe('ProfileCreateModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    profilesStoreMock.createProfile.mockResolvedValue({ success: true })
  })

  it('renders upstream create modal with role presets and passes coder description on create', async () => {
    const wrapper = mount(ProfileCreateModal)

    expect(wrapper.text()).toContain('Role preset')
    expect(wrapper.text()).toContain('Coder')
    expect(wrapper.text()).toContain('Software engineering agent')

    await wrapper.find('input[placeholder="profile name"]').setValue('web_coder')
    await wrapper.findAll('button').find(button => button.text() === 'Create')!.trigger('click')

    expect(profilesStoreMock.createProfile).toHaveBeenCalledWith('web_coder', {
      clone: false,
      description: 'Software engineering agent for coding, debugging, tests, repo navigation, and pull request work.',
    })
  })
})
