import {
  createSession,
  getSessionIncarnation,
  getSessionRowId,
} from '../../../db/hermes/session-store'

export interface SessionGeneration {
  rowId: number | null
  incarnation: number | null
}

export interface SessionGenerationState {
  sessionRowId?: number | null
  sessionIncarnation?: number | null
}

export function readSessionGeneration(sessionId: string): SessionGeneration {
  return {
    rowId: getSessionRowId(sessionId),
    incarnation: getSessionIncarnation(sessionId),
  }
}

export function bindSessionGeneration(
  state: SessionGenerationState,
  generation: SessionGeneration,
): void {
  state.sessionRowId = generation.rowId
  state.sessionIncarnation = generation.incarnation
}

export function stateMatchesSessionGeneration(
  state: SessionGenerationState,
  generation: SessionGeneration,
): boolean {
  if (state.sessionRowId === undefined && state.sessionIncarnation === undefined) {
    bindSessionGeneration(state, generation)
    return true
  }
  return state.sessionRowId === generation.rowId && state.sessionIncarnation === generation.incarnation
}

export function sessionGenerationsEqual(
  left: SessionGeneration,
  right: SessionGeneration,
): boolean {
  return left.rowId === right.rowId && left.incarnation === right.incarnation
}

export async function loadSessionStateWithGenerationFence<T extends SessionGenerationState>(options: {
  sessionId: string
  getState: () => T | undefined
  setState: (state: T) => void
  discardState: (state: T) => void
  loadState: () => Promise<T>
}): Promise<T> {
  while (true) {
    const observed = options.getState()
    const generation = readSessionGeneration(options.sessionId)
    if (observed && stateMatchesSessionGeneration(observed, generation)) return observed

    if (observed) options.discardState(observed)
    const expected = options.getState()
    const loadGeneration = readSessionGeneration(options.sessionId)
    const loaded = await options.loadState()
    const current = options.getState()
    const currentGeneration = readSessionGeneration(options.sessionId)

    if (current !== expected || !sessionGenerationsEqual(loadGeneration, currentGeneration)) {
      if (current && stateMatchesSessionGeneration(current, currentGeneration)) return current
      if (current) options.discardState(current)
      continue
    }

    bindSessionGeneration(loaded, currentGeneration)
    options.setState(loaded)
    return loaded
  }
}

export function createSessionAndBind(
  state: SessionGenerationState,
  data: Parameters<typeof createSession>[0],
): ReturnType<typeof createSession> {
  const session = createSession(data)
  try {
    bindSessionGeneration(state, readSessionGeneration(data.id))
  } catch (err) {
    // The row already exists and its incarnation was renewed. Rebind once so
    // the caller can fail visibly without leaving queued work attached to the
    // pre-create {null,null} generation, then preserve the original setup error.
    try {
      bindSessionGeneration(state, readSessionGeneration(data.id))
    } catch {
      // The caller's exact-state fail-safe remains responsible for cleanup.
    }
    throw err
  }
  return session
}
