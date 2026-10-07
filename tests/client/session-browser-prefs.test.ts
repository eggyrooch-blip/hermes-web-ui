// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSessionBrowserPrefsStore } from '@/stores/hermes/session-browser-prefs'

describe('session browser prefs store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    window.localStorage.clear()
  })

  it('reads the legacy per-profile pins and drops the key once they are migrated', () => {
    const profilesStore = useProfilesStore()
    profilesStore.activeProfileName = 'default'
    window.localStorage.setItem('hermes_session_pins_v1_default', JSON.stringify(['session-1', 'session-2']))

    const store = useSessionBrowserPrefsStore()
    expect(store.legacyPinnedIds()).toEqual(['session-1', 'session-2'])

    store.clearLegacyPins()
    expect(window.localStorage.getItem('hermes_session_pins_v1_default')).toBeNull()
    expect(store.legacyPinnedIds()).toEqual([])
  })

  it('ignores a legacy pin value that is not an array of ids', () => {
    const profilesStore = useProfilesStore()
    profilesStore.activeProfileName = 'default'
    const store = useSessionBrowserPrefsStore()

    window.localStorage.setItem('hermes_session_pins_v1_default', 'not json')
    expect(store.legacyPinnedIds()).toEqual([])

    window.localStorage.setItem('hermes_session_pins_v1_default', JSON.stringify({ id: 'session-1' }))
    expect(store.legacyPinnedIds()).toEqual([])

    window.localStorage.setItem('hermes_session_pins_v1_default', JSON.stringify(['session-1', '', 3, null]))
    expect(store.legacyPinnedIds()).toEqual(['session-1'])
  })

  it('reads legacy pins from the profile that is active now', async () => {
    const profilesStore = useProfilesStore()
    profilesStore.activeProfileName = 'default'
    const store = useSessionBrowserPrefsStore()

    window.localStorage.setItem('hermes_session_pins_v1_default', JSON.stringify(['default-session']))
    window.localStorage.setItem('hermes_session_pins_v1_work', JSON.stringify(['work-session']))
    expect(store.legacyPinnedIds()).toEqual(['default-session'])

    profilesStore.activeProfileName = 'work'
    await nextTick()

    expect(store.profileName).toBe('work')
    expect(store.legacyPinnedIds()).toEqual(['work-session'])

    store.clearLegacyPins()
    expect(window.localStorage.getItem('hermes_session_pins_v1_work')).toBeNull()
    // Clearing one profile never touches another profile's legacy key.
    expect(window.localStorage.getItem('hermes_session_pins_v1_default')).not.toBeNull()
  })

  it('reloads human-only preferences automatically when the active profile changes', async () => {
    const profilesStore = useProfilesStore()
    profilesStore.activeProfileName = 'default'
    const store = useSessionBrowserPrefsStore()

    expect(store.humanOnly).toBe(true)
    store.setHumanOnly(false)

    window.localStorage.setItem('hermes_human_only_v1_work', JSON.stringify(true))

    profilesStore.activeProfileName = 'work'
    await nextTick()

    expect(store.profileName).toBe('work')
    expect(store.humanOnly).toBe(true)

    profilesStore.activeProfileName = 'default'
    await nextTick()

    expect(store.humanOnly).toBe(false)
  })
})
