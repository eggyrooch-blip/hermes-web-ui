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

import { useChatStore } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'

describe('chat store — central stale-expert clear on profile switch', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('resets activeExpertId to null when the active profile changes', async () => {
    const chat = useChatStore()
    const profiles = useProfilesStore()

    // Pretend we are on profile A with a profile-A expert selected in the composer.
    profiles.activeProfileName = 'profile-a'
    await nextTick()
    chat.setActiveExpert('expert-from-a')
    expect(chat.activeExpertId).toBe('expert-from-a')

    // Switch to profile B — the central watcher (NOT a component watcher) must
    // clear the stale selection even though ChatInput/ExpertCatalogView are
    // never mounted in this test.
    profiles.activeProfileName = 'profile-b'
    await nextTick()

    expect(chat.activeExpertId).toBeNull()
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
})
