/**
 * Which reasoning depth a single turn runs at.
 *
 * Two inputs disagree constantly: what this run request carries, and what the
 * session row remembers. The rule is `??`, never `||`, and the difference is a
 * real bug either way round:
 *
 * - `''` is the client saying "the user cleared the override". It MUST beat the
 *   row — with `||` a clear fell through to the stale stored value and the turn
 *   kept thinking at the depth the user just turned off.
 * - `undefined` means this caller never had the slider in hand (a resumed run, a
 *   goal continuation, anything server-derived). Only then does the row speak.
 *
 * The result is '' when there is no override at all, and callers omit the field
 * entirely in that case so the profile/config default still applies.
 */
export function resolveRunReasoningEffort(
  requested: unknown,
  storedRowValue?: string | null,
): string {
  const requestedEffort = typeof requested === 'string' ? requested : undefined
  return requestedEffort ?? storedRowValue ?? ''
}
