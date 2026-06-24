// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProfileCard from '@/components/hermes/profiles/ProfileCard.vue'

const profilesStoreMock = vi.hoisted(() => ({
  fetchProfileDetail: vi.fn(),
  switchHermesProfile: vi.fn(),
  deleteProfile: vi.fn(),
  exportProfile: vi.fn(),
}))
const fetchAgentSharesMock = vi.hoisted(() => vi.fn())
const grantAgentShareMock = vi.hoisted(() => vi.fn())
const revokeAgentShareMock = vi.hoisted(() => vi.fn())

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStoreMock,
}))

vi.mock('@/api/hermes/agents', () => ({
  fetchAgentShares: fetchAgentSharesMock,
  grantAgentShare: grantAgentShareMock,
  revokeAgentShare: revokeAgentShareMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'profiles.share.manage': 'Share',
      'profiles.share.title': 'Agent sharing',
      'profiles.share.empty': 'No shares',
      'profiles.share.grantee': 'OpenID',
      'profiles.share.role': 'Role',
      'profiles.share.grant': 'Grant',
      'profiles.share.revoke': 'Revoke',
      'profiles.active': 'Active',
      'profiles.model': 'Model',
      'common.expand': 'Expand',
      'common.collapse': 'Collapse',
      'common.delete': 'Delete',
      'profiles.export': 'Export',
      'profiles.switchTo': 'Switch',
    } as Record<string, string>)[key] || key,
  }),
}))

vi.mock('naive-ui', () => ({
  NButton: {
    props: ['disabled', 'loading', 'size', 'type', 'quaternary'],
    emits: ['click'],
    template: '<button type="button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  NTag: { template: '<span><slot /></span>' },
  NSpin: { template: '<div><slot /></div>' },
  NModal: {
    props: ['show'],
    emits: ['update:show'],
    template: '<div v-if="show"><slot name="header" /><slot /></div>',
  },
  NInput: {
    props: ['value', 'placeholder', 'size'],
    emits: ['update:value'],
    template: '<input :value="value" :placeholder="placeholder" @input="$emit(\'update:value\', $event.target.value)" />',
  },
  NSelect: {
    props: ['value', 'options', 'size'],
    emits: ['update:value'],
    template: '<select :value="value" @change="$emit(\'update:value\', $event.target.value)"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
  },
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
  useDialog: () => ({ warning: vi.fn() }),
}))

vi.mock('@multiavatar/multiavatar', () => ({
  default: (seed: string) => `<svg data-seed="${seed}"></svg>`,
}))

describe('ProfileCard sharing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads share members from the BFF for owner agent profiles', async () => {
    fetchAgentSharesMock.mockResolvedValue([
      { agent_id: 'agent-owned', grantee_open_id: 'ou_reader', role: 'viewer', status: 'active' },
    ])
    const wrapper = mount(ProfileCard, {
      props: {
        profile: {
          name: 'owned_agent_profile',
          active: false,
          model: '',
          alias: '',
          kind: 'agent',
          agentId: 'agent-owned',
        },
      },
    })

    const shareButton = wrapper.findAll('button').find(button => button.text().includes('Share'))
    expect(shareButton).toBeTruthy()
    await shareButton!.trigger('click')

    expect(fetchAgentSharesMock).toHaveBeenCalledWith('agent-owned')
    expect(wrapper.text()).toContain('ou_reader')
    expect(wrapper.text()).toContain('viewer')
  })
})
