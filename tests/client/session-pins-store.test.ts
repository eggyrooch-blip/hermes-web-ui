// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const setSessionPinnedMock = vi.hoisted(() => vi.fn())
const importHermesSessionMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/hermes/sessions', () => ({
  setSessionPinned: setSessionPinnedMock,
  importHermesSession: importHermesSessionMock,
}))

import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSessionBrowserPrefsStore } from '@/stores/hermes/session-browser-prefs'
import { useSessionPinsStore } from '@/stores/hermes/session-pins'

const LEGACY_KEY = 'hermes_session_pins_v1_default'
const WORK_LEGACY_KEY = 'hermes_session_pins_v1_work'

function httpError(status: number): Error {
  return Object.assign(new Error(`API Error ${status}`), { status })
}

/** A list entry from a server that stores pins. */
function listed(id: string, extra: Record<string, unknown> = {}) {
  return { id, is_pinned: false, profile: 'default', ...extra }
}

function storedPins(key: string): string[] | null {
  const raw = window.localStorage.getItem(key)
  return raw === null ? null : JSON.parse(raw)
}

describe('session pins store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    window.localStorage.clear()
    setSessionPinnedMock.mockReset()
    importHermesSessionMock.mockReset()
    useProfilesStore().activeProfileName = 'default'
  })

  it('writes the pin through the API and returns the server value', async () => {
    setSessionPinnedMock.mockResolvedValue({ ok: true, is_pinned: true })
    const store = useSessionPinsStore()

    await expect(store.setPinned('session-1', true)).resolves.toBe(true)
    expect(setSessionPinnedMock).toHaveBeenCalledWith('session-1', true)

    setSessionPinnedMock.mockResolvedValue({ ok: true, is_pinned: false })
    await expect(store.setPinned('session-1', false)).resolves.toBe(false)
    expect(setSessionPinnedMock).toHaveBeenLastCalledWith('session-1', false)
  })

  it('surfaces a failed pin write to the caller', async () => {
    setSessionPinnedMock.mockRejectedValue(httpError(500))
    const store = useSessionPinsStore()

    await expect(store.setPinned('session-1', true)).rejects.toThrow('API Error 500')
  })

  it('replays the legacy localStorage pins onto the server once and drops the key', async () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(['session-1', 'session-2']))
    setSessionPinnedMock.mockResolvedValue({ ok: true, is_pinned: true })
    const store = useSessionPinsStore()
    const sessions = [listed('session-1'), listed('session-2')]

    await expect(store.migrateLegacyPins(sessions)).resolves.toEqual(['session-1', 'session-2'])
    expect(setSessionPinnedMock).toHaveBeenCalledTimes(2)
    expect(setSessionPinnedMock).toHaveBeenCalledWith('session-1', true)
    expect(setSessionPinnedMock).toHaveBeenCalledWith('session-2', true)
    expect(storedPins(LEGACY_KEY)).toBeNull()

    setSessionPinnedMock.mockClear()
    await expect(store.migrateLegacyPins(sessions)).resolves.toEqual([])
    expect(setSessionPinnedMock).not.toHaveBeenCalled()
  })

  it('does not call the API when there is nothing left to migrate', async () => {
    const store = useSessionPinsStore()

    await expect(store.migrateLegacyPins([listed('session-1')])).resolves.toEqual([])
    expect(setSessionPinnedMock).not.toHaveBeenCalled()
  })

  it('drops a legacy pin the server refuses and keeps migrating the rest', async () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(['deleted-session', 'other-profile-session', 'live-session']))
    setSessionPinnedMock.mockImplementation(async (id: string) => {
      if (id === 'deleted-session') throw httpError(404)
      if (id === 'other-profile-session') throw httpError(403)
      return { ok: true, is_pinned: true }
    })
    const store = useSessionPinsStore()

    await expect(store.migrateLegacyPins([
      listed('deleted-session'),
      listed('other-profile-session'),
      listed('live-session'),
    ])).resolves.toEqual(['live-session'])
    expect(storedPins(LEGACY_KEY)).toBeNull()
  })

  it('keeps the legacy key when the migration hits a transport failure', async () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(['session-1', 'session-2']))
    setSessionPinnedMock.mockImplementation(async (id: string) => {
      if (id === 'session-2') throw httpError(500)
      return { ok: true, is_pinned: true }
    })
    const store = useSessionPinsStore()
    const sessions = [listed('session-1'), listed('session-2')]

    // The pin that landed is reported and removed from the key; session-2 never
    // reached the server, so it is what the next load retries.
    await expect(store.migrateLegacyPins(sessions)).resolves.toEqual(['session-1'])
    expect(storedPins(LEGACY_KEY)).toEqual(['session-2'])

    setSessionPinnedMock.mockResolvedValue({ ok: true, is_pinned: true })
    await expect(store.migrateLegacyPins(sessions)).resolves.toEqual(['session-2'])
    expect(storedPins(LEGACY_KEY)).toBeNull()
  })

  it('migrates the legacy pins of each profile separately', async () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(['default-session']))
    window.localStorage.setItem(WORK_LEGACY_KEY, JSON.stringify(['work-session']))
    setSessionPinnedMock.mockResolvedValue({ ok: true, is_pinned: true })
    const store = useSessionPinsStore()

    await expect(store.migrateLegacyPins([listed('default-session')])).resolves.toEqual(['default-session'])
    expect(storedPins(WORK_LEGACY_KEY)).toEqual(['work-session'])

    useSessionBrowserPrefsStore().profileName = 'work'
    await expect(store.migrateLegacyPins([listed('work-session', { profile: 'work' })]))
      .resolves.toEqual(['work-session'])
    expect(storedPins(WORK_LEGACY_KEY)).toBeNull()
  })

  // Regression: migratelegacypins:profile-switch-clears-wrong-key#p1
  it('keeps another profile legacy pins when the active profile changes mid-migration', async () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(['default-session']))
    window.localStorage.setItem(WORK_LEGACY_KEY, JSON.stringify(['work-session']))
    let releasePin: (value: { ok: boolean; is_pinned: boolean }) => void = () => {}
    setSessionPinnedMock.mockImplementationOnce(() => new Promise(resolve => { releasePin = resolve }))
    const store = useSessionPinsStore()
    const prefs = useSessionBrowserPrefsStore()

    const firstPass = store.migrateLegacyPins([listed('default-session')])
    await Promise.resolve()

    // The user switches profile while the write is still in flight.
    prefs.profileName = 'work'
    releasePin({ ok: true, is_pinned: true })
    await expect(firstPass).resolves.toEqual(['default-session'])

    expect(setSessionPinnedMock).toHaveBeenCalledTimes(1)
    expect(setSessionPinnedMock).toHaveBeenCalledWith('default-session', true)
    expect(storedPins(LEGACY_KEY)).toBeNull()
    expect(storedPins(WORK_LEGACY_KEY)).toEqual(['work-session'])
  })

  // Regression: migratelegacypins:profile-switch-clears-wrong-key#p1
  it('queues a migration that arrives while another one is running instead of dropping it', async () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(['default-session']))
    window.localStorage.setItem(WORK_LEGACY_KEY, JSON.stringify(['work-session']))
    let releasePin: (value: { ok: boolean; is_pinned: boolean }) => void = () => {}
    setSessionPinnedMock.mockImplementationOnce(() => new Promise(resolve => { releasePin = resolve }))
    setSessionPinnedMock.mockResolvedValue({ ok: true, is_pinned: true })
    const store = useSessionPinsStore()
    const prefs = useSessionBrowserPrefsStore()

    const firstPass = store.migrateLegacyPins([listed('default-session')])
    await Promise.resolve()
    prefs.profileName = 'work'
    const secondPass = store.migrateLegacyPins([listed('work-session', { profile: 'work' })])
    releasePin({ ok: true, is_pinned: true })

    await expect(firstPass).resolves.toEqual(['default-session'])
    await expect(secondPass).resolves.toEqual(['work-session'])
    expect(setSessionPinnedMock).toHaveBeenCalledWith('work-session', true)
    expect(storedPins(LEGACY_KEY)).toBeNull()
    expect(storedPins(WORK_LEGACY_KEY)).toBeNull()
  })

  // Regression: migratelegacypins:missing-capability-gate#p1
  it('leaves the legacy pins alone when the session list carries no pin field', async () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(['session-1']))
    const store = useSessionPinsStore()

    const oldServerList = [{ id: 'session-1', profile: 'default' }, { id: 'session-2', profile: 'default' }]
    await expect(store.migrateLegacyPins(oldServerList)).resolves.toEqual([])

    expect(setSessionPinnedMock).not.toHaveBeenCalled()
    expect(storedPins(LEGACY_KEY)).toEqual(['session-1'])
  })

  // Regression: migratelegacypins:missing-capability-gate#p1
  it('leaves the legacy pins alone when no session list arrived at all', async () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(['session-1']))
    const store = useSessionPinsStore()

    await expect(store.migrateLegacyPins([])).resolves.toEqual([])
    await expect(store.migrateLegacyPins()).resolves.toEqual([])

    expect(setSessionPinnedMock).not.toHaveBeenCalled()
    expect(storedPins(LEGACY_KEY)).toEqual(['session-1'])
  })

  // Regression: isresolvedpinrefusal:unimported-history-pins-discarded#p1
  it('keeps a legacy pin whose session the current list does not carry', async () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(['loaded-session', 'not-loaded-session']))
    setSessionPinnedMock.mockResolvedValue({ ok: true, is_pinned: true })
    const store = useSessionPinsStore()

    await expect(store.migrateLegacyPins([listed('loaded-session')])).resolves.toEqual(['loaded-session'])

    expect(setSessionPinnedMock).toHaveBeenCalledTimes(1)
    expect(storedPins(LEGACY_KEY)).toEqual(['not-loaded-session'])

    // The load that finally carries the session migrates it.
    await expect(store.migrateLegacyPins([listed('not-loaded-session')])).resolves.toEqual(['not-loaded-session'])
    expect(storedPins(LEGACY_KEY)).toBeNull()
  })

  // Regression: isresolvedpinrefusal:unimported-history-pins-discarded#p1
  it('imports a Hermes-only session before pinning it instead of discarding the pin', async () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(['hermes-only']))
    setSessionPinnedMock
      .mockRejectedValueOnce(httpError(404))
      .mockResolvedValue({ ok: true, is_pinned: true })
    importHermesSessionMock.mockResolvedValue({ ok: true, imported: true })
    const store = useSessionPinsStore()

    await expect(store.migrateLegacyPins([
      listed('hermes-only', { profile: 'travel', webui_imported: false }),
    ])).resolves.toEqual(['hermes-only'])

    expect(importHermesSessionMock).toHaveBeenCalledWith('hermes-only', 'travel')
    expect(setSessionPinnedMock).toHaveBeenCalledTimes(2)
    expect(storedPins(LEGACY_KEY)).toBeNull()
  })

  // Regression: isresolvedpinrefusal:unimported-history-pins-discarded#p1
  it('keeps the pin when importing the Hermes-only session fails', async () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(['hermes-only']))
    setSessionPinnedMock.mockRejectedValue(httpError(404))
    importHermesSessionMock.mockRejectedValue(httpError(500))
    const store = useSessionPinsStore()

    await expect(store.migrateLegacyPins([
      listed('hermes-only', { profile: 'travel', webui_imported: false }),
    ])).resolves.toEqual([])

    expect(storedPins(LEGACY_KEY)).toEqual(['hermes-only'])
  })

  // Regression: migratelegacypins:retry-overwrites-unpin#p1
  it('does not re-pin a session the user unpinned before the retry', async () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(['session-a', 'session-b']))
    setSessionPinnedMock.mockImplementation(async (id: string) => {
      if (id === 'session-b') throw httpError(500)
      return { ok: true, is_pinned: true }
    })
    const store = useSessionPinsStore()
    const sessions = [listed('session-a'), listed('session-b')]

    await expect(store.migrateLegacyPins(sessions)).resolves.toEqual(['session-a'])
    expect(storedPins(LEGACY_KEY)).toEqual(['session-b'])

    // The user unpins the session that did migrate, then a later load retries.
    setSessionPinnedMock.mockImplementation(async (_id: string, pinned: boolean) => ({ ok: true, is_pinned: pinned }))
    await expect(store.setPinned('session-a', false)).resolves.toBe(false)
    setSessionPinnedMock.mockClear()

    await expect(store.migrateLegacyPins(sessions)).resolves.toEqual(['session-b'])
    expect(setSessionPinnedMock).toHaveBeenCalledTimes(1)
    expect(setSessionPinnedMock).toHaveBeenCalledWith('session-b', true)
    expect(storedPins(LEGACY_KEY)).toBeNull()
  })

  // Regression: migratelegacypins:retry-overwrites-unpin#p1
  it('drops a legacy pin the user unpinned even when another tab wrote the key back', async () => {
    setSessionPinnedMock.mockImplementation(async (_id: string, pinned: boolean) => ({ ok: true, is_pinned: pinned }))
    const store = useSessionPinsStore()

    await expect(store.setPinned('session-a', false)).resolves.toBe(false)
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(['session-a']))
    setSessionPinnedMock.mockClear()

    await expect(store.migrateLegacyPins([listed('session-a')])).resolves.toEqual([])
    expect(setSessionPinnedMock).not.toHaveBeenCalled()
    expect(storedPins(LEGACY_KEY)).toBeNull()
  })
})
