/**
 * CLI Bridge run handler — handles runs that use the agent bridge
 * to communicate with Hermes CLI agent.
 */

import type { Server, Socket } from 'socket.io'
import { getSystemPrompt } from '../../../lib/llm-prompt'
import { getSession, getSessionDetail, addMessage, updateSession, updateSessionStats } from '../../../db/hermes/session-store'
import { updateUsage } from '../../../db/hermes/usage-store'
import { logger, bridgeLogger } from '../../logger'
import { AgentBridgeClient, type AgentBridgeContextEstimate, type AgentBridgeMessage, type AgentBridgeOutput } from '../agent-bridge'
import { contentBlocksToString, convertContentBlocksForAgent, isContentBlockArray } from './content-blocks'
import { buildCompressedHistory, buildDbHistory, buildSnapshotAwareHistory, forceCompressBridgeHistory, pushState, replaceState } from './compression'
import {
  calcAndUpdateUsage,
  contextTokensWithCachedOverhead,
  estimateUsageTokensFromMessages,
  getCachedBridgeContextOverhead,
  updateMessageContextTokenUsage,
} from './usage'
import {
  flushBridgePendingToDb,
  ensureOpenBridgeAssistantMessage,
  syncBridgeReasoningToMessage,
  recordBridgeToolStarted,
  recordBridgeToolCompleted,
} from './bridge-message'
import { summarizeToolArguments } from './response-utils'
import type { ContentBlock, QueuedRun, SessionState } from './types'
import type { ChatMessage } from '../../../lib/context-compressor'
import { resolveBridgeRunModelConfig, type RunModelGroup } from './model-config'
import { filterBridgeToolCallMarkupDelta, flushPendingToolCallMarkup } from './bridge-delta'
import { markAbortCompleted } from './abort'
import { writeModelRunProfileToken } from './model-run-prompt'
import type { AuthenticatedUser } from '../../../middleware/user-auth'
import { ensureHermesRunWorkspace } from './workspace'
import { completeWorkspaceRunCheckpoint, discardWorkspaceRunCheckpoint, startWorkspaceRunCheckpoint, type WorkspaceRunCheckpointHandle, type WorkspaceRunDiffCompletion } from './workspace-diff-tracker'
import { captureSessionRunOwnership, ownsSessionGeneration, ownsSessionRun, type SessionRunOwnership } from './session-run-ownership'
import { finalizeBridgeAbort, registerBridgeAbortFinalizer, unregisterBridgeAbortFinalizer } from './bridge-abort-finalizer'
import {
  releaseBridgeRunAdmission,
  reserveBridgeRunAdmission,
  type BridgeRunAdmission,
} from './bridge-run-admission'
import { awaitWithAbortSignal, awaitWithTimeoutAndAbortSignal, isAbortError } from './abortable-await'

const BRIDGE_USAGE_FLUSH_DELAY_MS = 200
const BRIDGE_TITLE_EVENT_POLL_INTERVAL_MS = 500
const BRIDGE_TITLE_EVENT_POLL_TIMEOUT_MS = 45_000
const BRIDGE_GOAL_EVALUATE_TIMEOUT_MS = 120_000

function workspaceDiffCompletedPayload(change: WorkspaceRunDiffCompletion): Record<string, unknown> {
  return { event: 'workspace.diff.completed', ...change }
}

function explicitBridgeWorkspace(requested?: string | null): string {
  const requestedWorkspace = String(requested || '').trim()
  return requestedWorkspace
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeTitleText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function fallbackTitleFromText(text: string, limit: number, ellipsis: boolean): string {
  const normalized = normalizeTitleText(text)
  if (!normalized) return ''
  if (normalized.length <= limit) return normalized
  return ellipsis ? `${normalized.slice(0, limit)}...` : normalized.slice(0, limit)
}

function isReplaceableLocalTitle(sessionId: string): boolean {
  const detail = getSessionDetail(sessionId)
  if (!detail) return false
  const current = normalizeTitleText(detail.title)
  if (!current) return true
  const variants = new Set<string>([''])
  const preview = normalizeTitleText(detail.preview)
  if (preview) {
    variants.add(preview)
    variants.add(fallbackTitleFromText(preview, 40, true))
    variants.add(fallbackTitleFromText(preview, 63, false))
    variants.add(fallbackTitleFromText(preview, 100, false))
  }
  const firstUser = detail.messages.find(message => message.role === 'user' && normalizeTitleText(message.content))
  const firstUserText = normalizeTitleText(firstUser?.content)
  if (firstUserText) {
    variants.add(firstUserText)
    variants.add(fallbackTitleFromText(firstUserText, 40, true))
    variants.add(fallbackTitleFromText(firstUserText, 63, false))
    variants.add(fallbackTitleFromText(firstUserText, 100, false))
  }
  return variants.has(current)
}

function isBridgeSessionSource(source?: string | null): boolean {
  return source === 'cli' || source === 'global_agent'
}

function syncBridgeGeneratedTitle(sessionId: string, title: unknown, emit: (event: string, payload: any) => void): boolean {
  const nextTitle = normalizeTitleText(title)
  if (!nextTitle) return false
  const session = getSession(sessionId)
  if (!session || !isBridgeSessionSource(session.source)) return false
  if (!isReplaceableLocalTitle(sessionId)) {
    logger.info('[chat-run-socket] skipped Hermes generated title for manually titled session %s', sessionId)
    return false
  }
  if (normalizeTitleText(session.title) === nextTitle) return false
  updateSession(sessionId, {
    title: nextTitle,
    last_active: Math.floor(Date.now() / 1000),
  } as any)
  emit('session.title.updated', {
    event: 'session.title.updated',
    session_id: sessionId,
    title: nextTitle,
  })
  return true
}

function shouldPollBridgeGeneratedTitle(sessionId: string): boolean {
  const session = getSession(sessionId)
  if (!session || !isBridgeSessionSource(session.source)) return false
  const detail = getSessionDetail(sessionId)
  if (!detail) return false
  const userMessageCount = detail.messages.filter(message => message.role === 'user').length
  return userMessageCount <= 2 && isReplaceableLocalTitle(sessionId)
}

function looksLikeAgentFailure(value: string): boolean {
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return false

  return /\bAPI call failed after\b/i.test(text)
    || /\b(?:401|403)\b.{0,100}\b(?:unauthorized|forbidden|authentication|auth|invalid api key|permission denied)\b/i.test(text)
    || /\b(?:unauthorized|forbidden|authentication|auth|invalid api key|permission denied)\b.{0,100}\b(?:401|403)\b/i.test(text)
    || /\b429\b.{0,100}\b(?:rate limit|too many requests|quota)\b/i.test(text)
    || /\b(?:rate limit|too many requests|quota)\b.{0,100}\b429\b/i.test(text)
    || /\b(?:500|502|503|504)\b.{0,100}\b(?:server error|bad gateway|service unavailable|gateway timeout|upstream|provider|request failed|api)\b/i.test(text)
    || /\b(?:server error|bad gateway|service unavailable|gateway timeout|upstream|provider|request failed|api)\b.{0,100}\b(?:500|502|503|504)\b/i.test(text)
    || /(?:无可用渠道|渠道不可用|认证失败|鉴权失败|额度不足|余额不足|请求失败|接口调用失败|限流)/i.test(text)
}

export function bridgeTerminalError(chunk: Pick<AgentBridgeOutput, 'status' | 'error' | 'result'>): string | null {
  const result = chunk.result && typeof chunk.result === 'object' && !Array.isArray(chunk.result)
    ? chunk.result as Record<string, unknown>
    : null
  const resultError = result
    ? stringValue(result.error)
      || stringValue(result.exception)
    : ''
  const resultMessage = result ? stringValue(result.message) : ''
  const finalResponse = result ? stringValue(result.final_response) : ''

  if (chunk.status === 'error') {
    return stringValue(chunk.error) || resultError || resultMessage || finalResponse || 'Agent run failed'
  }

  if (result?.failed === true || result?.completed === false) {
    return resultError || resultMessage || finalResponse || 'Agent reported failure'
  }

  if (result?.completed === true) return null
  if (resultError) return resultError
  if (!finalResponse && resultMessage && looksLikeAgentFailure(resultMessage)) return resultMessage
  if (finalResponse && looksLikeAgentFailure(finalResponse)) return finalResponse

  return null
}

function findOpenAssistantMessage(state: SessionState, runMarker: string) {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i]
    if (message.runMarker === runMarker && message.role === 'assistant' && message.finish_reason == null) return message
  }
  return undefined
}

