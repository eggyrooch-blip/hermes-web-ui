/**
 * Chat run via Socket.IO — namespace /chat-run.
 *
 * Replaces HTTP POST + SSE. Socket.IO decouples message handling
 * from connection lifecycle: the server continues streaming upstream
 * events even after the client disconnects or refreshes.
 *
 * Uses Socket.IO rooms keyed by session_id. On client reconnect,
 * the client emits 'resume' to rejoin its session room.
 */
import type { Server, Socket } from 'socket.io'
import { EventSource } from 'eventsource'
import { setRunSession, getSessionForRun } from '../../routes/hermes/proxy-handler'
import { updateUsage } from '../../db/hermes/usage-store'
import { getSessionDetailFromDb } from '../../db/hermes/sessions-db'
import { getModelContextLength } from './model-context'
import { ChatContextCompressor, countTokens, SUMMARY_PREFIX } from '../../lib/context-compressor'
import { getCompressionSnapshot } from '../../db/hermes/compression-snapshot'
import { logger } from '../logger'

const compressor = new ChatContextCompressor()

// --- In-flight run tracking ---

interface InFlightRun {
  runId: string
  abortController: AbortController
}

// --- ChatRunSocket ---

export class ChatRunSocket {
  private nsp: ReturnType<Server['of']>
  private gatewayManager: any
  /** sessionId → InFlightRun */
  private activeRuns = new Map<string, InFlightRun>()
  /** sessionId → accumulated state events for reconnecting clients */
  private sessionStates = new Map<string, Array<{ event: string; data: any }>>()

  constructor(io: Server, gatewayManager: any) {
    this.nsp = io.of('/chat-run')
    this.gatewayManager = gatewayManager
  }

  init() {
    this.nsp.use(this.authMiddleware.bind(this))
    this.nsp.on('connection', this.onConnection.bind(this))
    logger.info('[chat-run-socket] Socket.IO ready at /chat-run')
  }

  // --- Auth middleware ---

  private async authMiddleware(socket: Socket, next: (err?: Error) => void) {
    const token = socket.handshake.auth?.token as string | undefined
    if (!process.env.AUTH_DISABLED && process.env.AUTH_DISABLED !== '1') {
      const { getToken } = await import('../auth')
      const serverToken = await getToken()
      if (serverToken && token !== serverToken) {
        return next(new Error('Authentication failed'))
      }
    }
    next()
  }

  // --- Connection handler ---

  private onConnection(socket: Socket) {
    const profile = (socket.handshake.query?.profile as string) || 'default'

    socket.on('run', async (data: {
      input: string
      session_id?: string
      model?: string
      instructions?: string
    }) => {
      await this.handleRun(socket, data, profile)
    })

    socket.on('resume', (data: { session_id?: string }) => {
      if (data.session_id) {
        const sid = data.session_id
        const room = `session:${sid}`
        socket.join(room)

        // Replay all accumulated state events for this session
        const states = this.sessionStates.get(sid)
        if (states) {
          for (const state of states) {
            socket.emit(state.event, { ...state.data, session_id: sid })
          }
          logger.info('[chat-run-socket] replayed %d state events for reconnecting client on session %s', states.length, sid)
        }

        logger.info('[chat-run-socket] socket %s resumed session %s (active: %s)', socket.id, sid, this.activeRuns.has(sid))
      }
    })

    socket.on('abort', (data: { session_id?: string }) => {
      if (data.session_id) {
        this.handleAbort(data.session_id)
      }
    })
  }

  // --- Run handler ---

