/**
 * Abort handler — cancels in-progress runs (both API server and CLI bridge).
 */

import type { Server, Socket } from 'socket.io'
import { updateSessionStats } from '../../../db/hermes/session-store'
import { logger } from '../../logger'
import { codingAgentRunManager } from '../../agent-runner/coding-agent-run-manager'
import { flushBridgePendingToDb } from './bridge-message'
import { flushResponseRunToDb } from './response-stream'
import { replaceState } from './compression'
import { calcAndUpdateUsage } from './usage'
import type { QueuedRun, SessionState } from './types'
import { finalizeBridgeAbort } from './bridge-abort-finalizer'
import { cancelReservedSessionCommand } from './session-command-queue'
import {
  captureSessionRunOwnership,
  ownsSessionRun,
  type SessionRunOwnership,
} from './session-run-ownership'
import { recordPendingResumeEvent } from './pending-resume-events'

const ABORT_BRIDGE_SYNC_TIMEOUT_MESSAGE = 'Hermes Agent did not confirm stop before timeout. Local run state was released so you can continue.'

function isBridgeRunSource(source?: string): boolean {
  return source === 'cli' || source === 'global_agent'
}

export async function handleAbort(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  sessionId: string,
  sessionMap: Map<string, SessionState>,
  bridge: any,
  _runQueuedItem: (socket: Socket, sessionId: string, next: QueuedRun, fallbackProfile?: string) => void,
  dequeueNextQueuedRun?: (socket: Socket, sessionId: string, fallbackProfile?: string) => boolean,
) {
  let state = sessionMap.get(sessionId)
  const hasCodingAgentRun = codingAgentRunManager.hasSession(sessionId)
  if (!state && hasCodingAgentRun) {
    state = { messages: [], isWorking: true, events: [], queue: [], source: 'coding_agent' }
    sessionMap.set(sessionId, state)
  }
  const isCodingAgentRun = state?.source === 'coding_agent' || hasCodingAgentRun
  if ((!state?.isWorking && !hasCodingAgentRun) || (state && !isCodingAgentRun && !state.runId && !state.abortController && !state.activeRunMarker)) {
    logger.info({ sessionId }, '[chat-run-socket][abort] ignored: no active run')
    if (state) {
      state.isWorking = false
      state.isAborting = false
      state.abortController = undefined
      state.runId = undefined
      state.events = []
    }
    emitToSession(nsp, socket, sessionId, 'abort.completed', {
      event: 'abort.completed',
      synced: false,
      ignored: true,
    })
    return
  }

  const activeState = state
  if (!activeState) return
  const runOwnership = activeState.activeRunMarker
    ? captureSessionRunOwnership(sessionId, activeState, activeState.activeRunMarker)
    : undefined
  const stillOwnsRun = () => !runOwnership || ownsSessionRun(sessionMap, runOwnership)

  const runId = activeState.runId
  if (!activeState.isAborting) activeState.abortFinalizationError = undefined
  activeState.isAborting = true
  activeState.goalEvaluationAbortController?.abort()
  if (isBridgeRunSource(activeState.source)) activeState.abortController?.abort()
  replaceState(sessionMap, sessionId, 'abort.started', {
    event: 'abort.started',
    run_id: runId,
    graceMs: 5000,
  })
  emitToSession(nsp, socket, sessionId, 'abort.started', {
    event: 'abort.started',
    run_id: runId,
    graceMs: 5000,
  })
  logger.info({ sessionId, runId }, '[chat-run-socket][abort] started')

  // Flush in-memory assistant text to DB before aborting the stream.
  try {
    if (isBridgeRunSource(activeState.source)) {
      flushBridgePendingToDb(activeState, sessionId)
    } else {
      flushResponseRunToDb(activeState, sessionId)
    }
  } catch (err) {
    activeState.abortFinalizationError = finalizationFailure(err)
    logger.warn({ err, sessionId, runId }, '[chat-run-socket][abort] failed to flush pending output')
  }

  if (isBridgeRunSource(activeState.source)) {
    // /plan, /goal and /subgoal reserve the session while the bridge command
    // lookup is in flight, but no output stream exists to own abort cleanup.
    // Cancel that exact reservation synchronously so a bridge command that
    // never returns cannot leave the session stuck in an aborting state.
    const commandProfile = activeState.profile
    const commandFinalizationError = activeState.abortFinalizationError
    const cancelledCommand = cancelReservedSessionCommand(sessionId, activeState, sessionMap)
    if (cancelledCommand) {
      if (!cancelledCommand.currentGeneration) return
      const queueLength = activeState.queue.length
      activeState.abortFinalizationError = undefined
      emitToSession(nsp, socket, sessionId, 'abort.completed', {
        event: 'abort.completed',
        run_id: cancelledCommand.runId,
        synced: true,
        failure_pending: Boolean(commandFinalizationError),
        ...(queueLength > 0 ? { queue_length: queueLength } : {}),
      })
      if (commandFinalizationError) {
        emitToSession(nsp, socket, sessionId, 'run.failed', {
          event: 'run.failed',
          run_id: cancelledCommand.runId,
          error: commandFinalizationError,
          queue_remaining: queueLength,
        })
      }
      if (queueLength > 0) {
        dequeueNextQueuedRun?.(socket, sessionId, commandProfile || 'default')
      }
      logger.info({ sessionId, runId: cancelledCommand.runId }, '[chat-run-socket][abort] cancelled reserved bridge command')
      return
    }

    let interruptResult: any = null
    let interruptFailed = false
    try {
      interruptResult = await bridge.interrupt(sessionId, 'Aborted by user', activeState.profile)
    } catch (err) {
      interruptFailed = true
      logger.warn(err, '[chat-run-socket][abort] failed to interrupt CLI bridge for session %s', sessionId)
    }
    if (!stillOwnsRun()) return
    try {
      await bridge.goalPause?.(sessionId, 'user-interrupted', activeState.profile)
      if (!stillOwnsRun()) return
      activeState.queue = activeState.queue.filter(item => !item.goalContinuation)
    } catch (err) {
      logger.debug(err, '[chat-run-socket][abort] goal pause-on-interrupt skipped for session %s', sessionId)
    }
    if (!stillOwnsRun()) return
    if (interruptFailed || interruptResult?.synced === false) {
      replaceState(sessionMap, sessionId, 'abort.timeout', {
        event: 'abort.timeout',
        run_id: runId,
        synced: false,
        message: ABORT_BRIDGE_SYNC_TIMEOUT_MESSAGE,
      })
      emitToSession(nsp, socket, sessionId, 'abort.timeout', {
        event: 'abort.timeout',
        run_id: runId,
        synced: false,
        message: ABORT_BRIDGE_SYNC_TIMEOUT_MESSAGE,
      })
      logger.warn({ sessionId, runId }, '[chat-run-socket][abort] CLI bridge interrupt did not sync before timeout')
      try {
        await bridge.destroy?.(sessionId, activeState.profile)
      } catch (err) {
        logger.warn(err, '[chat-run-socket][abort] failed to destroy timed-out CLI bridge session %s', sessionId)
      }
      if (!stillOwnsRun()) return
      const finalized = await finalizeBridgeAbort(activeState, false)
      if (!finalized && runOwnership && stillOwnsRun()) {
        await markAbortCompleted(
          nsp,
          socket,
          sessionId,
          runId || 'bridge_abort_timeout',
          sessionMap,
          dequeueNextQueuedRun,
          false,
          runOwnership,
        )
      }
      return
    }
    if (!activeState.runId) {
      const finalized = await finalizeBridgeAbort(activeState, true)
      if (!finalized && runOwnership && stillOwnsRun()) {
        await markAbortCompleted(
          nsp,
          socket,
          sessionId,
          runId || runOwnership.runMarker,
          sessionMap,
          dequeueNextQueuedRun,
          true,
          runOwnership,
        )
      }
      return
    }
    // The stream owns terminal ordering: it completes the workspace diff and
    // invokes the one generation-bound finalizer after the terminal chunk.
    return
  } else if (activeState.source === 'coding_agent') {
    codingAgentRunManager.stop(sessionId, { reportClosed: false })
  } else if (activeState.abortController) {
    activeState.abortController.abort()
  }

  await markAbortCompleted(
    nsp,
    socket,
    sessionId,
    runId || 'response_stream',
    sessionMap,
    dequeueNextQueuedRun,
    true,
    runOwnership,
  )
}