function flushPendingToolMarkupToAssistant(
  state: SessionState,
  runMarker: string,
  runId: string,
  emit: (event: string, payload: any) => void,
): string {
  const pendingMarkup = flushPendingToolCallMarkup(state)
  if (!pendingMarkup) return ''

  state.bridgeOutput = (state.bridgeOutput || '') + pendingMarkup
  state.bridgePendingAssistantContent = (state.bridgePendingAssistantContent || '') + pendingMarkup
  const last = findOpenAssistantMessage(state, runMarker)
  if (last) {
    last.content += pendingMarkup
    if (!last.run_id) last.run_id = runId
  }
  emit('message.delta', {
    event: 'message.delta',
    run_id: runId,
    delta: pendingMarkup,
    output: state.bridgeOutput,
  })
  return pendingMarkup
}

function processBridgeTextDelta(
  state: SessionState,
  sessionId: string,
  runMarker: string,
  runId: string,
  rawDelta: string,
  emit: (event: string, payload: any) => void,
): void {
  const delta = filterBridgeToolCallMarkupDelta(state, rawDelta)
  if (!delta) return
  state.bridgeOutput = (state.bridgeOutput || '') + delta
  state.bridgePendingAssistantContent = (state.bridgePendingAssistantContent || '') + delta
  const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
  if (last?.role === 'assistant' && last.finish_reason == null) {
    last.content += delta
    if (!last.run_id) last.run_id = runId
    syncBridgeReasoningToMessage(last, state.bridgePendingReasoningContent)
  } else {
    state.messages.push({
      id: state.messages.length + 1,
      session_id: sessionId,
      runMarker,
      run_id: runId,
      role: 'assistant',
      content: delta,
      reasoning: state.bridgePendingReasoningContent || null,
      reasoning_content: state.bridgePendingReasoningContent || null,
      timestamp: Math.floor(Date.now() / 1000),
    })
  }
  emit('message.delta', {
    event: 'message.delta',
    run_id: runId,
    delta,
    output: state.bridgeOutput,
  })
}

