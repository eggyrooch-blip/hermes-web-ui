// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProfileSelector from '@/components/layout/ProfileSelector.vue'

// NOTE (upstream rebaseline 2026-06-17):
// ProfileSelector.vue was replaced wholesale by the upstream EKKOLearnAI component.
// The fork's NSelect/optgroup grouped selector — with kind-based grouping,
// owner-prefix stripping (displayLabel/ownerOpenId) and an inline "Create Profile"
// button + ProfileCreateModal — no longer exists. The upstream component renders a
// click-to-open profile manager modal with a flat runtime list, and an avatar editor
// (customize -> random/reset) reached from each list row.
// Two fork-only cases were therefore deleted (see end of file): the create-profile
// modal flow and the kind-grouping/owner-prefix test both targeted deleted features.
// The avatar display + randomize/reset cases are rewritten against the real upstream
// DOM so the owner-scoped store contract (updateAvatar/deleteAvatar) stays verified.

const profilesStoreMock = vi.hoisted(() => ({
  profiles: [
    { name: 'feishu_user_a', active: true, model: '', gateway: '', alias: '', avatar: { type: 'generated', seed: 'current-seed' } },
  ],
  activeProfileName: 'feishu_user_a',
  activeProfile: { name: 'feishu_user_a', active: true, model: '', gateway: '', alias: '', avatar: { type: 'generated', seed: 'current-seed' } },
  switching: false,
  fetchProfiles: vi.fn(),
  switchProfile: vi.fn(),
  updateAvatar: vi.fn(),
  deleteAvatar: vi.fn(),
}))
const isStoredSuperAdminMock = vi.hoisted(() => vi.fn(() => false))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStoreMock,
}))

vi.mock('@/api/client', () => ({
  isStoredSuperAdmin: isStoredSuperAdminMock,
}))

// The upstream component pulls runtime status + restart helpers from the api module
// when the profile manager modal opens. Stub them so mount/open don't hit the network.
vi.mock('@/api/hermes/profiles', () => ({
  fetchProfileRuntimeStatusesWithMeta: vi.fn().mockResolvedValue({ profiles: [], refreshing: false }),
  restartProfileGateway: vi.fn(),
  restartProfileRuntime: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const values: Record<string, string> = {
        'sidebar.profiles': 'Profiles',
        'profiles.avatar.customize': 'Customize Avatar',
        'profiles.avatar.upload': 'Upload',
        'profiles.avatar.random': 'Randomize',
        'profiles.avatar.reset': 'Reset',
        'profiles.avatar.title': 'Avatar',
        'profiles.avatar.hint': 'hint',
        'profiles.avatar.saveSuccess': 'Avatar updated',
        'profiles.avatar.saveFailed': 'Avatar update failed',
        'profiles.avatar.resetSuccess': 'Avatar reset',
        'profiles.avatar.resetFailed': 'Avatar reset failed',
        'profiles.runtime.checking': 'Checking',
        'profiles.runtime.running': 'Running',
        'profiles.runtime.stopped': 'Stopped',
        'profiles.runtime.active': 'Active',
        'profiles.runtime.idle': 'Idle',
        'profiles.runtime.activeTag': 'Active',
        'profiles.runtime.activeProfile': `Active ${params?.name || ''}`,
        'profiles.runtime.bridgeWorker': 'Bridge',
        'profiles.runtime.gateway': 'Gateway',
        'profiles.runtime.restartGateway': 'Restart Gateway',
        'profiles.runtime.restartProfile': 'Restart Profile',
        'profiles.runtime.switchProfile': 'Switch Profile',
        'profiles.switchSuccess': `Switched ${params?.name || ''}`,
        'profiles.switchFailed': 'Switch failed',
      }
      return values[key] || key
    },
  }),
}))

vi.mock('naive-ui', () => ({
  NButton: {
    props: ['title', 'size', 'quaternary', 'circle', 'secondary', 'type', 'loading', 'disabled'],
    emits: ['click'],
    template: '<button type="button" :title="title" @click="$emit(\'click\')"><slot /></button>',
  },
  NModal: {
    props: ['show', 'title', 'preset', 'bordered'],
    emits: ['update:show'],
    template: '<div v-if="show" class="n-modal"><slot name="header" /><slot /></div>',
  },
  NSpin: {
    props: ['show', 'size'],
    template: '<div class="n-spin"><slot /></div>',
  },
  useMessage: () => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  }),
}))