export async function markAbortCompleted(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  sessionId: string,
  runId: string,
  sessionMap: Map<string, SessionState>,
  dequeueNextQueuedRun?: (socket: Socket, sessionId: string, fallbackProfile?: string) => boolean | void,
  synced = true,
  ownership?: SessionRunOwnership,
): Promise<boolean> {
  const ownsRun = () => !ownership || ownsSessionRun(sessionMap, ownership)
  if (!ownsRun()) return false
  const state = ownership?.state || sessionMap.get(sessionId)
  if (!state) return false

  const profile = state.profile
  let finalizationError = state.abortFinalizationError
  const emit = (event: string, payload: any) => {
    if (!ownsRun()) return
    nsp.to(`session:${sessionId}`).emit(event, { ...payload, session_id: sessionId })
  }
  try {
    updateSessionStats(sessionId)
    await calcAndUpdateUsage(sessionId, state, emit)
  } catch (err) {
    const failure = finalizationFailure(err)
    finalizationError = finalizationError
      ? `${finalizationError}; ${failure.replace(/^Run finalization failed:\s*/, '')}`
      : failure
    logger.warn({ err, sessionId, runId }, '[chat-run-socket][abort] run finalization failed')
  }
  if (!ownsRun()) return false

  state.isWorking = false
  state.isAborting = false
  state.profile = undefined
  state.abortController = undefined
  state.runId = undefined
  state.responseRun = undefined
  state.activeRunMarker = undefined
  state.commandReservationMarker = undefined
  state.abortFinalizationError = undefined
  state.events = []

  const queueLength = state.queue.length
  const abortCompleted = {
    event: 'abort.completed',
    run_id: runId,
    synced,
    queue_length: queueLength,
    failure_pending: Boolean(finalizationError),
  }
  try {
    const resumeEventId = recordPendingResumeEvent(state, 'abort.completed', abortCompleted)
    emitToSession(nsp, socket, sessionId, 'abort.completed', {
      ...abortCompleted,
      resume_event_id: resumeEventId,
    })
  } catch (err) {
    logger.warn({ err, sessionId, runId }, '[chat-run-socket][abort] failed to emit abort completion')
  }
  if (finalizationError) {
    try {
      const failure = {
        event: 'run.failed',
        run_id: runId,
        error: finalizationError,
        queue_remaining: queueLength,
      }
      const resumeEventId = recordPendingResumeEvent(state, 'run.failed', failure)
      emitToSession(nsp, socket, sessionId, 'run.failed', {
        ...failure,
        resume_event_id: resumeEventId,
      })
    } catch (err) {
      logger.warn({ err, sessionId, runId }, '[chat-run-socket][abort] failed to emit finalization failure')
    }
  }
  if (queueLength > 0 && dequeueNextQueuedRun) {
    try {
      dequeueNextQueuedRun(socket, sessionId, profile || 'default')
    } catch (err) {
      logger.warn({ err, sessionId, runId }, '[chat-run-socket][abort] failed to dequeue next run')
    }
  }
  logger.info({ sessionId, runId, synced, finalizationError, queueLength }, '[chat-run-socket][abort] completed')
  return true
}

function finalizationFailure(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err)
  return `Run finalization failed: ${detail}`
}

function emitToSession(nsp: ReturnType<Server['of']>, socket: Socket, sessionId: string, event: string, payload: any) {
  const tagged = { ...payload, session_id: sessionId }
  nsp.to(`session:${sessionId}`).emit(event, tagged)
  if (!nsp.adapter.rooms.get(`session:${sessionId}`)?.size && socket.connected) {
    socket.emit(event, tagged)
  }
}