function finiteToken(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

function cacheBridgeContext(state: SessionState, data: Record<string, unknown> | AgentBridgeContextEstimate) {
  const fixedContextTokens = finiteToken(data.fixed_context_tokens)
  if (fixedContextTokens == null) return
  state.bridgeContext = {
    fixedContextTokens,
    systemPromptTokens: finiteToken(data.system_prompt_tokens),
    toolTokens: finiteToken(data.tool_tokens),
    systemPromptChars: finiteToken(data.system_prompt_chars),
    toolCount: finiteToken(data.tool_count),
    toolNames: Array.isArray(data.tool_names) ? data.tool_names.map(String) : undefined,
    profile: typeof data.profile === 'string' ? data.profile : state.bridgeContext?.profile,
    model: typeof data.model === 'string' ? data.model : state.bridgeContext?.model,
    provider: typeof data.provider === 'string' ? data.provider : state.bridgeContext?.provider,
  }
}

function bridgeContextMatches(
  state: SessionState,
  expected: { profile: string; model?: string | null; provider?: string | null },
): boolean {
  const context = state.bridgeContext
  if (!context) return false
  if (context.profile && context.profile !== expected.profile) return false
  if (expected.model && context.model && context.model !== expected.model) return false
  if (expected.provider && context.provider && context.provider !== expected.provider) return false
  return true
}

async function ensureBridgeFixedContext(args: {
  sessionId: string
  profile: string
  model?: string | null
  provider?: string | null
  instructions: string
  state: SessionState
  bridge: AgentBridgeClient
  refresh?: boolean
}): Promise<number | undefined> {
  const cached = bridgeContextMatches(args.state, args)
    ? getCachedBridgeContextOverhead(args.state)
    : undefined
  if (!args.refresh && cached != null) return cached

  try {
    const estimate = await args.bridge.contextEstimate(
      args.sessionId,
      [],
      args.instructions,
      args.profile,
      { model: args.model ?? undefined, provider: args.provider ?? undefined },
    )
    cacheBridgeContext(args.state, estimate)
    const fixedContextTokens = getCachedBridgeContextOverhead(args.state)
    bridgeLogger.info({
      sessionId: args.sessionId,
      profile: args.profile,
      model: args.model,
      provider: args.provider,
      toolCount: estimate.tool_count,
      systemPromptChars: estimate.system_prompt_chars,
      fixedContextTokens,
    }, '[chat-run-socket] fixed context estimate')
    return fixedContextTokens
  } catch (err) {
    bridgeLogger.warn({
      err: err instanceof Error ? { message: err.message, name: err.name } : err,
      sessionId: args.sessionId,
      profile: args.profile,
      model: args.model,
      provider: args.provider,
      cachedFixedContextTokens: cached,
    }, '[chat-run-socket] fixed context estimate failed')
    return cached
  }
}

export async function handleBridgeRun(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  data: { input: string | ContentBlock[]; display_input?: string | ContentBlock[] | null; display_role?: 'user' | 'command'; storage_message?: string; session_id?: string; model?: string; provider?: string; model_groups?: RunModelGroup[]; instructions?: string; workspace?: string | null; source?: string; session_source?: 'global_agent'; queue_id?: string; peerExcludeSocketId?: string; reasoning_effort?: string },
  profile: string,
  sessionMap: Map<string, SessionState>,
  bridge: AgentBridgeClient,
  skipUserMessage = false,
  loadSessionStateFromDbFn: (sid: string, sessionMap: Map<string, SessionState>) => Promise<SessionState>,
  dequeueNextQueuedRun: (socket: Socket, sessionId: string, fallbackProfile?: string) => void,
  admittedRun?: BridgeRunAdmission,
) {
  const { input, session_id, instructions } = data
  if (!session_id) {
    socket.emit('run.failed', { event: 'run.failed', error: 'session_id is required for cli source' })
    return
  }

  const runOwnership = admittedRun || reserveBridgeRunAdmission(sessionMap, data, profile)
  if (!runOwnership) return
  const state = runOwnership.state
  const runMarker = runOwnership.runMarker
  const ownsRun = () => ownsSessionRun(sessionMap, runOwnership)
  const ownsGeneration = () => ownsSessionGeneration(sessionMap, runOwnership)

  let fullInstructions = instructions
    ? `${getSystemPrompt()}\n${instructions}`
    : getSystemPrompt()
  let workspace = ''
  let diffWorkspace = ''
  let resolvedModel = ''
  let resolvedProvider = ''
  try {
    if (runOwnership.needsStateLoad) {
      const loadedState = await awaitWithAbortSignal(
        loadSessionStateFromDbFn(session_id, sessionMap),
        runOwnership.abortController.signal,
      )
      if (!ownsRun()) return
      state.messages = loadedState.messages
      state.messageTotal = loadedState.messageTotal
      state.messageLoadedCount = loadedState.messageLoadedCount
      state.messagePageLimit = loadedState.messagePageLimit
      state.hasMoreBefore = loadedState.hasMoreBefore
      state.inputTokens = loadedState.inputTokens
      state.outputTokens = loadedState.outputTokens
      state.contextTokens = loadedState.contextTokens
    }

    const sessionRow = getSession(session_id)
    workspace = await awaitWithAbortSignal(
      ensureHermesRunWorkspace(profile, sessionRow?.workspace || data.workspace),
      runOwnership.abortController.signal,
    )
    if (!ownsRun()) return
    diffWorkspace = explicitBridgeWorkspace(data.workspace) ? workspace : ''
    if (runOwnership.createdSession || (sessionRow && !sessionRow.workspace)) {
      updateSession(session_id, { workspace })
    }
    const sessionModel = sessionRow?.model || ''
    const sessionProvider = sessionRow?.provider || ''
    const resolved = await awaitWithAbortSignal(resolveBridgeRunModelConfig({
      profile,
      sessionModel,
      sessionProvider,
      requestedModel: data.model,
      requestedProvider: data.provider,
      modelGroups: data.model_groups,
    }), runOwnership.abortController.signal)
    if (!ownsRun()) return
    resolvedModel = resolved.model
    resolvedProvider = resolved.provider
    if (sessionRow || runOwnership.createdSession) {
      const updates: { model?: string; provider?: string } = {}
      if (resolvedModel && sessionRow?.model !== resolvedModel) updates.model = resolvedModel
      if (resolvedProvider && sessionRow?.provider !== resolvedProvider) updates.provider = resolvedProvider
      if (Object.keys(updates).length > 0) updateSession(session_id, updates)
    }
    const socketUser = socket.data.user as AuthenticatedUser | undefined
    await awaitWithAbortSignal(
      writeModelRunProfileToken(socketUser, profile),
      runOwnership.abortController.signal,
    )
    if (!ownsRun()) return
  } catch (err) {
    if (runOwnership.abortController.signal.aborted && isAbortError(err)) {
      if (ownsRun()) await finalizeBridgeAbort(state, true)
      return
    }
    if (!ownsRun()) return
    releaseBridgeRunAdmission(sessionMap, runOwnership)
    throw err
  }

  const runPrompt = [
    workspace ? `[Current working directory: ${workspace}]` : '',
    'When calling Hermes Web UI endpoints from tools or skills, include the current Hermes profile as the X-Hermes-Profile header if the endpoint supports profile-scoped behavior.',
  ].filter(Boolean).join('\n')
  fullInstructions = `\n${runPrompt}\n${fullInstructions}`

  const now = Math.floor(Date.now() / 1000)
  const displayInput = data.display_input === undefined ? input : data.display_input
  const inputStr = displayInput == null ? '' : contentBlocksToString(displayInput)
  const actualInputStr = contentBlocksToString(input)
  const storageInputStr = data.storage_message !== undefined ? data.storage_message : inputStr
  const shouldStoreInputInsteadOfDisplay = data.storage_message !== undefined && data.storage_message !== inputStr
  const currentInputUsage = estimateUsageTokensFromMessages([{ role: 'user', content: actualInputStr }])
  const currentInputTokens = currentInputUsage.inputTokens
  const shouldPersistUserMessage = !skipUserMessage && displayInput !== null
  const displayRole = data.display_role === 'command' ? 'command' : 'user'
  const storageRole = shouldStoreInputInsteadOfDisplay ? 'user' : displayRole
  const displayRoleForStorage = shouldStoreInputInsteadOfDisplay ? displayRole : null
  const displayContentForStorage = shouldStoreInputInsteadOfDisplay ? inputStr : null
  let messageId: number | string | undefined

  if (shouldPersistUserMessage) {
    state.messages.push({
      id: data.queue_id || state.messages.length + 1,
      session_id,
      runMarker,
      role: storageRole,
      content: storageInputStr,
      display_role: displayRoleForStorage,
      display_content: displayContentForStorage,
      timestamp: now,
    })

    messageId = addMessage({
      session_id,
      client_id: data.queue_id || null,
      role: storageRole,
      content: storageInputStr,
      display_role: displayRoleForStorage,
      display_content: displayContentForStorage,
      timestamp: now,
    })
  }

  socket.join(`session:${session_id}`)
  if (shouldPersistUserMessage && ownsRun()) {
    const peerTarget = data.peerExcludeSocketId
      ? nsp.to(`session:${session_id}`).except(data.peerExcludeSocketId)
      : socket.to(`session:${session_id}`)
    peerTarget.emit('run.peer_user_message', {
      event: 'run.peer_user_message',
      session_id,
      message: {
        id: data.queue_id || messageId,
        role: displayRoleForStorage || storageRole,
        content: displayContentForStorage || storageInputStr,
        timestamp: now,
      },
    })
  }
  const emitToRoom = (event: string, payload: any) => {
    const tagged = { ...payload, session_id }
    nsp.to(`session:${session_id}`).emit(event, tagged)
    if (!nsp.adapter.rooms.get(`session:${session_id}`)?.size && socket.connected) {
      socket.emit(event, tagged)
    }
  }
  const emit = (event: string, payload: any) => {
    if (ownsRun()) emitToRoom(event, payload)
  }
  const emitForGeneration = (event: string, payload: any) => {
    if (ownsGeneration()) emitToRoom(event, payload)
  }
  let workspaceDiffRunId = ''
  let workspaceDiffCheckpoint: WorkspaceRunCheckpointHandle | null = null
  let workspaceDiffCompletion: Promise<void> | null = null
  const emitWorkspaceDiffCompleted = (): Promise<void> => {
    if (!diffWorkspace || (!workspaceDiffRunId && !workspaceDiffCheckpoint)) return Promise.resolve()
    if (workspaceDiffCompletion) return workspaceDiffCompletion
    workspaceDiffCompletion = (async () => {
      try {
        if (!workspaceDiffRunId) {
          await completeWorkspaceRunCheckpoint({
            sessionId: session_id,
            workspace: diffWorkspace,
            checkpoint: workspaceDiffCheckpoint,
          })
          return
        }
        const change = await completeWorkspaceRunCheckpoint({
          sessionId: session_id,
          runId: workspaceDiffRunId,
          workspace: diffWorkspace,
          ...(workspaceDiffCheckpoint ? { checkpoint: workspaceDiffCheckpoint } : {}),
        })
        if (change && ownsRun()) emit('workspace.diff.completed', workspaceDiffCompletedPayload(change))
      } catch (err) {
        bridgeLogger.warn({ err, sessionId: session_id, workspace: diffWorkspace }, '[workspace-diff] failed to complete bridge checkpoint')
      }
    })()
    return workspaceDiffCompletion
  }

  let abortFinalization: Promise<boolean> | null = null
  const bridgeAbortFinalizer = (synced: boolean): Promise<boolean> => {
    if (abortFinalization) return abortFinalization
    const pending = (async () => {
      if (!ownsRun()) return false
      await emitWorkspaceDiffCompleted()
      if (!ownsRun()) return false
      const finalized = await markAbortCompleted(
        nsp,
        socket,
        session_id,
        state.runId || runMarker,
        sessionMap,
        dequeueNextQueuedRun,
        synced,
        runOwnership,
      )
      if (!finalized) return false
      unregisterBridgeAbortFinalizer(state, bridgeAbortFinalizer)
      return true
    })()
    abortFinalization = pending
    void pending.catch(() => {
      if (abortFinalization === pending) abortFinalization = null
    })
    return pending
  }
  registerBridgeAbortFinalizer(state, bridgeAbortFinalizer)

  let history: ChatMessage[]
  try {
    history = await awaitWithAbortSignal(buildCompressedHistory(
      session_id, profile,
      '',
      undefined,
      emit,
      sessionMap,
      { model: resolvedModel, provider: resolvedProvider },
      async (_messages, localMessageTokens) => {
        const fixedContextTokens = await ensureBridgeFixedContext({
          sessionId: session_id,
          profile,
          model: resolvedModel,
          provider: resolvedProvider,
          instructions: fullInstructions,
          state,
          bridge,
          refresh: true,
        })
        if (!ownsRun()) return localMessageTokens
        const contextTokens = fixedContextTokens == null
          ? localMessageTokens
          : fixedContextTokens + localMessageTokens
        bridgeLogger.info({
          sessionId: session_id,
          profile,
          model: resolvedModel,
          provider: resolvedProvider,
          fixedContextTokens,
          messageTokens: localMessageTokens,
          contextTokens,
        }, '[chat-run-socket] local context estimate')
        return contextTokens
      },
      currentInputTokens,
    ), runOwnership.abortController.signal)
  } catch (err) {
    if (runOwnership.abortController.signal.aborted && isAbortError(err)) {
      if (ownsRun()) await finalizeBridgeAbort(state, true)
      return
    }
    unregisterBridgeAbortFinalizer(state, bridgeAbortFinalizer)
    throw err
  }
  const bridgeHistory = history
  if (!ownsRun()) {
    unregisterBridgeAbortFinalizer(state, bridgeAbortFinalizer)
    return
  }
  if (state.isAborting) {
    await finalizeBridgeAbort(state, true)
    return
  }

  try {
    const bridgeInput = isContentBlockArray(input)
      ? await awaitWithAbortSignal(
          convertContentBlocksForAgent(input),
          runOwnership.abortController.signal,
        )
      : input
    if (!ownsRun()) {
      unregisterBridgeAbortFinalizer(state, bridgeAbortFinalizer)
      return
    }
    if (state.isAborting) {
      await finalizeBridgeAbort(state, true)
      return
    }
    const bridgeStorageInput = data.storage_message !== undefined
      ? data.storage_message
      : isContentBlockArray(input)
        ? inputStr
        : undefined
    logger.info('[chat-run-socket] starting CLI bridge run for session %s', session_id)
    bridgeLogger.info({
      sessionId: session_id,
      profile,
      inputChars: inputStr.length,
      historyMessages: history.length,
      hasInstructions: Boolean(fullInstructions),
      multimodalInput: isContentBlockArray(input),
    }, '[chat-run-socket] starting CLI bridge run')
    workspaceDiffCheckpoint = diffWorkspace
      ? await startWorkspaceRunCheckpoint({
          sessionId: session_id,
          workspace: diffWorkspace,
        })
      : null
    if (!ownsRun()) {
      discardWorkspaceRunCheckpoint({ sessionId: session_id, checkpoint: workspaceDiffCheckpoint })
      if (!ownsGeneration() && sessionMap.get(session_id) === state) {
        state.abortController?.abort()
        state.goalEvaluationAbortController?.abort()
        state.queue.length = 0
        state.isWorking = false
        state.activeRunMarker = undefined
        sessionMap.delete(session_id)
      }
      unregisterBridgeAbortFinalizer(state, bridgeAbortFinalizer)
      return
    }
    if (state.isAborting) {
      await finalizeBridgeAbort(state, true)
      return
    }
    const started = await awaitWithAbortSignal(bridge.chat(
      session_id,
      bridgeInput as AgentBridgeMessage,
      bridgeHistory,
      fullInstructions,
      profile,
      {
        ...(bridgeStorageInput !== undefined ? { storage_message: bridgeStorageInput } : {}),
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(resolvedProvider ? { provider: resolvedProvider } : {}),
        // Local patch (reasoning-effort): per-session reasoning effort override.
        ...(data.reasoning_effort ? { reasoning_effort: data.reasoning_effort } : {}),
      },
    ), runOwnership.abortController.signal)
    if (!ownsRun()) {
      discardWorkspaceRunCheckpoint({ sessionId: session_id, checkpoint: workspaceDiffCheckpoint })
      unregisterBridgeAbortFinalizer(state, bridgeAbortFinalizer)
      return
    }
    state.runId = started.run_id
    workspaceDiffRunId = started.run_id
    if (state.isAborting) {
      await bridge.interrupt(session_id, 'Aborted by user', profile).catch((err) => {
        bridgeLogger.warn({ err, sessionId: session_id, runId: started.run_id }, '[chat-run-socket][abort] failed to repeat interrupt after bridge startup')
      })
      if (!ownsRun()) return
    }
    bridgeLogger.info({
      sessionId: session_id,
      runId: started.run_id,
      status: started.status,
    }, '[chat-run-socket] CLI bridge run started')
    pushState(sessionMap, session_id, 'run.started', {
      event: 'run.started',
      run_id: started.run_id,
      queue_length: state.queue.length || 0,
    })
    emit('run.started', {
      event: 'run.started',
      run_id: started.run_id,
      queue_length: state.queue.length || 0,
    })

    let lastChunk: AgentBridgeOutput | null = null
    let sawTerminalChunk = false
    for await (const chunk of bridge.streamOutput(started.run_id)) {
      lastChunk = chunk
      await applyBridgeChunkAsync(
        nsp,
        socket,
        state,
        session_id,
        runMarker,
        chunk,
        emit,
        profile,
        sessionMap,
        bridge,
        dequeueNextQueuedRun,
        fullInstructions,
        { model: resolvedModel, provider: resolvedProvider },
        currentInputTokens,
        shouldPersistUserMessage && displayRole === 'user',
        data.model_groups,
        emitWorkspaceDiffCompleted,
        runOwnership,
      )
      if (chunk.done) {
        sawTerminalChunk = true
        void pollBridgeGeneratedTitleAfterRun(bridge, session_id, profile, emitForGeneration, ownsGeneration)
        break
      }
    }
    if (!sawTerminalChunk && ownsRun() && state.isWorking) {
      bridgeLogger.warn({
        sessionId: session_id,
        runId: started.run_id,
      }, '[chat-run-socket] bridge stream ended without terminal chunk; completing local run state')
      const terminalChunk: AgentBridgeOutput = {
        ok: true,
        run_id: lastChunk?.run_id || started.run_id,
        session_id,
        status: 'complete',
        delta: '',
        cursor: typeof lastChunk?.cursor === 'number' ? lastChunk.cursor : 0,
        output: lastChunk?.output || state.bridgeOutput || '',
        done: true,
        result: lastChunk?.result,
        error: lastChunk?.error ?? null,
        events: [],
        event_cursor: typeof lastChunk?.event_cursor === 'number' ? lastChunk.event_cursor : 0,
      }
      await applyBridgeChunkAsync(
        nsp,
        socket,
        state,
        session_id,
        runMarker,
        terminalChunk,
        emit,
        profile,
        sessionMap,
        bridge,
        dequeueNextQueuedRun,
        fullInstructions,
        { model: resolvedModel, provider: resolvedProvider },
        currentInputTokens,
        shouldPersistUserMessage && displayRole === 'user',
        data.model_groups,
        emitWorkspaceDiffCompleted,
        runOwnership,
      )
    }
  } catch (err: any) {
    if (!ownsRun()) {
      await emitWorkspaceDiffCompleted()
      unregisterBridgeAbortFinalizer(state, bridgeAbortFinalizer)
      return
    }
    if (!state.isWorking) {
      await emitWorkspaceDiffCompleted()
      unregisterBridgeAbortFinalizer(state, bridgeAbortFinalizer)
      return
    }
    await emitWorkspaceDiffCompleted()
    if (!ownsRun() || !state.isWorking) return
    if (state.isAborting) {
      await finalizeBridgeAbort(state, true)
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    let errUsage = { inputTokens: 0, outputTokens: 0 }
    let errContextTokens: number | undefined
    let finalizationError: unknown
    try {
      state.bridgePendingToolCallMarkup = undefined
      flushBridgePendingToDb(state, session_id)
      updateSessionStats(session_id)
      errUsage = await calcAndUpdateUsage(session_id, state, emit)
      errContextTokens = await refreshFinalContextUsage({
        sessionId: session_id,
        profile,
        model: resolvedModel,
        provider: resolvedProvider,
        instructions: fullInstructions,
        state,
        usage: errUsage,
        emit,
        bridge,
      })
      if (!ownsRun() || !state.isWorking) return
      updateUsage(session_id, {
        inputTokens: errUsage.inputTokens,
        outputTokens: errUsage.outputTokens,
        profile,
      })
    } catch (finalizeErr) {
      finalizationError = finalizeErr
    }
    if (!ownsRun() || !state.isWorking) return
    const queueLen = state.queue?.length ?? 0
    emit('run.failed', {
      event: 'run.failed',
      error: finalizationError
        ? `${message}; finalization failed: ${finalizationError instanceof Error ? finalizationError.message : String(finalizationError)}`
        : message,
      inputTokens: errUsage.inputTokens,
      outputTokens: errUsage.outputTokens,
      contextTokens: errContextTokens,
      queue_remaining: queueLen,
    })
    state.isWorking = false
    state.isAborting = false
    state.abortController = undefined
    state.profile = undefined
    state.runId = undefined
    state.activeRunMarker = undefined
    state.events = []
    unregisterBridgeAbortFinalizer(state, bridgeAbortFinalizer)
    if (queueLen > 0) dequeueNextQueuedRun(socket, session_id)
  }
}

function latestAssistantText(state: SessionState): string {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i]
    if (message.role === 'assistant') return message.content || ''
  }
  return ''
}

