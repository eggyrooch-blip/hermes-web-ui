/**
 * Where a pending-request system notification sends the user back to.
 *
 * The profile matters: `ChatView.preferredSessionProfileFilter` falls back to
 * whatever profile the user is currently browsing, and `loadSessions` only
 * looks for the target session inside that profile. Without `?profile=`, a
 * notification raised for profile A and clicked while the user sits in profile
 * B lands on the chat home instead of the session that is waiting for an
 * answer — the same happens when the service worker focuses a different window
 * that is browsing B.
 *
 * Shared by the chat store (which builds the notification) and the service
 * worker click target (`/#${clickUrl}`), so both paths route identically.
 */
export function pendingRequestClickUrl(sessionId: string, profile?: string | null): string {
  const base = `/hermes/session/${encodeURIComponent(sessionId)}`
  const name = String(profile || '').trim()
  return name ? `${base}?profile=${encodeURIComponent(name)}` : base
}
