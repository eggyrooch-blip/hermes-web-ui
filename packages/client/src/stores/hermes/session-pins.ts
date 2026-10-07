import { defineStore } from 'pinia'
import { ref } from 'vue'
import { importHermesSession, setSessionPinned } from '@/api/hermes/sessions'
import { useSessionBrowserPrefsStore } from './session-browser-prefs'

/**
 * A session list entry as the server sent it. `is_pinned` being absent — not
 * false — is how a server that predates pins identifies itself.
 */
export interface PinnableSessionSummary {
  id: string
  is_pinned?: boolean
  profile?: string | null
  webui_imported?: boolean
}

interface SetPinnedOptions {
  profile?: string | null
  /**
   * Pin a History row that Studio never imported by creating the local row
   * first, through the fenced import endpoint.
   */
  importIfMissing?: boolean
}

function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : null
}

/** The row is not this account's, and no retry will change that. */
function isOwnershipRefusal(error: unknown): boolean {
  return errorStatus(error) === 403
}

/** No session row behind this id on the server. */
function isMissingRowRefusal(error: unknown): boolean {
  return errorStatus(error) === 404
}

/**
 * Evidence that this server stores pins at all. A server from before the
 * feature answers the session list without the field and 404s the pin endpoint,
 * so replaying the legacy pins against it would destroy the only copy the user
 * has. No evidence means the migration does not run and storage is untouched.
 */
export function listReportsPinState(sessions: PinnableSessionSummary[]): boolean {
  return sessions.some(session => session.is_pinned !== undefined)
}

/**
 * Session pins, written to the sessions table so every browser the same account
 * signs in from sees one pinned set. The store also carries the one-shot import
 * of the pins the old client kept in localStorage.
 */
export const useSessionPinsStore = defineStore('session-pins', () => {
  const migrating = ref(false)
  /**
   * Sessions this page load explicitly unpinned. A migration that is retried
   * after a partial failure must not resurrect a pin the user just removed.
   */
  const unpinnedByUser = ref(new Set<string>())
  /**
   * Migrations run one at a time but are never dropped: a profile switch that
   * lands mid-flight queues its own pass instead of being swallowed.
   */
  let queue: Promise<unknown> = Promise.resolve()

  async function setPinned(
    sessionId: string,
    pinned: boolean,
    options: SetPinnedOptions = {},
  ): Promise<boolean> {
    let result: { ok: boolean; is_pinned: boolean }
    try {
      result = await setSessionPinned(sessionId, pinned)
    } catch (error) {
      if (!options.importIfMissing || !isMissingRowRefusal(error)) throw error
      // History lists Hermes sessions that have no Studio row yet; the pin flag
      // lives on that row, so build it the same way the Import action does.
      await importHermesSession(sessionId, options.profile ?? null)
      result = await setSessionPinned(sessionId, pinned)
    }
    if (pinned) unpinnedByUser.value.delete(sessionId)
    else unpinnedByUser.value.add(sessionId)
    return Boolean(result.is_pinned)
  }

  async function runMigration(sessions: PinnableSessionSummary[]): Promise<string[]> {
    if (!listReportsPinState(sessions)) return []
    const prefs = useSessionBrowserPrefsStore()
    // Captured once. Everything below reads and writes this profile's key, even
    // if the active profile changes while the writes are in flight.
    const profile = prefs.profileName
    let pending = prefs.legacyPinnedIds(profile)
    if (pending.length === 0) return []

    const summaries = new Map(sessions.map(session => [session.id, session]))
    const migrated: string[] = []

    function settle(id: string) {
      // Persisted per id, not once at the end: whatever already moved must not
      // be replayed by a later retry, even if this pass dies halfway.
      pending = pending.filter(entry => entry !== id)
      prefs.writeLegacyPins(profile, pending)
    }

    migrating.value = true
    try {
      for (const id of [...pending]) {
        // An explicit unpin outranks the legacy pin for good.
        if (unpinnedByUser.value.has(id)) {
          settle(id)
          continue
        }
        const summary = summaries.get(id)
        // Not in this list yet — a History pin for a session the current page
        // did not load says nothing about whether the session still exists.
        if (!summary) continue
        try {
          if (await setPinned(id, true, {
            profile: summary.profile ?? profile,
            importIfMissing: summary.webui_imported === false,
          })) {
            migrated.push(id)
          }
          settle(id)
        } catch (error) {
          // Gone or not ours: drop it. Anything else is the transport, so stop
          // and leave the rest of the list for the next load.
          if (!isOwnershipRefusal(error) && !isMissingRowRefusal(error)) break
          settle(id)
        }
      }
    } finally {
      migrating.value = false
    }
    return migrated
  }

  /**
   * Replay the active profile's legacy localStorage pins onto the session rows,
   * then drop the key. Returns the ids that are now pinned server-side.
   */
  function migrateLegacyPins(sessions: PinnableSessionSummary[] = []): Promise<string[]> {
    const run = queue.then(() => runMigration(sessions), () => runMigration(sessions))
    queue = run.catch(() => undefined)
    return run
  }

  return {
    migrating,
    unpinnedByUser,
    setPinned,
    migrateLegacyPins,
  }
})
