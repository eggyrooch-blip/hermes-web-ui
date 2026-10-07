import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { useProfilesStore } from './profiles'

// Pins used to live here, one localStorage array per profile, which meant a
// phone and a laptop signed into the same account disagreed about what was
// pinned. They now live on the session row; this key survives only so the old
// value can be migrated once and then deleted (see session-pins.ts).
const LEGACY_PIN_KEY_PREFIX = 'hermes_session_pins_v1_'
const HUMAN_ONLY_KEY_PREFIX = 'hermes_human_only_v1_'

function currentProfileName(): string {
  try {
    return useProfilesStore().activeProfileName || 'default'
  } catch {
    // Fallback during store initialization
    return localStorage.getItem('hermes_active_profile_name') || 'default'
  }
}

function legacyPinsKey(profileName: string): string {
  return `${LEGACY_PIN_KEY_PREFIX}${profileName}`
}

function humanOnlyKey(profileName: string): string {
  return `${HUMAN_ONLY_KEY_PREFIX}${profileName}`
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch {
    return fallback
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore quota/storage errors — fall back to in-memory only
  }
}

export const useSessionBrowserPrefsStore = defineStore('session-browser-prefs', () => {
  const profileName = ref(currentProfileName())
  const humanOnly = ref<boolean>(loadJson<boolean>(humanOnlyKey(profileName.value), true))

  function reload() {
    profileName.value = currentProfileName()
    humanOnly.value = loadJson<boolean>(humanOnlyKey(profileName.value), true)
  }

  function persistHumanOnly() {
    saveJson(humanOnlyKey(profileName.value), humanOnly.value)
  }

  function setHumanOnly(value: boolean) {
    if (humanOnly.value === value) return
    humanOnly.value = value
    persistHumanOnly()
  }

  // The legacy accessors take an explicit profile: a migration started under one
  // profile can finish after the user switched to another, and the key it reads
  // has to be the key it rewrites. Defaulting to the active profile keeps the
  // common call site short.

  /** Pins written by the pre-table client for one profile, oldest first. */
  function legacyPinnedIds(profile: string = profileName.value): string[] {
    const stored = loadJson<unknown>(legacyPinsKey(profile), [])
    if (!Array.isArray(stored)) return []
    return stored.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
  }

  /** Leave behind only the pins still waiting to move; no leftovers means no key. */
  function writeLegacyPins(profile: string, ids: string[]) {
    try {
      if (ids.length === 0) localStorage.removeItem(legacyPinsKey(profile))
      else saveJson(legacyPinsKey(profile), ids)
    } catch {
      // ignore storage errors — the migration is idempotent and retries next load
    }
  }

  /** Drop one profile's legacy key once its pins are on the server. */
  function clearLegacyPins(profile: string = profileName.value) {
    writeLegacyPins(profile, [])
  }

  watch(
    () => useProfilesStore().activeProfileName,
    () => reload(),
  )

  return {
    profileName,
    humanOnly,
    reload,
    setHumanOnly,
    legacyPinnedIds,
    writeLegacyPins,
    clearLegacyPins,
  }
})
