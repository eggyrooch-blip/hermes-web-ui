/**
 * API Server run handler — handles runs that stream from upstream /v1/responses.
 */

import type { Server, Socket } from 'socket.io'
import { getSystemPrompt } from '../../../lib/llm-prompt'
import {
  getSession,
  createSession,
  addMessage,
  updateSessionStats,
  getSessionDetailPaginated,
} from '../../../db/hermes/session-store'
import { updateUsage } from '../../../db/hermes/usage-store'
import { logger } from '../../logger'
import { contentBlocksToString, extractTextForPreview, isContentBlockArray, convertContentBlocks } from './content-blocks'
import { convertHistoryFormat } from './message-format'
import { readSseFrames } from './sse-utils'
import { extractResponseText } from './response-utils'
import { applyResponseStreamEvent, flushResponseRunToDb } from './response-stream'
import { buildCompressedHistory, buildDbHistory, buildSnapshotAwareHistory } from './compression'
import { calcAndUpdateUsage, estimateUsageTokensFromMessages } from './usage'
import { handleMessage } from './message-format'
import { countTokens, SUMMARY_PREFIX } from '../../../lib/context-compressor'
import { getCompressionSnapshot } from '../../../db/hermes/compression-snapshot'
import type { ContentBlock, SessionState, ChatRunSource } from './types'
import {
  captureSessionRunOwnership,
  ownsSessionRun,
  type SessionRunOwnership,
} from './session-run-ownership'

export function resolveRunSource(source?: string, sessionId?: string): ChatRunSource {
  if (source === 'api_server' || source === 'cli' || source === 'coding_agent' || source === 'global_agent') return source
  if (sessionId) {
    const stored = getSession(sessionId)?.source
    if (stored === 'api_server' || stored === 'cli' || stored === 'coding_agent' || stored === 'global_agent') return stored
  }
  return 'cli'
}

export async function loadSessionStateFromDb(sid: string, _sessionMap: Map<string, SessionState>): Promise<SessionState> {
  try {
    const actualDetail = getSessionDetailPaginated(sid)

    const messages = actualDetail?.messages ? handleMessage(actualDetail.messages, sid) : []

    let inputTokens: number
    let outputTokens: number
    let contextTokens: number | undefined
    const snapshot = getCompressionSnapshot(sid)
    if (snapshot && snapshot.lastMessageIndex >= 0 && snapshot.lastMessageIndex < messages.length) {
      const newMessages = messages.slice(snapshot.lastMessageIndex + 1)
      const newUsage = estimateUsageTokensFromMessages(newMessages)
      inputTokens = countTokens(SUMMARY_PREFIX + snapshot.summary) +
        newUsage.inputTokens
      outputTokens = newUsage.outputTokens
    } else {
      const usage = estimateUsageTokensFromMessages(messages)
      inputTokens = usage.inputTokens
      outputTokens = usage.outputTokens
    }
    try {
      const session = getSession(sid)
      const dbHistory = await buildDbHistory(sid, { excludeLastUser: false })
      const snapshotHistory = await buildSnapshotAwareHistory(
        sid,
        session?.profile || 'default',
        dbHistory,
        { model: session?.model, provider: session?.provider },
      )
      const contextUsage = estimateUsageTokensFromMessages(snapshotHistory)
      contextTokens = contextUsage.inputTokens + contextUsage.outputTokens
    } catch (err) {
      logger.warn(err, '[chat-run-socket] failed to calculate snapshot-aware context tokens for session %s', sid)
    }

    logger.info('[chat-run-socket] loaded session %s from DB (%d messages)', sid, messages.length)
    return {
      messages,
      messageTotal: actualDetail?.total || messages.length,
      messageLoadedCount: actualDetail?.messages.length || messages.length,
      messagePageLimit: actualDetail?.limit,
      hasMoreBefore: actualDetail?.hasMore || false,
      isWorking: false,
      events: [],
      inputTokens,
      outputTokens,
      contextTokens,
      queue: [],
    }
  } catch (err) {
    logger.warn(err, '[chat-run-socket] failed to load session %s from DB', sid)
    return { messages: [], isWorking: false, events: [], queue: [] }
  }
}

