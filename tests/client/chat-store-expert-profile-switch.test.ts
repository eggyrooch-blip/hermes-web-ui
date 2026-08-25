// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'

// The profiles store touches its api module on instantiation paths; stub it so
// the store loads in isolation (we only drive activeProfileName directly here).
vi.mock('@/api/hermes/profiles', () => ({
  fetchProfiles: vi.fn().mockResolvedValue([]),
  fetchProfileDetail: vi.fn(),
  createProfile: vi.fn(),
  deleteProfile: vi.fn(),
  renameProfile: vi.fn(),
  switchProfile: vi.fn(),
  switchHermesProfile: vi.fn(),
  exportProfile: vi.fn(),
  importProfile: vi.fn(),
  updateProfileAvatar: vi.fn(),
  deleteProfileAvatar: vi.fn(),
}))

const resumeSessionMock = vi.hoisted(() => vi.fn())
vi.mock('@/api/hermes/chat', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, resumeSession: resumeSessionMock }
})

import { useChatStore } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'

describe('chat store — central stale-expert clear on profile switch', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('resets activeExpert display state when the active profile changes', async () => {
    const chat = useChatStore()
    const profiles = useProfilesStore()

    // Pretend we are on profile A with a profile-A expert selected in the composer.
    profiles.activeProfileName = 'profile-a'
    await nextTick()
    chat.setActiveExpert('expert-from-a', { avatar: '/expert-a.png', label: 'Expert A' })
    expect(chat.activeExpertId).toBe('expert-from-a')
    expect(chat.activeExpertAvatar).toBe('/expert-a.png')
    expect(chat.activeExpertLabel).toBe('Expert A')

    // Switch to profile B — the central watcher (NOT a component watcher) must
    // clear the stale selection even though ChatInput/ExpertCatalogView are
    // never mounted in this test.
    profiles.activeProfileName = 'profile-b'
    await nextTick()

    expect(chat.activeExpertId).toBeNull()
    expect(chat.activeExpertAvatar).toBe('')
    expect(chat.activeExpertLabel).toBe('')
    // and it must not survive in localStorage either
    expect(localStorage.getItem('hermes_active_expert_id')).toBeNull()
  })

  it('does not clear the selection when the profile name is unchanged', async () => {
    const chat = useChatStore()
    const profiles = useProfilesStore()

    profiles.activeProfileName = 'profile-a'
    await nextTick()
    chat.setActiveExpert('expert-from-a')

    // Re-assigning the same value must NOT wipe a valid selection.
    profiles.activeProfileName = 'profile-a'
    await nextTick()

    expect(chat.activeExpertId).toBe('expert-from-a')
  })

  it('starts a separate expert-bound session while ordinary new chat stays expert-free', () => {
    const chat = useChatStore()
    const first = chat.newChatWithExpert({
      id: 'expert-x',
      name: 'Employee X',
      avatar: '/x.png',
    })
    const second = chat.newChatWithExpert({
      id: 'expert-y',
      name: 'Employee Y',
      avatar: '/y.png',
    })

    expect(first).toMatchObject({ expertId: 'expert-x', expertLabel: 'Employee X', expertAvatar: '/x.png' })
    expect(second).toMatchObject({ expertId: 'expert-y', expertLabel: 'Employee Y', expertAvatar: '/y.png' })
    expect(second.id).not.toBe(first.id)
    expect(first.expertId).toBe('expert-x')

    const ordinary = chat.newChat()
    expect(ordinary.expertId).toBeUndefined()
    expect(chat.activeExpertId).toBeNull()
  })

  it('opens a brand-new expert session without blocking on the rowless resume', async () => {
    const chat = useChatStore()
    const session = chat.newChatWithExpert({ id: 'expert-x', name: 'Employee X' })
    await nextTick()
    await Promise.resolve()
    await nextTick()

    // No server row exists yet; the server's rowless-control fence rejects
    // 'resume' and never answers. The channel is still registered (later runs
    // need it) but the view must not wait out the 15s timeout.
    expect((session as any).localCreated).toBe(true)
    expect(chat.activeSessionId).toBe(session.id)
    expect(chat.isLoadingMessages).toBe(false)
  })

  it('never stamps an expert onto a global-agent session', async () => {
    const chat = useChatStore()
    const session = chat.newChat({ source: 'global_agent' })
    await nextTick()

    chat.setActiveExpert('expert-x', { label: 'X' })
    expect(session.expertId).toBeUndefined()
    expect(session.expertLabel).toBeUndefined()
  })
})
