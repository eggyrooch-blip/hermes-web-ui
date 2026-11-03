import type { PendingResumeEvent, SessionState } from './types'

const MAX_PENDING_EVENTS = 20

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
  acknowledgeResumeEvents(state.pendingTerminalEvents || [], socketId, eventIds)
}

export function acknowledgeResumeEvents(
  events: Iterable<PendingResumeEvent>,
  socketId: string,
  eventIds: Set<string>,
): void {
  for (const event of events) {
    if (!eventIds.has(event.id)) continue
    event.acknowledgedSocketIds ||= new Set()
    event.acknowledgedSocketIds.add(socketId)
  }
}

export function forgetResumeEventAcknowledgement(
  events: Iterable<PendingResumeEvent>,
  socketId: string,
): void {
  for (const event of events) {
    event.acknowledgedSocketIds?.delete(socketId)
    if (event.acknowledgedSocketIds?.size === 0) delete event.acknowledgedSocketIds
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