export async function handleApiRun(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  data: { input: string | ContentBlock[]; session_id?: string; model?: string; provider?: string; instructions?: string; workspace?: string | null; source?: string; queue_id?: string; peerExcludeSocketId?: string },
  profile: string,
  sessionMap: Map<string, SessionState>,
  skipUserMessage = false,
  dequeueNextQueuedRun: (socket: Socket, sessionId: string, fallbackProfile?: string) => void,
) {
  const { input, session_id, model, provider, instructions } = data

  // Build full instructions with system prompt + workspace context
  let fullInstructions = instructions
    ? `${getSystemPrompt()}\n${instructions}`
    : getSystemPrompt()
  if (session_id) {
    const sessionRow = getSession(session_id)
    const workspace = sessionRow?.workspace || String(data.workspace || '').trim()
    if (workspace) {
      const workspaceCtx = `[Current working directory: ${workspace}]`
      fullInstructions = `\n${workspaceCtx}\n${fullInstructions}`
    }
  }

  const upstream = ''
  const apiKey = undefined

  const runMarker = session_id
    ? `resp_run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    : undefined

  let runOwnership: SessionRunOwnership | undefined
  let upstreamAbortController: AbortController | undefined
  const ownsRun = () => !runOwnership || ownsSessionRun(sessionMap, runOwnership)
  const guardRun = () => {
    if (ownsRun()) return true
    upstreamAbortController?.abort()
    return false
  }
  const emitDirect = (event: string, payload: any) => {
    const tagged = session_id ? { ...payload, session_id } : payload
    if (session_id) {
      nsp.to(`session:${session_id}`).emit(event, tagged)
    } else if (socket.connected) {
      socket.emit(event, tagged)
    }
  }
  const emit = (event: string, payload: any) => {
    if (guardRun()) emitDirect(event, payload)
  }
  const failAndRelease = (error: string, queueLen: number, extra: Record<string, any> = {}) => {
    emitDirect('run.failed', { event: 'run.failed', ...extra, error, queue_remaining: queueLen })
    if (runOwnership) releaseApiRun(runOwnership)
    if (session_id && queueLen > 0) dequeueNextQueuedRun(socket, session_id)
  }

  const now = Math.floor(Date.now() / 1000)
  if (session_id) {
    let state = sessionMap.get(session_id)
    if (!state) {
      state = getSession(session_id)
        ? await loadSessionStateFromDb(session_id, sessionMap)
        : { messages: [], isWorking: false, events: [], queue: [] }
      sessionMap.set(session_id, state)
    }
    state.isWorking = true
    state.events = []
    state.profile = profile
    const sessionSource: ChatRunSource = data.source === 'global_agent' ? 'global_agent' : 'api_server'
    state.source = sessionSource
    state.activeRunMarker = runMarker

    let peerUserMessage: { id?: number; role: 'user'; content: string; timestamp: number } | null = null
    if (!skipUserMessage) {
      const inputStr = contentBlocksToString(input)
      state.messages.push({
        id: data.queue_id || state.messages.length + 1,
        session_id,
        runMarker,
        role: 'user',
        content: inputStr,
        timestamp: now,
      })

      if (!getSession(session_id)) {
        const previewText = extractTextForPreview(input)
        const preview = previewText.replace(/[\r\n]/g, ' ').substring(0, 100)
        createSession({ id: session_id, profile, source: sessionSource, model, provider, title: preview, workspace: data.workspace || undefined })
      }

      const messageId = addMessage({
        session_id,
        client_id: data.queue_id || null,
        role: 'user',
        content: inputStr,
        timestamp: now,
      })
      peerUserMessage = { id: data.queue_id ? undefined : messageId, role: 'user', content: inputStr, timestamp: now }
    } else {
      const inputStr = contentBlocksToString(input)
      state.messages.push({
        id: data.queue_id || state.messages.length + 1,
        session_id,
        runMarker,
        role: 'user',
        content: inputStr,
        timestamp: now,
      })
      if (!getSession(session_id)) {
        const previewText = extractTextForPreview(input)
        const preview = previewText.replace(/[\r\n]/g, ' ').substring(0, 100)
        createSession({ id: session_id, profile, source: sessionSource, model, provider, title: preview, workspace: data.workspace || undefined })
      }
      const messageId = addMessage({
        session_id,
        client_id: data.queue_id || null,
        role: 'user',
        content: inputStr,
        timestamp: now,
      })
      peerUserMessage = { id: data.queue_id ? undefined : messageId, role: 'user', content: inputStr, timestamp: now }
    }

    runOwnership = captureSessionRunOwnership(session_id, state, runMarker!)

    socket.join(`session:${session_id}`)
    if (peerUserMessage && guardRun()) {
      const target = data.peerExcludeSocketId
        ? nsp.to(`session:${session_id}`).except(data.peerExcludeSocketId)
        : socket.to(`session:${session_id}`)
      target.emit('run.peer_user_message', {
        event: 'run.peer_user_message',
        session_id,
        message: {
          ...peerUserMessage,
          id: data.queue_id || peerUserMessage.id,
        },
      })
    }
  }
  try {
    const body: Record<string, any> = { input }
    if (model) body.model = model
    body.instructions = fullInstructions
    if (session_id) {
      const sessionRow = getSession(session_id)
      const compressed = await buildCompressedHistory(session_id, profile, upstream, apiKey, emit, sessionMap, {
        model: sessionRow?.model || model,
        provider: sessionRow?.provider || provider,
      })
      if (!guardRun()) return
      if (compressed.length > 0) {
        body.conversation_history = compressed
      }
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    if (isContentBlockArray(input)) {
      const parts = await convertContentBlocks(input)
      if (!guardRun()) return
      body.input = [{ role: 'user', content: parts }]
    }

    if (body.conversation_history && Array.isArray(body.conversation_history)) {
      body.conversation_history = convertHistoryFormat(body.conversation_history)
    }
    body.stream = true
    body.store = false

    const abortController = new AbortController()
    upstreamAbortController = abortController
    if (runOwnership) {
      if (!guardRun()) return
      const state = runOwnership.state
      state.isWorking = true
      state.runId = undefined
      state.abortController = abortController
    }

    const res = await fetch(`${upstream}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abortController.signal,
    })
    if (!guardRun()) return
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      if (!guardRun()) return
      const queueLen = runOwnership?.state.queue?.length ?? 0
      const completion = runOwnership
        ? await prepareApiCompletion(sessionMap, runOwnership, emit, upstreamAbortController)
        : { completed: true }
      if (!completion.completed || !guardRun()) return
      failAndRelease(appendFinalizationError(`Upstream ${res.status}: ${text}`, completion.error), queueLen)
      return
    }
    if (!res.body) {
      const queueLen = runOwnership?.state.queue?.length ?? 0
      const completion = runOwnership
        ? await prepareApiCompletion(sessionMap, runOwnership, emit, upstreamAbortController)
        : { completed: true }
      if (!completion.completed || !guardRun()) return
      failAndRelease(appendFinalizationError('Upstream response stream missing', completion.error), queueLen)
      return
    }

    let responseId: string | undefined
    for await (const frame of readSseFrames(res.body)) {
      if (!guardRun()) return
      let parsed: any
      try {
        parsed = JSON.parse(frame.data)
      } catch {
        continue
      }
      const upstreamEvent = parsed.type || frame.event || parsed.event
      logger.info('[chat-run-socket] upstream response event: %s', upstreamEvent)

      if (session_id && runOwnership) {
        const state = runOwnership.state
        const mapped = applyResponseStreamEvent(state, session_id, runMarker, upstreamEvent, parsed)
        if (mapped) {
          if (mapped.runId) {
            responseId = mapped.runId
            state.runId = responseId
          }
          emitDirect(mapped.event, mapped.payload)
        }
      }

      if (upstreamEvent === 'response.completed' || upstreamEvent === 'response.failed') {
        if (!guardRun()) {
          logger.info({
            sessionId: session_id,
            runId: responseId,
            event: upstreamEvent,
          }, '[chat-run-socket] suppressing stale API terminal event')
          return
        }
        if (runOwnership?.state.isAborting) {
          logger.info({
            sessionId: session_id,
            runId: responseId,
            event: upstreamEvent,
          }, '[chat-run-socket][abort] suppressing upstream terminal event during abort')
          return
        }
        const queueLen = runOwnership?.state.queue?.length ?? 0
        const completion = runOwnership
          ? await prepareApiCompletion(sessionMap, runOwnership, emit, upstreamAbortController)
          : { completed: true }
        if (!completion.completed || !guardRun()) return
        const finalOutput = parsed.response || parsed
        const finalText = extractResponseText(finalOutput)
        if (completion.error) {
          failAndRelease(
            `API run finalization failed: ${completion.error instanceof Error ? completion.error.message : String(completion.error)}`,
            queueLen,
            { run_id: responseId || finalOutput.id, response_id: responseId || finalOutput.id },
          )
          return
        }
        if (upstreamEvent === 'response.completed' && session_id) {
          const usage = finalOutput.usage || {}
          try {
            updateUsage(session_id, {
              inputTokens: usage.input_tokens ?? usage.inputTokens ?? 0,
              outputTokens: usage.output_tokens ?? usage.outputTokens ?? 0,
              cacheReadTokens: usage.cache_read_tokens ?? usage.cacheReadTokens ?? 0,
              cacheWriteTokens: usage.cache_write_tokens ?? usage.cacheWriteTokens ?? 0,
              reasoningTokens: usage.reasoning_tokens ?? usage.reasoningTokens ?? 0,
              model: finalOutput.model || '',
              profile,
            })
          } catch (err) {
            failAndRelease(
              `API run usage persistence failed: ${err instanceof Error ? err.message : String(err)}`,
              queueLen,
              { run_id: responseId || finalOutput.id, response_id: responseId || finalOutput.id },
            )
            return
          }
        }
        const eventName = upstreamEvent === 'response.completed' ? 'run.completed' : 'run.failed'
        emitDirect(eventName, {
          event: eventName,
          run_id: responseId || finalOutput.id,
          response_id: responseId || finalOutput.id,
          output: finalText,
          usage: finalOutput.usage,
          error: finalOutput.error || parsed.error,
          queue_remaining: queueLen,
        })
        if (runOwnership) releaseApiRun(runOwnership)
        if (session_id && queueLen > 0) dequeueNextQueuedRun(socket, session_id)
        return
      }
    }
    const queueLen = runOwnership?.state.queue?.length ?? 0
    if (!guardRun()) {
      logger.info({
        sessionId: session_id,
        runId: responseId,
      }, '[chat-run-socket] suppressing stale API stream end')
      return
    }
    const completion = runOwnership
      ? await prepareApiCompletion(sessionMap, runOwnership, emit, upstreamAbortController)
      : { completed: true }
    if (!completion.completed || !guardRun()) return
    failAndRelease(
      appendFinalizationError('Response stream ended without a terminal event', completion.error),
      queueLen,
      { run_id: responseId, response_id: responseId },
    )
  } catch (err: any) {
    const queueLen = runOwnership?.state.queue?.length ?? 0
    if (runOwnership) {
      if (!guardRun() || err?.name === 'AbortError') {
        logger.info({
          sessionId: session_id,
          runMarker,
          error: err?.message || String(err),
        }, '[chat-run-socket] suppressing stale/aborted API stream error')
        return
      }
      const completion = await prepareApiCompletion(sessionMap, runOwnership, emit, upstreamAbortController)
      if (!completion.completed || !guardRun()) return
      failAndRelease(appendFinalizationError(err?.message || String(err), completion.error), queueLen)
    } else {
      emitDirect('run.failed', { event: 'run.failed', error: err?.message || String(err) })
    }
  }
}

