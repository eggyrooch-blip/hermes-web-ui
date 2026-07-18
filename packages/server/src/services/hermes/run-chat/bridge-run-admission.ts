import { getSession } from '../../../db/hermes/session-store'
import { contentBlocksToString, extractTextForPreview } from './content-blocks'
import {
  createSessionAndBind,
  getOrCreateGenerationBoundSessionState,
} from './session-generation'
import {
  captureSessionRunOwnership,
  ownsSessionRun,
  type SessionRunOwnership,
} from './session-run-ownership'
import type { ContentBlock, SessionState } from './types'

export interface BridgeRunAdmission extends SessionRunOwnership {
  needsStateLoad: boolean
  createdSession: boolean
  abortController: AbortController
}

interface BridgeRunAdmissionData {
  input: string | ContentBlock[]
  display_input?: string | ContentBlock[] | null
  session_id?: string
  model?: string
  provider?: string
  workspace?: string | null
  source?: string
  session_source?: 'global_agent'
}

function resetBridgeRunState(state: SessionState, profile: string, source: 'cli' | 'global_agent', runMarker: string) {
  state.isWorking = true
  state.isAborting = false
  state.events = []
  state.profile = profile
  state.source = source
  state.activeRunMarker = runMarker
  state.runId = undefined
  state.abortController = new AbortController()
  state.bridgeOutput = ''
  state.bridgePendingAssistantContent = ''
  state.bridgePendingReasoningContent = ''
  state.bridgePendingToolCallMarkup = ''
  state.bridgeToolCounter = 0
  state.bridgePendingTools = []
  state.responseRun = undefined
}

/** Reserve the exact in-memory state and SQLite incarnation before Bridge setup can yield. */
export function reserveBridgeRunAdmission(
  sessionMap: Map<string, SessionState>,
  data: BridgeRunAdmissionData,
  profile: string,
): BridgeRunAdmission | null {
  const sessionId = data.session_id
  if (!sessionId) return null

  const session = getSession(sessionId)
  const previousState = sessionMap.get(sessionId)
  const state = getOrCreateGenerationBoundSessionState(sessionMap, sessionId)
  const needsStateLoad = Boolean(session && state !== previousState)

  const createdSession = !session
  if (createdSession) {
    const titleInput = data.display_input === null
      ? data.input
      : (data.display_input ?? data.input)
    const preview = extractTextForPreview(titleInput)
      .replace(/[\r\n]/g, ' ')
      .substring(0, 100)
    const source = data.session_source === 'global_agent' || data.source === 'global_agent'
      ? 'global_agent'
      : 'cli'
    createSessionAndBind(state, {
      id: sessionId,
      profile,
      source,
      model: data.model,
      provider: data.provider,
      title: preview || contentBlocksToString(data.input).substring(0, 100),
      workspace: data.workspace || undefined,
    })
  }

  const runMarker = `cli_run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const source = data.session_source === 'global_agent' || data.source === 'global_agent'
    ? 'global_agent'
    : 'cli'
  resetBridgeRunState(state, profile, source, runMarker)
  const abortController = state.abortController!
  return {
    ...captureSessionRunOwnership(sessionId, state, runMarker),
    needsStateLoad,
    createdSession,
    abortController,
  }
}

export function releaseBridgeRunAdmission(
  sessionMap: Map<string, SessionState>,
  admission: BridgeRunAdmission,
): boolean {
  if (!ownsSessionRun(sessionMap, admission)) return false
  const state = admission.state
  state.isWorking = false
  state.isAborting = false
  state.profile = undefined
  state.runId = undefined
  state.abortController = undefined
  state.activeRunMarker = undefined
  return true
}