  private async handleRun(
    socket: Socket,
    data: { input: string; session_id?: string; model?: string; instructions?: string },
    profile: string,
  ) {
    const { input, session_id, model, instructions } = data
    const upstream = (process.env.UPSTREAM || 'http://127.0.0.1:8642').replace(/\/$/, '')
    const apiKey = this.gatewayManager.getApiKey(profile) || undefined

    // Join session room — events go to room, survives socket disconnect
    if (session_id) {
      socket.join(`session:${session_id}`)
    }

    // Emit helper: tag every payload with session_id
    const emit = (event: string, payload: any) => {
      const tagged = session_id ? { ...payload, session_id } : payload
      if (session_id) {
        this.nsp.to(`session:${session_id}`).emit(event, tagged)
      } else if (socket.connected) {
        socket.emit(event, tagged)
      }
    }

    try {
      // Build upstream request body
      const body: Record<string, any> = { input }
      if (session_id) body.session_id = session_id
      if (model) body.model = model
      if (instructions) body.instructions = instructions

      // Build conversation_history from DB if session_id is provided
      if (session_id) {
        try {
          const detail = await getSessionDetailFromDb(session_id)
          if (detail?.messages?.length) {
            let history: Array<{
              role: string
              content: string
              tool_calls?: any[]
              tool_call_id?: string
              name?: string
            }> = detail.messages
              .filter(m => (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') && m.content !== undefined)
              .map(m => {
                const msg: any = { role: m.role, content: m.content || '' }
                if (m.tool_calls?.length) msg.tool_calls = m.tool_calls
                if (m.tool_call_id) msg.tool_call_id = m.tool_call_id
                if (m.tool_name) msg.name = m.tool_name
                return msg
              })

            // Context compression with snapshot awareness
            const contextLength = getModelContextLength(profile)
            const triggerTokens = Math.floor(contextLength / 2)

            // Step 1: Check existing snapshot — if present, assemble summary + new messages
            const snapshot = session_id ? getCompressionSnapshot(session_id) : null
            if (snapshot) {
              const newMessages = history.slice(snapshot.lastMessageIndex + 1)
              const summaryTokens = countTokens(SUMMARY_PREFIX + snapshot.summary)
              const newTokens = newMessages.reduce((sum, m) => sum + countTokens(m.content), 0)
              const assembledTokens = summaryTokens + newTokens
              logger.info('[context-compress] session=%s: snapshot at %d, %d new messages, assembled ~%d tokens (threshold %d)',
                session_id, snapshot.lastMessageIndex, newMessages.length, assembledTokens, triggerTokens)
              if (assembledTokens <= triggerTokens) {
                // Under threshold — use assembled context directly, no LLM call needed
                history = [
                  { role: 'user', content: SUMMARY_PREFIX + '\n\n' + snapshot.summary },
                  ...newMessages,
                ]
              } else {
                // Over threshold — needs incremental LLM compression
                const beforeTokens = assembledTokens
                this.pushState(session_id, 'compression.started', {
                  event: 'compression.started',
                  message_count: newMessages.length,
                  token_count: beforeTokens,
                })
                emit('compression.started', {
                  event: 'compression.started',
                  message_count: newMessages.length,
                  token_count: beforeTokens,
                })

                try {
                  const result = await compressor.compress(
                    history, upstream, apiKey, session_id, contextLength,
                  )

                  this.replaceState(session_id, 'compression.completed', {
                    event: 'compression.completed',
                    compressed: result.meta.compressed,
                    llmCompressed: result.meta.llmCompressed,
                    totalMessages: result.meta.totalMessages,
                    resultMessages: result.messages.length,
                    beforeTokens,
                    afterTokens: result.messages.reduce((sum, m) => sum + countTokens(m.content), 0),
                    summaryTokens: result.meta.summaryTokenEstimate,
                    verbatimCount: result.meta.verbatimCount,
                    compressedStartIndex: result.meta.compressedStartIndex,
                  })
                  logger.info('[context-compress] AFTER  session=%s: %d messages, ~%d tokens (was %d)', session_id, result.messages.length, result.messages.reduce((sum, m) => sum + countTokens(m.content), 0), beforeTokens)

                  emit('compression.completed', {
                    event: 'compression.completed',
                    compressed: result.meta.compressed,
                    llmCompressed: result.meta.llmCompressed,
                    totalMessages: result.meta.totalMessages,
                    resultMessages: result.messages.length,
                    beforeTokens,
                    afterTokens: result.messages.reduce((sum, m) => sum + countTokens(m.content), 0),
                    summaryTokens: result.meta.summaryTokenEstimate,
                    verbatimCount: result.meta.verbatimCount,
                    compressedStartIndex: result.meta.compressedStartIndex,
                  })

                  history = result.messages.map(m => ({
                    role: m.role,
                    content: m.content,
                    tool_calls: m.tool_calls,
                    tool_call_id: m.tool_call_id,
                    name: m.name,
                  }))
                } catch (err: any) {
                  this.replaceState(session_id, 'compression.completed', {
                    event: 'compression.completed',
                    compressed: false,
                    totalMessages: newMessages.length,
                    resultMessages: newMessages.length,
                    beforeTokens,
                    afterTokens: beforeTokens,
                    summaryTokens: 0,
                    verbatimCount: newMessages.length,
                    compressedStartIndex: -1,
                    error: err.message,
                  })
                  logger.warn(err, '[chat-run-socket] compression failed for session %s, using assembled context', session_id)
                  emit('compression.completed', {
                    event: 'compression.completed',
                    compressed: false,
                    totalMessages: newMessages.length,
                    resultMessages: newMessages.length,
                    beforeTokens,
                    afterTokens: beforeTokens,
                    summaryTokens: 0,
                    verbatimCount: newMessages.length,
                    compressedStartIndex: -1,
                    error: err.message,
                  })
                }
              }
            } else if (history.length > 4) {
              // No snapshot — check if raw history exceeds threshold
              const beforeTokens = history.reduce((sum, m) => sum + countTokens(m.content), 0)

              if (beforeTokens <= triggerTokens) {
                // Under threshold — use raw history as-is
                logger.info('[context-compress] session=%s: %d messages, ~%d tokens — under threshold, skip', session_id, history.length, beforeTokens)
              } else {
                // Over threshold — full LLM compression
                logger.info('[context-compress] BEFORE session=%s: %d messages, ~%d tokens (threshold %d)', session_id, history.length, beforeTokens, triggerTokens)

                this.pushState(session_id, 'compression.started', {
                  event: 'compression.started',
                  message_count: history.length,
                  token_count: beforeTokens,
                })
                emit('compression.started', {
                  event: 'compression.started',
                  message_count: history.length,
                  token_count: beforeTokens,
                })

                try {
                  const result = await compressor.compress(
                    history, upstream, apiKey, session_id, contextLength,
                  )

                  this.replaceState(session_id, 'compression.completed', {
                    event: 'compression.completed',
                    compressed: result.meta.compressed,
                    llmCompressed: result.meta.llmCompressed,
                    totalMessages: result.meta.totalMessages,
                    resultMessages: result.messages.length,
                    beforeTokens,
                    afterTokens: result.messages.reduce((sum, m) => sum + countTokens(m.content), 0),
                    summaryTokens: result.meta.summaryTokenEstimate,
                    verbatimCount: result.meta.verbatimCount,
                    compressedStartIndex: result.meta.compressedStartIndex,
                  })
                  logger.info('[context-compress] AFTER  session=%s: %d messages, ~%d tokens (was %d)', session_id, result.messages.length, result.messages.reduce((sum, m) => sum + countTokens(m.content), 0), beforeTokens)

                  emit('compression.completed', {
                    event: 'compression.completed',
                    compressed: result.meta.compressed,
                    llmCompressed: result.meta.llmCompressed,
                    totalMessages: result.meta.totalMessages,
                    resultMessages: result.messages.length,
                    beforeTokens,
                    afterTokens: result.messages.reduce((sum, m) => sum + countTokens(m.content), 0),
                    summaryTokens: result.meta.summaryTokenEstimate,
                    verbatimCount: result.meta.verbatimCount,
                    compressedStartIndex: result.meta.compressedStartIndex,
                  })

                  history = result.messages.map(m => ({
                    role: m.role,
                    content: m.content,
                    tool_calls: m.tool_calls,
                    tool_call_id: m.tool_call_id,
                    name: m.name,
                  }))
                } catch (err: any) {
                  this.replaceState(session_id, 'compression.completed', {
                    event: 'compression.completed',
                    compressed: false,
                    totalMessages: history.length,
                    resultMessages: history.length,
                    beforeTokens,
                    afterTokens: beforeTokens,
                    summaryTokens: 0,
                    verbatimCount: history.length,
                    compressedStartIndex: -1,
                    error: err.message,
                  })
                  logger.warn(err, '[chat-run-socket] compression failed for session %s, using raw history', session_id)
                  emit('compression.completed', {
                    event: 'compression.completed',
                    compressed: false,
                    totalMessages: history.length,
                    resultMessages: history.length,
                    beforeTokens,
                    afterTokens: beforeTokens,
                    summaryTokens: 0,
                    verbatimCount: history.length,
                    compressedStartIndex: -1,
                    error: err.message,
                  })
                }
              }
            }

            body.conversation_history = history
          }
        } catch (err) {
          logger.warn(err, '[chat-run-socket] failed to load conversation history for session %s', session_id)
        }
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

      const res = await fetch(`${upstream}/v1/runs`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        emit('run.failed', { event: 'run.failed', error: `Upstream ${res.status}: ${text}` })
        return
      }

      const runData = await res.json() as any
      const runId = runData.run_id
      if (!runId) {
        emit('run.failed', { event: 'run.failed', error: 'No run_id in upstream response' })
        return
      }

      if (session_id) {
        setRunSession(runId, session_id)
      }

      const abortController = new AbortController()
      if (session_id) {
        this.activeRuns.set(session_id, { runId, abortController })
      }

      emit('run.started', { event: 'run.started', run_id: runId, status: runData.status })

      // Stream upstream events via EventSource — survives socket disconnect
      const eventsUrl = new URL(`${upstream}/v1/runs/${runId}/events`)
      if (apiKey) eventsUrl.searchParams.set('token', apiKey)

      const source = new EventSource(eventsUrl.toString())

      source.onmessage = (event: MessageEvent) => {
        try {
          const parsed = JSON.parse(event.data as string)

          // Intercept run.completed for usage tracking
          if (parsed.event === 'run.completed' && parsed.usage && parsed.run_id) {
            const sid = getSessionForRun(parsed.run_id)
            if (sid) {
              updateUsage(sid, parsed.usage.input_tokens, parsed.usage.output_tokens)
            }
          }

          emit(parsed.event || 'message', parsed)

          if (parsed.event === 'run.completed' || parsed.event === 'run.failed') {
            source.close()
            if (session_id) this.markCompleted(session_id, { event: parsed.event, run_id: parsed.run_id })
          }
        } catch { /* not JSON, skip */ }
      }

      source.onerror = () => {
        source.close()
        emit('run.failed', { event: 'run.failed', error: 'EventSource connection lost' })
        if (session_id) this.markCompleted(session_id, { event: 'run.failed' })
      }
    } catch (err: any) {
      emit('run.failed', { event: 'run.failed', error: err.message })
      if (session_id) this.markCompleted(session_id, { event: 'run.failed' })
    }
  }

  // --- Abort handler ---

  private handleAbort(sessionId: string) {
    const run = this.activeRuns.get(sessionId)
    if (run) {
      run.abortController.abort()
      this.markCompleted(sessionId, { event: 'run.failed', run_id: run.runId })
    }
  }

  /** Mark a session run as completed/failed so reconnecting clients get notified */
  private markCompleted(sessionId: string, info: { event: string; run_id?: string }) {
    this.activeRuns.delete(sessionId)
    this.pushState(sessionId, info.event, { event: info.event, run_id: info.run_id })
    // Auto-cleanup after 30s — enough time for a page refresh
    setTimeout(() => this.sessionStates.delete(sessionId), 30_000)
  }

  /** Append a state event for a session (used for replay on reconnect) */
  private pushState(sessionId: string, event: string, data: any) {
    if (!this.sessionStates.has(sessionId)) {
      this.sessionStates.set(sessionId, [])
    }
    this.sessionStates.get(sessionId)!.push({ event, data })
  }

  /** Replace the last state with the same event name, or append if different */
  private replaceState(sessionId: string, event: string, data: any) {
    const states = this.sessionStates.get(sessionId)
    if (states) {
      const idx = states.findIndex(s => s.event === event)
      if (idx >= 0) {
        states[idx] = { event, data }
        return
      }
    }
    this.pushState(sessionId, event, data)
  }
}