function appendFinalizationError(message: string, err?: unknown): string {
  return err
    ? `${message}; finalization failed: ${err instanceof Error ? err.message : String(err)}`
    : message
}

async function prepareApiCompletion(
  sessionMap: Map<string, SessionState>,
  ownership: SessionRunOwnership,
  emit: (event: string, payload: any) => void,
  upstreamAbortController?: AbortController,
): Promise<{ completed: boolean; error?: unknown }> {
  const state = ownership.state
  if (!ownsSessionRun(sessionMap, ownership)) {
    upstreamAbortController?.abort()
    return { completed: false }
  }
  if (state.isAborting) {
    logger.info({
      sessionId: ownership.sessionId,
      runId: state.runId,
    }, '[chat-run-socket][abort] terminal upstream event observed; abort handler will finish cleanup')
    return { completed: false }
  }

  let error: unknown
  try {
    flushResponseRunToDb(state, ownership.sessionId)
    updateSessionStats(ownership.sessionId)
    await calcAndUpdateUsage(ownership.sessionId, state, emit)
  } catch (err) {
    error = err
  }

  if (!ownsSessionRun(sessionMap, ownership)) {
    upstreamAbortController?.abort()
    return { completed: false }
  }
  return { completed: true, error }
}

function releaseApiRun(ownership: SessionRunOwnership): void {
  const state = ownership.state
  state.isWorking = false
  state.abortController = undefined
  state.runId = undefined
  state.events = []
  state.responseRun = undefined
  state.activeRunMarker = undefined
  state.profile = undefined
}
