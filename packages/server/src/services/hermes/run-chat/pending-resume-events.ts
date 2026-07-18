import type { PendingResumeEvent, SessionState } from './types'

const MAX_PENDING_EVENTS = 20
const MAX_ACKNOWLEDGED_SOCKETS = 100

export function recordPendingResumeEvent(state: SessionState, event: string, data: any): string {
  const id = `terminal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  const pending = state.pendingTerminalEvents || []
  pending.push({ id, event, data })
  state.pendingTerminalEvents = pending.slice(-MAX_PENDING_EVENTS)
  return id
}

export function acknowledgePendingResumeEvents(
  state: SessionState,
  socketId: string,
  eventIds: Set<string>,
): void {
  for (const event of state.pendingTerminalEvents || []) {
    if (!eventIds.has(event.id)) continue
    event.acknowledgedSocketIds ||= new Set()
    event.acknowledgedSocketIds.add(socketId)
    while (event.acknowledgedSocketIds.size > MAX_ACKNOWLEDGED_SOCKETS) {
      const oldest = event.acknowledgedSocketIds.values().next().value
      if (oldest === undefined) break
      event.acknowledgedSocketIds.delete(oldest)
    }
  }
}

export function pendingResumeEventsForSocket(
  state: SessionState,
  socketId: string,
): Array<Pick<PendingResumeEvent, 'id' | 'event' | 'data'>> {
  return (state.pendingTerminalEvents || [])
    .filter(event => !event.acknowledgedSocketIds?.has(socketId))
    .map(({ id, event, data }) => ({ id, event, data }))
}
