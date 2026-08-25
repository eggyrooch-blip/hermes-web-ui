/**
 * Why the last session ended, carried across the redirect to the login page.
 *
 * `AuthEventListener` learns this (a 401 or a 403 from any request) and has
 * nowhere to show it: it renders nothing, and the app navigates to login
 * immediately afterwards. A toast raised at that moment is either torn down by
 * the navigation or survives just long enough to be missed — and this is exactly
 * the message a user needs, because "session expired" and "access denied" call
 * for different next steps.
 *
 * `sessionStorage`, not a module variable, because the redirect can be a full
 * document load (the token clear path reloads), which would wipe module state.
 * Read-once: the login page consumes it so it cannot resurface on a later,
 * unrelated visit to the login screen.
 */
const KEY = 'hermes_signed_out_reason'

export function setSignedOutReason(reason: string): void {
  try {
    sessionStorage.setItem(KEY, reason)
  } catch {
    // Private browsing / storage disabled: losing the reason is acceptable, the
    // login page simply shows no explanation.
  }
}

/** Returns the reason and clears it, so it is shown exactly once. */
export function takeSignedOutReason(): string {
  try {
    const reason = sessionStorage.getItem(KEY)
    if (reason) sessionStorage.removeItem(KEY)
    return reason || ''
  } catch {
    return ''
  }
}
