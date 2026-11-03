import type { SessionState } from './types'
import {
  bindSessionGeneration,
  readSessionGeneration,
  sessionGenerationsEqual,
  type SessionGeneration,
} from './session-generation'

export interface SessionRunOwnership {
  sessionId: string
  state: SessionState
  runMarker: string
  generation: SessionGeneration
}

export function captureSessionRunOwnership(
  sessionId: string,
  state: SessionState,
  runMarker: string,
): SessionRunOwnership {
  const generation = state.sessionRowId !== undefined || state.sessionIncarnation !== undefined
    ? {
        rowId: state.sessionRowId ?? null,
        incarnation: state.sessionIncarnation ?? null,
      }
    : readSessionGeneration(sessionId)
  if (state.sessionRowId === undefined && state.sessionIncarnation === undefined) {
    bindSessionGeneration(state, generation)
  }
  return { sessionId, state, runMarker, generation }
}

export function ownsSessionRun(
  sessionMap: Map<string, SessionState>,
  ownership: SessionRunOwnership,
): boolean {
  if (!ownsSessionGeneration(sessionMap, ownership)) return false
  return ownership.state.activeRunMarker === ownership.runMarker
}

export function ownsSessionGeneration(
  sessionMap: Map<string, SessionState>,
  ownership: SessionRunOwnership,
): boolean {
  if (sessionMap.get(ownership.sessionId) !== ownership.state) return false
  try {
    return sessionGenerationsEqual(readSessionGeneration(ownership.sessionId), ownership.generation)
  } catch {
    return false
  }
}
