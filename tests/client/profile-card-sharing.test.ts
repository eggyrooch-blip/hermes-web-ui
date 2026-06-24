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
      'profiles.share.grantee': 'Email or Feishu user ID',
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

  it('allows shared managers to open agent member management', async () => {
    fetchAgentSharesMock.mockResolvedValue([
      { agent_id: 'agent-owned', grantee_open_id: 'ou_reader', role: 'viewer', status: 'active' },
    ])
    const wrapper = mount(ProfileCard, {
      props: {
        profile: {
          name: 'shared_agent_profile',
          active: false,
          model: '',
          alias: '',
          kind: 'agent',
          agentId: 'agent-owned',
          shareRole: 'manager',
          ownerOpenId: 'ou_owner',
        },
      },
    })

    const shareButton = wrapper.findAll('button').find(button => button.text().includes('Share'))
    expect(shareButton).toBeTruthy()
    await shareButton!.trigger('click')

    expect(fetchAgentSharesMock).toHaveBeenCalledWith('agent-owned')
    expect(wrapper.text()).toContain('ou_reader')
  })

  it('renders principal member identity and grants by email lookup without showing raw OpenID', async () => {
    fetchAgentSharesMock.mockResolvedValue([
      {
        agent_id: 'agent-owned',
        share_id: 'shr_editor',
        grantee_open_id: 'principal:prn_editor',
        grantee_principal_id: 'prn_editor',
        role: 'editor',
        status: 'active',
        principal: {
          provider: 'feishu',
          display_name: 'Editor User',
          avatar_url: 'https://example.test/editor.png',
          email: 'editor@example.test',
          user_id: 'u_editor',
        },
      },
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
    await shareButton!.trigger('click')

    expect(wrapper.text()).toContain('Editor User')
    expect(wrapper.text()).toContain('editor@example.test')
    expect(wrapper.text()).not.toContain('principal:prn_editor')
    expect(wrapper.find('img.share-principal-avatar').attributes('src')).toBe('https://example.test/editor.png')

    const input = wrapper.find('input')
    await input.setValue('new-editor@example.test')
    const roleSelect = wrapper.find('select')
    await roleSelect.setValue('manager')
    const grantButton = wrapper.findAll('button').find(button => button.text().includes('Grant'))
    await grantButton!.trigger('click')

    expect(grantAgentShareMock).toHaveBeenCalledWith('agent-owned', {
      provider: 'feishu',
      type: 'email',
      value: 'new-editor@example.test',
    }, 'manager')

    const revokeButton = wrapper.findAll('button').find(button => button.text().includes('Revoke'))
    await revokeButton!.trigger('click')

    expect(revokeAgentShareMock).toHaveBeenCalledWith('agent-owned', 'shr_editor')
  })
})
