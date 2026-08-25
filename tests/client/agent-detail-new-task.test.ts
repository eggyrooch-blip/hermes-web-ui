// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const profilesStore = vi.hoisted(() => ({
  profiles: [{ name: 'agent-a', active: false, model: 'test', alias: '' }],
  activeProfileName: 'owner',
  fetchProfiles: vi.fn(),
  switchProfile: vi.fn(),
}))
const chatStore = vi.hoisted(() => ({ agentSwitching: false }))
const routerPush = vi.hoisted(() => vi.fn())

vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => profilesStore }))
vi.mock('@/stores/hermes/chat', () => ({ useChatStore: () => chatStore }))
vi.mock('@/api/hermes/skills', () => ({
  fetchMemory: vi.fn(async () => ({ memory: '', user: '', soul: '' })),
  fetchSkills: vi.fn(async () => ({ categories: [], archived: [] })),
}))
vi.mock('@/api/hermes/files', () => ({ listFiles: vi.fn(async () => ({ entries: [] })) }))
vi.mock('@/components/hermes/profiles/ProfileAvatar.vue', () => ({
  default: { template: '<span />' },
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
// `useDialog` throws without an <n-dialog-provider> ancestor, which this
// harness has no reason to mount. Partial mock so every other naive-ui export
// the view renders stays real.
vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useDialog: () => ({
      create: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
      destroyAll: vi.fn(),
    }),
  }
})
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { name: 'agent-a' } }),
  useRouter: () => ({ push: routerPush }),
  // `@/api/client` imports the router module, which calls these at import
  // time. Without them the whole file fails to load, not just one assertion.
  createRouter: () => ({
    beforeEach: () => {},
    afterEach: () => {},
    push: routerPush,
    replace: routerPush,
    currentRoute: { value: { name: 'hermes.chat', query: {}, params: {} } },
  }),
  createWebHashHistory: () => ({}),
}))

import AgentDetailView from '@/views/hermes/AgentDetailView.vue'

describe('AgentDetailView new task', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    profilesStore.activeProfileName = 'owner'
    profilesStore.switchProfile.mockResolvedValue(false)
    chatStore.agentSwitching = false
  })

  it('does not navigate when switching to the exact profile fails', async () => {
    const wrapper = mount(AgentDetailView)
    await flushPromises()
    await wrapper.get('[data-testid="agent-detail-new-task"]').trigger('click')
    await flushPromises()

    expect(profilesStore.switchProfile).toHaveBeenCalledWith('agent-a')
    expect(routerPush).not.toHaveBeenCalled()
    expect(chatStore.agentSwitching).toBe(false)
  })
})