vi.mock('@multiavatar/multiavatar', () => ({
  default: (seed: string) => `<svg data-seed="${seed}"></svg>`,
}))

// Find an NButton stub by its rendered text label (upstream avatar buttons carry
// no title attribute — they are labelled by i18n text).
function findButtonByText(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find(button => button.text().includes(text))
}

describe('ProfileSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    profilesStoreMock.profiles = [
      { name: 'feishu_user_a', active: true, model: '', gateway: '', alias: '', kind: 'user', avatar: { type: 'generated', seed: 'current-seed' } },
    ]
    profilesStoreMock.activeProfileName = 'feishu_user_a'
    profilesStoreMock.activeProfile = { name: 'feishu_user_a', active: true, model: '', gateway: '', alias: '', kind: 'user', avatar: { type: 'generated', seed: 'current-seed' } }
    isStoredSuperAdminMock.mockReturnValue(false)
  })

  it('shows the active profile avatar beside the upstream selector', () => {
    const wrapper = mount(ProfileSelector)

    // Upstream renders the active profile avatar (ProfileAvatarView -> .profile-avatar-view)
    // inside the click-to-open .profile-display row.
    expect(wrapper.find('.profile-display .profile-avatar-view').exists()).toBe(true)
    expect(wrapper.find('.profile-avatar-svg').html()).toContain('data-seed="current-seed"')
    expect(wrapper.find('.profile-name').text()).toBe('feishu_user_a')
  })

  it('randomizes the active profile avatar through the owner-scoped profile store', async () => {
    profilesStoreMock.updateAvatar.mockResolvedValue({ type: 'generated', seed: 'new-seed' })
    const wrapper = mount(ProfileSelector)

    // Open the profile manager modal, then the per-profile avatar editor.
    await wrapper.find('.profile-display').trigger('click')
    await findButtonByText(wrapper, 'Customize Avatar')!.trigger('click')
    await findButtonByText(wrapper, 'Randomize')!.trigger('click')

    expect(profilesStoreMock.updateAvatar).toHaveBeenCalledWith(
      'feishu_user_a',
      expect.objectContaining({ type: 'generated' }),
    )
  })

  it('resets the active profile avatar through the owner-scoped profile store', async () => {
    profilesStoreMock.deleteAvatar.mockResolvedValue(undefined)
    const wrapper = mount(ProfileSelector)

    await wrapper.find('.profile-display').trigger('click')
    await findButtonByText(wrapper, 'Customize Avatar')!.trigger('click')
    await findButtonByText(wrapper, 'Reset')!.trigger('click')

    expect(profilesStoreMock.deleteAvatar).toHaveBeenCalledWith('feishu_user_a')
  })

  it('hides profile runtime and frontend switching controls from ordinary Feishu users', async () => {
    const wrapper = mount(ProfileSelector)

    await wrapper.find('.profile-display').trigger('click')

    expect(wrapper.text()).toContain('Customize Avatar')
    expect(wrapper.text()).not.toContain('Switch Profile')
    expect(wrapper.text()).not.toContain('Restart Gateway')
    expect(wrapper.text()).not.toContain('Restart Profile')
  })

  it('keeps profile runtime and frontend switching controls for super-admin users', async () => {
    isStoredSuperAdminMock.mockReturnValue(true)
    const wrapper = mount(ProfileSelector)

    await wrapper.find('.profile-display').trigger('click')

    expect(wrapper.text()).toContain('Customize Avatar')
    expect(wrapper.text()).toContain('Switch Profile')
    expect(wrapper.text()).toContain('Restart Gateway')
    expect(wrapper.text()).toContain('Restart Profile')
  })

  // DELETED (upstream rebaseline): "opens the upstream create profile modal from the
  // selector and refreshes after save" — the upstream ProfileSelector has no inline
  // Create Profile button and does not import ProfileCreateModal. Profile creation is
  // no longer reachable from this component, so the case tested a deleted feature.

  // DELETED (upstream rebaseline): "groups owner-scoped profiles by profile kind and
  // strips owner prefixes from group labels" — the upstream component renders a flat
  // runtime list (no NSelect/optgroup, no kind grouping, no displayLabel/ownerOpenId
  // prefix stripping). That grouping behaviour was fork-only and no longer exists.
})
