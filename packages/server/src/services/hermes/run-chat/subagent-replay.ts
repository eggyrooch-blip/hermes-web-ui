/**
 * Subagent card replay.
 *
 * A delegated subagent renders in chat as one `delegate_task` tool card, keyed
 * client-side by `subagent:${run_id}:${subagent_id}` (falling back to
 * `task_index`). The card is UI state only — it is never written to the message
 * table — so the only thing that can rebuild it after a reload or a dropped
 * socket is the session's replayable event list.
 *
 * Two client paths consume a resume, and they behave differently:
 *  - the session-switch path replays `resumed.events` and does handle
 *    `subagent.*`, so a snapshot left in the list rebuilds the card;
 *  - the in-run reconnect paths switch on a fixed event list that has no
 *    `subagent.*` case, so those need the server to re-emit the snapshot under
 *    the same event names the socket already listens on.
 *
 * Both need at most ONE frame per card, and that frame must be the newest
 * meaningful one. `subagent.text` / `subagent.thinking` have no client listener
 * and carry no card status, so they never enter the cache; and once a card has
 * completed, a late non-complete frame must not drag it back to "running".
 */

/**
 * The only subagent events the chat client registers socket listeners for.
 * Replaying anything else is a silent no-op, so the cache keeps just these.
 */
export const REPLAYABLE_SUBAGENT_EVENTS: ReadonlySet<string> = new Set([
  'subagent.start',
  'subagent.tool',
  'subagent.progress',
  'subagent.complete',
])

export function isReplayableSubagentEvent(event: unknown): boolean {
  return REPLAYABLE_SUBAGENT_EVENTS.has(String(event || ''))
}

/**
 * Terminal events for the PARENT run. A subagent that never reported its own
 * completion when one of these lands did not finish — it was cut off with the
 * run (stopped, failed, broker gone). Replaying it as `running` leaves a card
 * spinning forever, so it is rewritten to a terminal `interrupted`.
 */
export const RUN_TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  'run.completed',
  'run.failed',
  'abort.completed',
])

export const SUBAGENT_INTERRUPTED_STATUS = 'interrupted'

/** The `subagent.complete` + `status: 'interrupted'` form of an unfinished card. */
export function interruptedSubagentSnapshot(data: any): SubagentReplaySnapshot {
  return {
    event: 'subagent.complete',
    data: {
      ...data,
      event: 'subagent.complete',
      status: SUBAGENT_INTERRUPTED_STATUS,
    },
  }
}

/**
 * Mirrors the client's card identity so one stored frame maps to exactly one
 * rendered card. Scoped by run so two runs in a session keep separate cards.
 */
export function subagentReplayKey(data: any): string {
  const subagentId = String(data?.subagent_id || `${data?.task_index ?? 0}`)
  return `${String(data?.run_id || data?.response_id || '')}|${subagentId}`
}

/**
 * True when `next` may replace the frame already cached for the same card.
 * A completed card is terminal: only another `subagent.complete` can rewrite it.
 */
export function subagentSnapshotSupersedes(previous: string | undefined, next: string): boolean {
  if (!previous) return true
  if (previous === 'subagent.complete') return next === 'subagent.complete'
  return true
}

export interface SubagentReplaySnapshot {
  event: string
  data: any
}

export interface ReplayableSubagentOptions {
  /**
   * Rewrite every still-unfinished card as `interrupted`. Set when the session
   * is idle: no run is streaming, so nothing will ever complete these cards.
   * It is the safety net for the paths that record no terminal event at all —
   * an abort, a broker that died, an idle session — and it covers bridge runs
   * too, since they share this replay list.
   */
  interrupted?: boolean
}

/**
 * One frame per subagent card, newest wins, completions protected, in the order
 * the cards first appeared.
 */
export function replayableSubagentEvents(
  events?: Array<{ event: string; data: any }> | null,
  options: ReplayableSubagentOptions = {},
): SubagentReplaySnapshot[] {
  const byCard = new Map<string, SubagentReplaySnapshot>()
  for (const item of events || []) {
    const event = String(item?.event || '')
    if (!isReplayableSubagentEvent(event)) continue
    const key = subagentReplayKey(item.data)
    // Map.set on an existing key keeps the original insertion slot, so cards
    // replay in the order they first appeared, not in update order.
    if (!subagentSnapshotSupersedes(byCard.get(key)?.event, event)) continue
    byCard.set(key, { event, data: item.data })
  }
  const snapshots = [...byCard.values()].sort((a, b) => (Number(a.data?.created_at) || 0) - (Number(b.data?.created_at) || 0))
  if (!options.interrupted) return snapshots
  return snapshots.map(snapshot => (
    snapshot.event === 'subagent.complete' ? snapshot : interruptedSubagentSnapshot(snapshot.data)
  ))
}

/**
 * Rewrite the unfinished cards of one run in place, keeping each snapshot in
 * its original slot. Called when the parent run reaches a terminal event, so
 * the stored list is already correct before anybody resumes.
 */
export function interruptUnfinishedSubagentSnapshots(
  events: Array<{ event: string; data: any }>,
  runId?: string,
): void {
  const scope = String(runId || '')
  for (let index = 0; index < events.length; index++) {
    const item = events[index]
    const event = String(item?.event || '')
    if (!isReplayableSubagentEvent(event) || event === 'subagent.complete') continue
    if (scope && String(item.data?.run_id || item.data?.response_id || '') !== scope) continue
    events[index] = interruptedSubagentSnapshot(item.data)
  }
}
