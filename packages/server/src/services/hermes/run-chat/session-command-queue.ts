import {
  bindSessionGeneration,
  readSessionGeneration,
  sessionGenerationsEqual,
  stateMatchesSessionGeneration,
} from './session-generation'
import type {
  QueuedRun,
  QueuedSessionCommand,
  SessionCommandReservation,
  SessionState,
} from './types'

type SerializedCommand = Pick<QueuedSessionCommand, 'name' | 'rawName' | 'args'>

/** Per-session queue cap for the bridge path; mirrors broker-controller's MAX_SESSION_QUEUE. */
export const MAX_SESSION_QUEUE = 20
export const SESSION_QUEUE_FULL_ERROR = 'Session queue is full'

export function isSessionQueueFull(state: Pick<SessionState, 'queue'>): boolean {
  return state.queue.length >= MAX_SESSION_QUEUE
}

/** Payload aligned with broker-controller's `run.rejected` for a full queue. */
export function sessionQueueFullRejection(sessionId: string, queueId: string | undefined) {
  return {
    event: 'run.rejected' as const,
    session_id: sessionId,
    queue_id: queueId,
    error: SESSION_QUEUE_FULL_ERROR,
    reason: 'queue_full' as const,
  }
}

export function enqueueSerializedSessionCommand(options: {
  sessionId: string
  command: SerializedCommand
  state: SessionState
  sessionMap: Map<string, SessionState>
  queueId?: string
  model?: string
  provider?: string
  modelGroups?: Array<{ provider: string; models: string[] }>
  instructions?: string
  profile: string
  originSocketId?: string
}):
  | { state: SessionState; queued: QueuedRun; canStart: boolean; rejected?: undefined }
  | { state: SessionState; queued: null; canStart: false; rejected: 'queue_full' } {
  const generation = readSessionGeneration(options.sessionId)
  let state = options.state
  if (!stateMatchesSessionGeneration(state, generation)) {
    state.abortController?.abort()
    state.goalEvaluationAbortController?.abort()
    state.queue.length = 0
    state = { messages: [], isWorking: false, events: [], queue: [] }
    bindSessionGeneration(state, generation)
    options.sessionMap.set(options.sessionId, state)
  }

  if (isSessionQueueFull(state)) return { state, queued: null, canStart: false, rejected: 'queue_full' }

  const rawCommand = `/${options.command.rawName}${options.command.args ? ` ${options.command.args}` : ''}`
  const queued: QueuedRun = {
    queue_id: options.queueId || `queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    input: rawCommand,
    displayInput: rawCommand,
    displayRole: 'command',
    storageMessage: rawCommand,
    model: options.model,
    provider: options.provider,
    model_groups: options.modelGroups,
    instructions: options.instructions,
    profile: options.profile,
    source: 'cli',
    originSocketId: options.originSocketId,
    sessionCommand: {
      ...options.command,
      sessionRowId: generation.rowId,
      sessionIncarnation: generation.incarnation,
    },
  }
  const canStart = !state.isWorking && !state.activeRunMarker
  state.queue.push(queued)
  state.goalEvaluationAbortController?.abort()
  return { state, queued, canStart }
}

export function reserveQueuedSessionCommand(
  sessionId: string,
  state: SessionState,
  next: QueuedRun,
): SessionCommandReservation | null {
  const command = next.sessionCommand
  if (!command || state.isWorking || state.activeRunMarker) return null

  const queuedGeneration = {
    rowId: command.sessionRowId,
    incarnation: command.sessionIncarnation,
  }
  let currentGeneration
  try {
    currentGeneration = readSessionGeneration(sessionId)
  } catch {
    return null
  }
  if (
    !sessionGenerationsEqual(currentGeneration, queuedGeneration)
    || !stateMatchesSessionGeneration(state, currentGeneration)
  ) return null

  const reservation: SessionCommandReservation = {
    marker: `command_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    sessionRowId: currentGeneration.rowId,
    sessionIncarnation: currentGeneration.incarnation,
  }
  state.isWorking = true
  state.isAborting = false
  state.events = []
  state.profile = next.profile
  state.source = next.source || 'cli'
  state.activeRunMarker = reservation.marker
  state.commandReservationMarker = reservation.marker
  state.runId = reservation.marker
  state.abortController = new AbortController()
  next.commandReservation = reservation
  return reservation
}

export function createSessionCommandFence(
  sessionId: string,
  state: SessionState,
  sessionMap: Map<string, SessionState>,
  reservation: SessionCommandReservation,
) {
  const reservationController = state.abortController
  const generationMatches = () => {
    const expected = {
      rowId: reservation.sessionRowId,
      incarnation: reservation.sessionIncarnation,
    }
    return state.sessionRowId === expected.rowId
      && state.sessionIncarnation === expected.incarnation
      && sessionGenerationsEqual(readSessionGeneration(sessionId), expected)
  }
  const owns = () => {
    if (
      sessionMap.get(sessionId) !== state
      || state.activeRunMarker !== reservation.marker
      || state.commandReservationMarker !== reservation.marker
      || state.runId !== reservation.marker
      || state.abortController !== reservationController
      || state.isAborting
      || reservationController?.signal.aborted
    ) return false
    try {
      return generationMatches()
    } catch {
      return false
    }
  }
  const release = () => {
    if (
      sessionMap.get(sessionId) !== state
      || state.activeRunMarker !== reservation.marker
      || state.commandReservationMarker !== reservation.marker
      || state.runId !== reservation.marker
      || state.abortController !== reservationController
    ) return false
    reservationController?.abort()
    state.isWorking = false
    state.isAborting = false
    state.abortController = undefined
    state.runId = undefined
    state.activeRunMarker = undefined
    state.commandReservationMarker = undefined
    state.responseRun = undefined
    state.profile = undefined
    state.events = []
    return true
  }
  const abandon = () => {
    if (
      sessionMap.get(sessionId) !== state
      || state.activeRunMarker !== reservation.marker
      || state.commandReservationMarker !== reservation.marker
      || state.runId !== reservation.marker
      || state.abortController !== reservationController
    ) return
    let generationCurrent = false
    try {
      generationCurrent = generationMatches()
    } catch {
      generationCurrent = false
    }
    if (!release()) return
    if (!generationCurrent && sessionMap.get(sessionId) === state) {
      state.queue.length = 0
      sessionMap.delete(sessionId)
    }
  }
  return { abandon, owns, release }
}

export function cancelReservedSessionCommand(
  sessionId: string,
  state: SessionState,
  sessionMap: Map<string, SessionState>,
): { currentGeneration: boolean; runId: string } | null {
  const marker = state.commandReservationMarker
  if (
    !marker
    || sessionMap.get(sessionId) !== state
    || state.activeRunMarker !== marker
    || state.runId !== marker
  ) return null

  let currentGeneration = false
  try {
    currentGeneration = sessionGenerationsEqual(readSessionGeneration(sessionId), {
      rowId: state.sessionRowId ?? null,
      incarnation: state.sessionIncarnation ?? null,
    })
  } catch {
    currentGeneration = false
  }

  state.abortController?.abort()
  state.isWorking = false
  state.isAborting = false
  state.abortController = undefined
  state.runId = undefined
  state.activeRunMarker = undefined
  state.commandReservationMarker = undefined
  state.responseRun = undefined
  state.profile = undefined
  state.events = []
  if (!currentGeneration && sessionMap.get(sessionId) === state) {
    state.queue.length = 0
    sessionMap.delete(sessionId)
  }
  return { currentGeneration, runId: marker }
}
