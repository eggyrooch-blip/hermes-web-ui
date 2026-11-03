/**
 * Which pending requests this tab has already raised a system notification for.
 *
 * It lives in `sessionStorage`, not in a module-level Set: the server keeps
 * pending approval / clarify / authorization requests open and replays them on
 * resume, so a reload of a backgrounded tab would otherwise notify a second
 * time for a request the user was already told about. `sessionStorage` is
 * per-tab and per-origin, which is exactly the scope this dedupe needs — a
 * genuinely new tab has not shown the user anything yet and should notify.
 *
 * Entries are keyed `kind:sessionId:requestId`, so they are already unique
 * across profiles and runtime modes. Only deliveries that actually reached the
 * user are written here; a failed delivery must stay eligible for a retry.
 */
export const PENDING_REQUEST_NOTIFICATION_LEDGER_KEY = 'hermes-pending-request-notifications-v1'

/** Oldest-first eviction cap, so a long-lived tab cannot grow the entry unbounded. */
export const PENDING_REQUEST_NOTIFICATION_LEDGER_LIMIT = 500

function storage(): Storage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null
    return sessionStorage
  } catch {
    // Blocked storage (private mode, hardened settings) degrades to in-memory
    // dedupe only; notifying twice after a reload beats not notifying at all.
    return null
  }
}

export function loadNotifiedPendingRequests(): string[] {
  const store = storage()
  if (!store) return []
  try {
    const parsed = JSON.parse(store.getItem(PENDING_REQUEST_NOTIFICATION_LEDGER_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  } catch {
    return []
  }
}

function save(keys: string[]) {
  const store = storage()
  if (!store) return
  try {
    store.setItem(PENDING_REQUEST_NOTIFICATION_LEDGER_KEY, JSON.stringify(keys))
  } catch {
    // Quota or blocked storage — in-memory dedupe still holds for this page.
  }
}

/** Record a notification the user actually received. */
export function persistNotifiedPendingRequest(key: string) {
  const keys = loadNotifiedPendingRequests().filter(entry => entry !== key)
  keys.push(key)
  save(keys.slice(-PENDING_REQUEST_NOTIFICATION_LEDGER_LIMIT))
}

/** Drop a key once the request it describes is resolved. */
export function forgetNotifiedPendingRequest(key: string) {
  const keys = loadNotifiedPendingRequests()
  const next = keys.filter(entry => entry !== key)
  if (next.length === keys.length) return
  save(next)
}

export function clearNotifiedPendingRequests() {
  const store = storage()
  if (!store) return
  try {
    store.removeItem(PENDING_REQUEST_NOTIFICATION_LEDGER_KEY)
  } catch {
    // Nothing to do — a blocked store had nothing persisted either.
  }
}
