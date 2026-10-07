/**
 * Countdown text for the inline authorization card.
 *
 * The broker's `expires_at` is epoch seconds but is NOT guaranteed to be an
 * integer — a float deadline used to leak straight onto the screen as
 * `剩余 8m 33.942726850509644s`. Everything here is floored and clamped so the
 * card can only ever show whole, non-negative seconds.
 *
 * Returns '' when there is no deadline to show at all (missing, NaN, or a
 * non-positive `expires_at`), so the caller can simply `v-if` on the result.
 */
export function formatAuthorizationRemaining(
  expiresAtSeconds: number | undefined | null,
  nowSeconds: number,
): string {
  const expiresAt = Number(expiresAtSeconds)
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return ''
  const now = Number.isFinite(nowSeconds) ? nowSeconds : 0
  // Clamp at zero: a deadline already in the past reads as 0s, never negative.
  const remaining = Math.max(0, Math.floor(expiresAt - now))
  const minutes = Math.floor(remaining / 60)
  const seconds = remaining % 60
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}
