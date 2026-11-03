import type { KanbanTaskStatus } from '@/api/hermes/kanban'

// Which board transitions a drag may perform, and through which endpoint.
//
// The set is deliberately narrow: these three are the only status writes the
// chat plane lets through (request-context.ts `isChatPlaneKanbanTaskAction`
// allows POST /kanban/complete, POST /kanban/unblock and POST /kanban/:id/block).
// POST /kanban/tasks/bulk is NOT on that allowlist and 403s for every chat-plane
// user, so dragging must never route through it.
export type KanbanDropAction = 'complete' | 'block' | 'unblock'

export const KANBAN_DROP_TARGET_STATUSES: readonly KanbanTaskStatus[] = ['ready', 'blocked', 'done']

// `hermes kanban complete` closes any open task; archived is already terminal.
const COMPLETABLE: ReadonlySet<KanbanTaskStatus> = new Set<KanbanTaskStatus>([
  'triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review',
])

// `hermes kanban block` needs a task that is still open.
const BLOCKABLE: ReadonlySet<KanbanTaskStatus> = new Set<KanbanTaskStatus>([
  'triage', 'todo', 'scheduled', 'ready', 'running', 'review',
])

// `hermes kanban unblock` exits with "cannot unblock <id> (not blocked/scheduled?)"
// for anything else, so only offer it where core will accept it.
const UNBLOCKABLE: ReadonlySet<KanbanTaskStatus> = new Set<KanbanTaskStatus>(['blocked', 'scheduled'])

export function isKanbanDropTarget(status: KanbanTaskStatus): boolean {
  return KANBAN_DROP_TARGET_STATUSES.includes(status)
}

/** The endpoint a drop should call, or null when the move is not offered. */
export function resolveKanbanDropAction(
  from: KanbanTaskStatus,
  to: KanbanTaskStatus,
): KanbanDropAction | null {
  if (from === to) return null
  switch (to) {
    case 'done': return COMPLETABLE.has(from) ? 'complete' : null
    case 'blocked': return BLOCKABLE.has(from) ? 'block' : null
    case 'ready': return UNBLOCKABLE.has(from) ? 'unblock' : null
    default: return null
  }
}
