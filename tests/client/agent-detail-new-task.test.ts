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
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { name: 'agent-a' } }),
  useRouter: () => ({ push: routerPush }),
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