export async function resumeBridgeRun(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  args: {
    sessionId: string
    runId: string
    profile: string
    instructions: string
    model?: string | null
    provider?: string | null
    source?: string | null
  },
  sessionMap: Map<string, SessionState>,
  bridge: AgentBridgeClient,
  dequeueNextQueuedRun: (socket: Socket, sessionId: string, fallbackProfile?: string) => void,
) {
  const { sessionId, runId, profile, instructions } = args
  let state = sessionMap.get(sessionId)
  if (!state) {
    state = { messages: [], isWorking: false, events: [], queue: [] }
    sessionMap.set(sessionId, state)
  }

  const runMarker = state.activeRunMarker || `cli_resume_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  state.isWorking = true
  state.isAborting = state.isAborting === true
  state.profile = profile
  state.source = args.source === 'global_agent' ? 'global_agent' : 'cli'
  state.runId = runId
  state.activeRunMarker = runMarker
  state.bridgeOutput = state.bridgeOutput || latestAssistantText(state)
  state.bridgePendingAssistantContent = state.bridgePendingAssistantContent || ''
  state.bridgePendingReasoningContent = state.bridgePendingReasoningContent || ''
  state.bridgePendingToolCallMarkup = state.bridgePendingToolCallMarkup || ''
  state.bridgePendingTools = state.bridgePendingTools || []
  state.bridgeToolCounter = state.bridgeToolCounter || 0
  const runOwnership = captureSessionRunOwnership(sessionId, state, runMarker)
  const ownsRun = () => ownsSessionRun(sessionMap, runOwnership)

  const emit = (event: string, payload: any) => {
    if (!ownsRun()) return
    const tagged = { ...payload, session_id: sessionId }
    nsp.to(`session:${sessionId}`).emit(event, tagged)
    if (!nsp.adapter.rooms.get(`session:${sessionId}`)?.size && socket.connected) {
      socket.emit(event, tagged)
    }
  }

  let abortFinalization: Promise<boolean> | null = null
  const resumeAbortFinalizer = (synced: boolean): Promise<boolean> => {
    if (abortFinalization) return abortFinalization
    const pending = (async () => {
      if (!ownsRun()) return false
      const finalized = await markAbortCompleted(
        nsp,
        socket,
        sessionId,
        runId,
        sessionMap,
        dequeueNextQueuedRun,
        synced,
        runOwnership,
      )
      if (!finalized) return false
      unregisterBridgeAbortFinalizer(state, resumeAbortFinalizer)
      return true
    })()
    abortFinalization = pending
    void pending.catch(() => {
      if (abortFinalization === pending) abortFinalization = null
    })
    return pending
  }
  registerBridgeAbortFinalizer(state, resumeAbortFinalizer)

  let cursor = 0
  let eventCursor = 0
  try {
    const snapshot = await bridge.getResult(runId)
    if (!ownsRun()) return
    const deltas = Array.isArray(snapshot.deltas) ? snapshot.deltas.map(String) : []
    const output = typeof snapshot.output === 'string' ? snapshot.output : deltas.join('')
    const persisted = state.bridgeOutput || ''
    const missingOutput = output && output.startsWith(persisted) ? output.slice(persisted.length) : ''
    if (missingOutput) {
      await applyBridgeChunkAsync(
        nsp,
        socket,
        state,
        sessionId,
        runMarker,
        {
          ok: true,
          run_id: runId,
          session_id: sessionId,
          status: 'running',
          delta: missingOutput,
          cursor: deltas.length,
          output,
          done: false,
          events: [],
          event_cursor: Array.isArray(snapshot.events) ? snapshot.events.length : 0,
          error: null,
        },
        emit,
        profile,
        sessionMap,
        bridge,
        dequeueNextQueuedRun,
        instructions,
        { model: args.model, provider: args.provider },
        0,
        true,
        undefined,
        undefined,
        runOwnership,
      )
    }
    cursor = deltas.length
    eventCursor = Array.isArray(snapshot.events) ? snapshot.events.length : 0
  } catch (err) {
    bridgeLogger.warn({
      err: err instanceof Error ? { message: err.message, name: err.name } : err,
      sessionId,
      runId,
    }, '[chat-run-socket] failed to snapshot running bridge run before resume')
  }

  try {
    for (;;) {
      const chunk = await bridge.getOutput(runId, cursor, eventCursor)
      if (!ownsRun()) return
      cursor = chunk.cursor
      eventCursor = chunk.event_cursor
      if (chunk.delta || chunk.done || (chunk.events && chunk.events.length > 0)) {
        await applyBridgeChunkAsync(
          nsp,
          socket,
          state,
          sessionId,
          runMarker,
          chunk,
          emit,
          profile,
          sessionMap,
          bridge,
          dequeueNextQueuedRun,
          instructions,
          { model: args.model, provider: args.provider },
          0,
          true,
          undefined,
          undefined,
          runOwnership,
        )
      }
      if (chunk.done) return
      await delay(100)
      if (!ownsRun()) return
    }
  } catch (err) {
    if (!ownsRun()) return
    if (state.isAborting) {
      await finalizeBridgeAbort(state, true)
      return
    }
    emit('run.failed', {
      event: 'run.failed',
      run_id: runId,
      error: err instanceof Error ? err.message : String(err),
      resumed: true,
      queue_remaining: state.queue.length,
    })
    if (!ownsRun()) return
    const queueLength = state.queue.length
    state.isWorking = false
    state.isAborting = false
    state.abortController = undefined
    state.profile = undefined
    state.runId = undefined
    state.activeRunMarker = undefined
    state.commandReservationMarker = undefined
    state.responseRun = undefined
    state.events = []
    unregisterBridgeAbortFinalizer(state, resumeAbortFinalizer)
    if (queueLength > 0) dequeueNextQueuedRun(socket, sessionId, profile)
  }
}

async function refreshFinalContextUsage(args: {
  sessionId: string
  profile: string
  model?: string | null
  provider?: string | null
  instructions: string
  state: SessionState
  usage: { inputTokens: number; outputTokens: number }
  emit: (event: string, payload: any) => void
  bridge: AgentBridgeClient
}): Promise<number | undefined> {
  try {
    const dbHistory = await buildDbHistory(args.sessionId, { excludeLastUser: false })
    const finalHistory = await buildSnapshotAwareHistory(
      args.sessionId,
      args.profile,
      dbHistory,
      { model: args.model, provider: args.provider },
    )
    const finalMessageUsage = estimateUsageTokensFromMessages(finalHistory)
    const finalMessageTokens = finalMessageUsage.inputTokens + finalMessageUsage.outputTokens
    await ensureBridgeFixedContext({
      sessionId: args.sessionId,
      profile: args.profile,
      model: args.model,
      provider: args.provider,
      instructions: args.instructions,
      state: args.state,
      bridge: args.bridge,
    })
    const contextTokens = updateMessageContextTokenUsage(
      args.sessionId,
      args.state,
      args.emit,
      finalMessageTokens,
      args.usage,
    )
    bridgeLogger.info({
      sessionId: args.sessionId,
      profile: args.profile,
      model: args.model,
      provider: args.provider,
      messages: finalHistory.length,
      fixedContextTokens: args.state.bridgeContext?.fixedContextTokens,
      messageTokens: finalMessageTokens,
      contextTokens,
    }, '[chat-run-socket] final local context estimate')
    return contextTokens
  } catch (err) {
    bridgeLogger.warn({
      err: err instanceof Error ? { message: err.message, name: err.name } : err,
      sessionId: args.sessionId,
      profile: args.profile,
    }, '[chat-run-socket] final local context estimate failed')
    return args.state.contextTokens
  }
}

async function estimateSnapshotAwareMessageTokens(args: {
  sessionId: string
  profile: string
  model?: string | null
  provider?: string | null
  currentInputTokens?: number
  currentInputIncludedInDb?: boolean
}): Promise<{ messageTokens: number; messages: number }> {
  const dbHistory = await buildDbHistory(args.sessionId, { excludeLastUser: false })
  const snapshotHistory = await buildSnapshotAwareHistory(
    args.sessionId,
    args.profile,
    dbHistory,
    { model: args.model, provider: args.provider },
  )
  const usage = estimateUsageTokensFromMessages(snapshotHistory)
  const extraInputTokens = args.currentInputIncludedInDb
    ? 0
    : finiteToken(args.currentInputTokens) ?? 0
  return {
    messageTokens: usage.inputTokens + usage.outputTokens + extraInputTokens,
    messages: snapshotHistory.length,
  }
}

async function applyBridgeChunkAsync(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  state: SessionState,
  sessionId: string,
  runMarker: string,
  chunk: AgentBridgeOutput,
  emit: (event: string, payload: any) => void,
  profile: string,
  sessionMap: Map<string, SessionState>,
  bridge: AgentBridgeClient,
  dequeueNextQueuedRun: (socket: Socket, sessionId: string, fallbackProfile?: string) => void,
  instructions: string,
  modelContext: { model?: string | null; provider?: string | null },
  currentInputTokens = 0,
  currentInputIncludedInDb = true,
  modelGroups?: RunModelGroup[],
  emitWorkspaceDiffCompleted?: () => Promise<void>,
  runOwnership?: SessionRunOwnership,
): Promise<void> {
  const ownsRun = () => runOwnership
    ? ownsSessionRun(sessionMap, runOwnership)
    : sessionMap.get(sessionId) === state && state.activeRunMarker === runMarker
  if (!ownsRun()) {
    bridgeLogger.info({
      sessionId,
      runId: chunk.run_id,
      runMarker,
      activeRunMarker: state.activeRunMarker,
    }, '[chat-run-socket] ignoring stale CLI bridge chunk')
    return
  }

  state.runId = chunk.run_id

  // When the bridge emits text as ordered `stream.delta` events (interleaved
  // with tool.started/tool.completed in the SAME events list), we process the
  // text here in true order and must NOT also process the aggregated
  // `chunk.delta` below (that would duplicate the text). This flag tracks it.
  let sawStreamDeltaEvent = false

  for (const ev of chunk.events || []) {
    if (!ownsRun()) return
    const evType = ev.event as string | undefined
    if (evType === 'stream.delta') {
      sawStreamDeltaEvent = true
      processBridgeTextDelta(state, sessionId, runMarker, chunk.run_id, String((ev as any).delta || ''), emit)
      continue
    }
    if (evType === 'session.title.updated') {
      syncBridgeGeneratedTitle(sessionId, (ev as any).title, emit)
    } else if (evType === 'bridge.context.ready') {
      cacheBridgeContext(state, ev)
      const usage = await calcAndUpdateUsage(sessionId, state, emit)
      if (!ownsRun()) return
      const snapshotAware = await estimateSnapshotAwareMessageTokens({
        sessionId,
        profile,
        model: modelContext.model,
        provider: modelContext.provider,
        currentInputTokens,
        currentInputIncludedInDb,
      })
      if (!ownsRun()) return
      updateMessageContextTokenUsage(
        sessionId,
        state,
        emit,
        snapshotAware.messageTokens,
        usage,
      )
    } else if (evType === 'tool.started') {
      // Flush any partial tool-call-marker prefix that was held back by
      // the markup filter. Without this, deltas ending in `[`, `[C`,
      // `[Ca`, etc. are silently dropped because no follow-up delta will
      // come for this assistant message — the next chunk is the tool call
      // itself. See bridge-delta.ts for full rationale.
      flushPendingToolMarkupToAssistant(state, runMarker, chunk.run_id, emit)
      flushBridgePendingToDb(state, sessionId, runMarker)
      const toolName = (ev.tool_name as string) || ''
      const args = ev.args as Record<string, unknown> | undefined
      const tool = recordBridgeToolStarted(state, sessionId, runMarker, toolName, args, ev.tool_call_id)
      const payload = {
        event: 'tool.started',
        run_id: chunk.run_id,
        tool_call_id: tool.id,
        tool: toolName,
        name: toolName,
        arguments: tool.arguments,
        preview: ev.preview || summarizeToolArguments(tool.arguments),
      }
      pushState(sessionMap, sessionId, 'tool.started', payload)
      emit('tool.started', payload)
    } else if (evType === 'tool.completed') {
      const toolName = (ev.tool_name as string) || ''
      const completed = recordBridgeToolCompleted(state, sessionId, runMarker, toolName, ev)
      const payload = {
        event: 'tool.completed',
        run_id: chunk.run_id,
        tool_call_id: completed.id,
        tool: toolName,
        name: toolName,
        output: completed.output,
        duration: completed.duration ?? ev.duration,
        error: ev.is_error || undefined,
      }
      pushState(sessionMap, sessionId, 'tool.completed', payload)
      emit('tool.completed', payload)
    } else if (evType?.startsWith('subagent.')) {
      const payload = {
        event: evType,
        run_id: chunk.run_id,
        subagent_id: ev.subagent_id,
        parent_id: ev.parent_id,
        depth: ev.depth,
        task_index: ev.task_index,
        task_count: ev.task_count,
        goal: ev.goal,
        model: ev.model,
        toolsets: ev.toolsets,
        tool_count: ev.tool_count,
        tool: ev.tool_name,
        name: ev.tool_name,
        preview: ev.text || ev.summary || ev.tool_preview || '',
        text: ev.text || '',
        status: ev.status,
        summary: ev.summary,
        duration: ev.duration_seconds,
        duration_seconds: ev.duration_seconds,
        input_tokens: ev.input_tokens,
        output_tokens: ev.output_tokens,
        reasoning_tokens: ev.reasoning_tokens,
        api_calls: ev.api_calls,
        cost_usd: ev.cost_usd,
        files_read: ev.files_read,
        files_written: ev.files_written,
        output_tail: ev.output_tail,
      }
      pushState(sessionMap, sessionId, evType, payload)
      emit(evType, payload)
    } else if (evType === 'turn.boundary') {
      flushBridgePendingToDb(state, sessionId, runMarker)
    } else if (evType === 'reasoning.delta' || evType === 'thinking.delta') {
      const text = String(ev.text || '')
      if (text) {
        state.bridgePendingReasoningContent = (state.bridgePendingReasoningContent || '') + text
        const message = ensureOpenBridgeAssistantMessage(state, sessionId, runMarker)
        message.reasoning = (message.reasoning || '') + text
        message.reasoning_content = (message.reasoning_content || '') + text
      }
      emit(evType, {
        event: evType,
        run_id: chunk.run_id,
        text,
      })
    } else if (evType === 'reasoning.available') {
      emit('reasoning.available', {
        event: 'reasoning.available',
        run_id: chunk.run_id,
      })
    } else if (evType === 'approval.requested') {
      const payload = {
        event: 'approval.requested',
        run_id: chunk.run_id,
        approval_id: ev.approval_id,
        command: ev.command,
        description: ev.description,
        choices: ev.choices,
        allow_permanent: ev.allow_permanent,
        timeout_ms: ev.timeout_ms,
      }
      replaceState(sessionMap, sessionId, 'approval.requested', payload)
      emit('approval.requested', payload)
    } else if (evType === 'approval.resolved') {
      const payload = {
        event: 'approval.resolved',
        run_id: chunk.run_id,
        approval_id: ev.approval_id,
        choice: ev.choice,
      }
      replaceState(sessionMap, sessionId, 'approval.resolved', payload)
      emit('approval.resolved', payload)
    } else if (evType === 'clarify.requested') {
      const payload = {
        event: 'clarify.requested',
        run_id: chunk.run_id,
        clarify_id: ev.clarify_id,
        question: ev.question,
        choices: Array.isArray(ev.choices) ? ev.choices : null,
        timeout_ms: ev.timeout_ms,
      }
      replaceState(sessionMap, sessionId, 'clarify.requested', payload)
      emit('clarify.requested', payload)
    } else if (evType === 'clarify.resolved') {
      const payload = {
        event: 'clarify.resolved',
        run_id: chunk.run_id,
        clarify_id: ev.clarify_id,
      }
      replaceState(sessionMap, sessionId, 'clarify.resolved', payload)
      emit('clarify.resolved', payload)
    } else if (evType === 'bridge.compression.requested') {
      const bridgeHistory = await buildDbHistory(sessionId, { excludeLastUser: true })
      if (!ownsRun()) return
      const bridgeUsage = estimateUsageTokensFromMessages(bridgeHistory)
      const messageOnlyTokens = bridgeUsage.inputTokens + bridgeUsage.outputTokens
      const runInputTokens = typeof currentInputTokens === 'number' && Number.isFinite(currentInputTokens) && currentInputTokens > 0
        ? Math.floor(currentInputTokens)
        : 0
      const runMessageTokens = messageOnlyTokens + runInputTokens
      const tokenCount = contextTokensWithCachedOverhead(state, runMessageTokens)
      bridgeLogger.info({
        sessionId,
        profile,
        bridgeMessages: ev.message_count,
        dbMessages: bridgeHistory.length,
        messageOnlyTokens,
        currentInputTokens: runInputTokens,
        fixedContextTokens: state.bridgeContext?.fixedContextTokens,
        contextTokens: tokenCount,
        bridgeApproxTokens: ev.approx_tokens,
        source: 'local',
      }, '[chat-run-socket] bridge compression token estimate')
      const payload = {
        event: 'compression.started',
        run_id: chunk.run_id,
        request_id: ev.request_id,
        message_count: bridgeHistory.length || ev.message_count,
        token_count: tokenCount,
        source: 'bridge',
      }
      replaceState(sessionMap, sessionId, 'compression.started', payload)
      emit('compression.started', payload)
      if (ev.request_id && Array.isArray(ev.messages)) {
        try {
          const compressed = await forceCompressBridgeHistory(
            sessionId,
            profile,
            ev.messages as ChatMessage[],
            tokenCount,
          )
          if (!ownsRun()) return
          state.bridgeCompressionResults = state.bridgeCompressionResults || {}
          state.bridgeCompressionResults[String(ev.request_id)] = compressed
          await bridge.compressionRespond(String(ev.request_id), { messages: compressed.messages })
          if (!ownsRun()) return
        } catch (err: any) {
          await bridge.compressionRespond(String(ev.request_id), {
            error: err?.message || String(err),
          }).catch(() => undefined)
          if (!ownsRun()) return
        }
      }
    } else if (evType === 'bridge.compression.completed') {
      const compressionResult = ev.request_id
        ? state.bridgeCompressionResults?.[String(ev.request_id)]
        : undefined
      const messageAfterTokens = finiteToken(compressionResult?.afterTokens)
      const runInputTokens = typeof currentInputTokens === 'number' && Number.isFinite(currentInputTokens) && currentInputTokens > 0
        ? Math.floor(currentInputTokens)
        : 0
      const messageAfterTokensWithInput = messageAfterTokens != null
        ? messageAfterTokens + runInputTokens
        : undefined
      const afterContextTokens = messageAfterTokensWithInput != null
        ? contextTokensWithCachedOverhead(state, messageAfterTokensWithInput)
        : undefined
      const payload = {
        event: 'compression.completed',
        run_id: chunk.run_id,
        request_id: ev.request_id,
        compressed: compressionResult?.compressed ?? ev.compressed !== false,
        llmCompressed: compressionResult?.llmCompressed,
        totalMessages: compressionResult?.beforeMessages ?? ev.message_count,
        resultMessages: compressionResult?.resultMessages ?? ev.result_messages,
        beforeTokens: compressionResult?.beforeTokens ?? ev.approx_tokens,
        afterTokens: messageAfterTokensWithInput,
        contextTokens: afterContextTokens,
        summaryTokens: compressionResult?.summaryTokens,
        verbatimCount: compressionResult?.verbatimCount,
        compressedStartIndex: compressionResult?.compressedStartIndex,
        source: 'bridge',
      }
      if (ev.request_id && state.bridgeCompressionResults) {
        delete state.bridgeCompressionResults[String(ev.request_id)]
      }
      replaceState(sessionMap, sessionId, 'compression.completed', payload)
      emit('compression.completed', payload)
      const usage = await calcAndUpdateUsage(sessionId, state, emit)
      if (!ownsRun()) return
      if (messageAfterTokensWithInput != null) {
        updateMessageContextTokenUsage(sessionId, state, emit, messageAfterTokensWithInput, usage)
      }
    } else if (evType === 'bridge.compression.failed') {
      const payload = {
        event: 'compression.completed',
        run_id: chunk.run_id,
        request_id: ev.request_id,
        compressed: false,
        totalMessages: ev.message_count,
        resultMessages: ev.message_count,
        beforeTokens: ev.approx_tokens,
        error: ev.error,
        source: 'bridge',
      }
      if (ev.request_id && state.bridgeCompressionResults) {
        delete state.bridgeCompressionResults[String(ev.request_id)]
      }
      replaceState(sessionMap, sessionId, 'compression.completed', payload)
      emit('compression.completed', payload)
    } else if (evType === 'status') {
      const payload = {
        ...ev,
        event: 'agent.event',
        run_id: chunk.run_id,
      }
      replaceState(sessionMap, sessionId, 'agent.event', payload)
      emit('agent.event', payload)
    }
  }

  if (!ownsRun()) return
  // Only process the aggregated chunk.delta when the bridge did NOT emit
  // ordered stream.delta events for this chunk. With ordered events, the text
  // was already handled above in true interleaved order; processing it again
  // here would duplicate it.
  if (chunk.delta && !sawStreamDeltaEvent) {
    const delta = filterBridgeToolCallMarkupDelta(state, chunk.delta)
    if (delta) {
      state.bridgeOutput = (state.bridgeOutput || '') + delta
      state.bridgePendingAssistantContent = (state.bridgePendingAssistantContent || '') + delta
      const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
      if (last?.role === 'assistant' && last.finish_reason == null) {
        last.content += delta
        if (!last.run_id) last.run_id = chunk.run_id
        syncBridgeReasoningToMessage(last, state.bridgePendingReasoningContent)
      } else {
        state.messages.push({
          id: state.messages.length + 1,
          session_id: sessionId,
          runMarker,
          run_id: chunk.run_id,
          role: 'assistant',
          content: delta,
          reasoning: state.bridgePendingReasoningContent || null,
          reasoning_content: state.bridgePendingReasoningContent || null,
          timestamp: Math.floor(Date.now() / 1000),
        })
      }
      emit('message.delta', {
        event: 'message.delta',
        run_id: chunk.run_id,
        delta,
        output: state.bridgeOutput,
      })
    }
  }

  if (!chunk.done) return
  if (!ownsRun() || !state.isWorking) return
  if (state.isAborting) {
    bridgeLogger.info({
      sessionId,
      runId: chunk.run_id,
      status: chunk.status,
    }, '[chat-run-socket][abort] completing CLI bridge abort after terminal chunk')
    if (await finalizeBridgeAbort(state, true)) return
    await emitWorkspaceDiffCompleted?.()
    if (!ownsRun()) return
    await markAbortCompleted(
      nsp,
      socket,
      sessionId,
      chunk.run_id || runMarker,
      sessionMap,
      dequeueNextQueuedRun,
      true,
      runOwnership,
    )
    return
  }

  // If the run terminated while we still had a partial tool-call-marker
  // prefix buffered, flush it to the user-visible stream now. Discarding
  // it (which the line below was doing implicitly) silently drops the
  // final characters of the assistant message.
  flushPendingToolMarkupToAssistant(state, runMarker, chunk.run_id, emit)
  flushBridgePendingToDb(state, sessionId)
  state.bridgePendingToolCallMarkup = undefined
  updateSessionStats(sessionId)
  await delay(BRIDGE_USAGE_FLUSH_DELAY_MS)
  if (!ownsRun()) return
  const usage = await calcAndUpdateUsage(sessionId, state, emit)
  if (!ownsRun()) return
  const contextTokens = await refreshFinalContextUsage({
    sessionId,
    profile,
    model: modelContext.model,
    provider: modelContext.provider,
    instructions,
    state,
    usage,
    emit,
    bridge,
  })
  if (!ownsRun()) return
  updateUsage(sessionId, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    profile: state.profile,
  })
  const terminalError = bridgeTerminalError(chunk)
  const eventName = terminalError ? 'run.failed' : 'run.completed'
  const payload = {
    event: eventName,
    run_id: chunk.run_id,
    output: chunk.output || state.bridgeOutput || '',
    result: chunk.result,
    error: terminalError || chunk.error,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    contextTokens,
    queue_remaining: state.queue.length,
  }
  await emitWorkspaceDiffCompleted?.()
  if (!ownsRun()) return
  emit(eventName, payload)

  if (!terminalError) {
    await maybeEnqueueGoalContinuation({
      nsp,
      socket,
      sessionId,
      state,
      bridge,
      profile,
      modelContext,
      modelGroups,
      instructions,
      finalResponse: bridgeFinalResponse(chunk, state),
      ownsRun,
    })
    if (!ownsRun()) return
    if (state.isAborting) {
      if (await finalizeBridgeAbort(state, true)) return
      await markAbortCompleted(
        nsp,
        socket,
        sessionId,
        chunk.run_id || runMarker,
        sessionMap,
        dequeueNextQueuedRun,
        true,
        runOwnership,
      )
      return
    }
  }

  const hasQueuedRun = state.queue.length > 0
  state.isWorking = false
  state.isAborting = false
  state.abortController = undefined
  state.goalEvaluationAbortController = undefined
  state.profile = undefined
  state.runId = undefined
  state.activeRunMarker = undefined
  state.events = []
  unregisterBridgeAbortFinalizer(state)

  if (hasQueuedRun) {
    dequeueNextQueuedRun(socket, sessionId)
  }
}

async function pollBridgeGeneratedTitleAfterRun(
  bridge: AgentBridgeClient,
  sessionId: string,
  profile: string,
  emit: (event: string, payload: any) => void,
  ownsRun: () => boolean,
) {
  if (!shouldPollBridgeGeneratedTitle(sessionId)) return
  const deadline = Date.now() + BRIDGE_TITLE_EVENT_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await delay(BRIDGE_TITLE_EVENT_POLL_INTERVAL_MS)
    if (!ownsRun()) return
    let title = ''
    try {
      const result = await bridge.getSessionTitle(sessionId, profile, { timeoutMs: 2000 })
      if (!ownsRun()) return
      title = normalizeTitleText(result.title)
    } catch (err) {
      logger.debug(err, '[chat-run-socket] stopped polling bridge generated title for session %s', sessionId)
      return
    }
    if (title) {
      syncBridgeGeneratedTitle(sessionId, title, emit)
      return
    }
  }
}

function bridgeFinalResponse(chunk: AgentBridgeOutput, state: SessionState): string {
  const result = chunk.result && typeof chunk.result === 'object' && !Array.isArray(chunk.result)
    ? chunk.result as Record<string, unknown>
    : null
  const finalResponse = result && typeof result.final_response === 'string'
    ? result.final_response
    : ''
  return finalResponse || chunk.output || state.bridgeOutput || ''
}

function hasRealQueuedRun(state: SessionState): boolean {
  return state.queue.some(item => !item.goalContinuation)
}

async function maybeEnqueueGoalContinuation(args: {
  nsp: ReturnType<Server['of']>
  socket: Socket
  sessionId: string
  state: SessionState
  bridge: AgentBridgeClient
  profile: string
  modelContext: { model?: string | null; provider?: string | null }
  modelGroups?: RunModelGroup[]
  instructions: string
  finalResponse: string
  ownsRun: () => boolean
}) {
  if (!args.ownsRun()) return
  const finalResponse = args.finalResponse || ''
  if (!finalResponse.trim()) return
  if (hasRealQueuedRun(args.state)) return

  const goalEvaluationAbortController = new AbortController()
  const runSignal = args.state.abortController?.signal
  const abortGoalEvaluation = () => goalEvaluationAbortController.abort()
  if (runSignal?.aborted) abortGoalEvaluation()
  else runSignal?.addEventListener('abort', abortGoalEvaluation, { once: true })
  args.state.goalEvaluationAbortController = goalEvaluationAbortController
  let decision
  try {
    decision = await awaitWithTimeoutAndAbortSignal(
      args.bridge.goalEvaluate(args.sessionId, finalResponse, args.profile),
      BRIDGE_GOAL_EVALUATE_TIMEOUT_MS,
      'goal evaluation timed out',
      goalEvaluationAbortController.signal,
    )
    if (!args.ownsRun()) return
  } catch (err) {
    if (!isAbortError(err)) {
      logger.warn(err, '[chat-run-socket] /goal evaluation failed for session %s', args.sessionId)
    }
    return
  } finally {
    runSignal?.removeEventListener('abort', abortGoalEvaluation)
    if (args.state.goalEvaluationAbortController === goalEvaluationAbortController) {
      args.state.goalEvaluationAbortController = undefined
    }
  }

  if (isGoalJudgeUnavailable(decision.reason)) {
    if (!args.ownsRun()) return
    emitGoalStatus(
      args.nsp,
      args.socket,
      args.sessionId,
      args.state,
      'judge_unavailable',
      'Goal judge is not configured; automatic goal continuation was skipped. The goal remains active, but Hermes cannot mark it done automatically.',
    )
    return
  }

  const message = typeof decision.message === 'string' ? decision.message.trim() : ''
  if (!args.ownsRun()) return
  if (message) emitGoalStatus(args.nsp, args.socket, args.sessionId, args.state, decision.verdict || 'goal', message)

  if (!decision.should_continue) return
  if (hasRealQueuedRun(args.state)) return

  const prompt = typeof decision.continuation_prompt === 'string'
    ? decision.continuation_prompt.trim()
    : ''
  if (!prompt) return
  if (!args.ownsRun()) return

  const next: QueuedRun = {
    queue_id: `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    input: prompt,
    displayInput: null,
    storageMessage: prompt,
    model: args.modelContext.model || undefined,
    provider: args.modelContext.provider || undefined,
    model_groups: args.modelGroups,
    instructions: undefined,
    profile: args.profile,
    source: args.state.source === 'global_agent' ? 'global_agent' : 'cli',
    goalContinuation: true,
  }
  if (!args.ownsRun()) return
  args.state.queue.push(next)
}

function isGoalJudgeUnavailable(reason?: string | null): boolean {
  const value = String(reason || '').toLowerCase()
  return value.includes('no auxiliary client configured') || value.includes('auxiliary client unavailable')
}

function emitGoalStatus(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  sessionId: string,
  state: SessionState,
  action: string,
  message: string,
) {
  const now = Math.floor(Date.now() / 1000)
  const id = addMessage({
    session_id: sessionId,
    role: 'command',
    content: message,
    timestamp: now,
  })
  state.messages.push({
    id: id || `goal_${now}_${state.messages.length}`,
    session_id: sessionId,
    role: 'command',
    content: message,
    timestamp: now,
  })
  nsp.to(`session:${sessionId}`).emit('session.command', {
    event: 'session.command',
    session_id: sessionId,
    command: 'goal',
    ok: true,
    action,
    message,
    terminal: false,
  })
  if (!nsp.adapter.rooms.get(`session:${sessionId}`)?.size && socket.connected) {
    socket.emit('session.command', {
      event: 'session.command',
      session_id: sessionId,
      command: 'goal',
      ok: true,
      action,
      message,
      terminal: false,
    })
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      err => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
