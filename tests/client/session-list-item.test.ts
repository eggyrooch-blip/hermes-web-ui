// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import SessionListItem from '@/components/hermes/chat/SessionListItem.vue'

const profileStoreMocks = vi.hoisted(() => ({
  profiles: [] as any[],
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({
    profileModelGroups: [],
  }),
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({ profiles: profileStoreMocks.profiles }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/shared/session-display', () => ({
  formatTimestampMs: () => 'now',
}))

vi.mock('naive-ui', () => ({
  NPopconfirm: defineComponent({
    name: 'NPopconfirm',
    emits: ['positive-click'],
    template: '<span><slot name="trigger" /><slot /></span>',
  }),
  NCheckbox: defineComponent({
    name: 'NCheckbox',
    props: ['checked'],
    emits: ['click'],
    template: '<input type="checkbox" :checked="checked" @click="$emit(\'click\')" />',
  }),
  NTooltip: defineComponent({
    name: 'NTooltip',
    template: '<span><slot name="trigger" /><slot /></span>',
  }),
}))

const session = {
  id: 's1',
  title: 'Session One',
  model: 'gpt-test',
  provider: 'openai',
  createdAt: Date.now(),
  profile: 'kira',
}

describe('SessionListItem', () => {
  beforeEach(() => {
    profileStoreMocks.profiles = []
  })

  it('renders normal mode as a link to the session route', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session,
        active: false,
        pinned: false,
        canDelete: true,
        to: '/session/s1',
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const link = wrapper.get('a.session-item')
    expect(link.attributes('href')).toBe('/session/s1')
    expect(wrapper.find('button.session-item').exists()).toBe(false)
  })

  it('renders selectable mode as a button and does not expose row href', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session,
        active: false,
        pinned: false,
        canDelete: true,
        selectable: true,
        selected: false,
        to: '/session/s1',
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    expect(wrapper.find('button.session-item').exists()).toBe(true)
    expect(wrapper.find('a.session-item').exists()).toBe(false)
  })

  it('does not select the row when clicking nested action controls', async () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session,
        active: false,
        pinned: false,
        canDelete: true,
        to: '/session/s1',
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    await wrapper.get('button.session-item-delete').trigger('click')
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('does not hijack modified clicks on normal links', async () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session,
        active: false,
        pinned: false,
        canDelete: true,
        to: '/session/s1',
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const link = wrapper.get('a.session-item')
    link.element.addEventListener('click', event => event.preventDefault())
    await link.trigger('click', { ctrlKey: true })
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  const avatarStub = defineComponent({
    name: 'ProfileAvatar',
    props: ['name', 'avatar', 'size'],
    template: '<span class="profile-avatar-stub" :data-name="name" :data-avatar-url="avatar?.url || \'\'" :data-size="size"></span>',
  })

  // Upstream design: every row shows the AGENT logo (per agent) PLUS the USER avatar.
  it.each(['cli', 'api_server', 'global_agent'])(
    'renders the Hermes agent logo AND the user avatar for %s Hermes sessions',
    (source) => {
      profileStoreMocks.profiles = [{
        name: 'kira',
        avatar: {
          type: 'url',
          url: 'https://example.com/kira-avatar.png',
        },
      }]
      const wrapper = mount(SessionListItem, {
        props: {
          session: { ...session, source, agent: 'hermes' },
          active: false,
          pinned: false,
          canDelete: true,
        },
        global: {
          stubs: { ProfileAvatar: avatarStub },
        },
      })

      // Agent identity = the Hermes logo (per-agent; Codex/Claude for coding agents).
      const logo = wrapper.get('.session-item-agent-logo')
      expect(logo.attributes('src')).toBe('/coding-agents/hermes.png')
      expect(logo.attributes('alt')).toBe('Hermes')
      // User identity = the user's own profile avatar, shown separately (avatar only,
      // no profile-id text — sunke asked for just the two avatars).
      const userAvatar = wrapper.get('.session-item-profile .profile-avatar-stub')
      expect(userAvatar.attributes('data-name')).toBe('kira')
      expect(userAvatar.attributes('data-avatar-url')).toBe('https://example.com/kira-avatar.png')
      expect(userAvatar.attributes('data-size')).toBe('16')
      expect(wrapper.find('.session-item-profile-name').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('kira')
    },
  )

  it('defaults old sessions without agent metadata to the Hermes logo', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session: { ...session, source: undefined, agent: undefined, codingAgentId: undefined },
        active: false,
        pinned: false,
        canDelete: true,
      },
      global: {
        stubs: { ProfileAvatar: avatarStub },
      },
    })

    const logo = wrapper.get('.session-item-agent-logo')
    expect(logo.attributes('src')).toBe('/coding-agents/hermes.png')
    expect(logo.attributes('alt')).toBe('Hermes')
  })

  it('renders the Claude Code logo for Claude coding agent sessions', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session: { ...session, source: 'coding_agent', agent: 'claude', codingAgentId: 'claude-code' },
        active: false,
        pinned: false,
        canDelete: true,
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const logo = wrapper.get('.session-item-agent-logo')
    expect(logo.attributes('src')).toBe('/coding-agents/claude-code.svg')
    expect(logo.attributes('alt')).toBe('Claude Code')
    expect(wrapper.find('.session-item-agent-name').exists()).toBe(false)
  })

  it('renders the Codex logo for Codex coding agent sessions', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session: { ...session, source: 'coding_agent', agent: 'codex', codingAgentId: 'codex' },
        active: false,
        pinned: false,
        canDelete: true,
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const logo = wrapper.get('.session-item-agent-logo')
    expect(logo.attributes('src')).toBe('/coding-agents/codex-openai.png')
    expect(logo.attributes('alt')).toBe('Codex')
    expect(wrapper.find('.session-item-agent-name').exists()).toBe(false)
  })
})
