import { io, type Socket } from 'socket.io-client'
import { getBaseUrlValue, getApiKey } from '../client'
import { useProfilesStore } from '@/stores/hermes/profiles'

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; name: string; path: string; media_type: string }
  | { type: 'file'; name: string; path: string; media_type?: string }

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | ContentBlock[]
}

export interface StartRunRequest {
  input: string | ContentBlock[]
  instructions?: string
  session_id?: string
  profile?: string
  model?: string
  provider?: string
  model_groups?: Array<{ provider: string; models: string[] }>
  queue_id?: string
  source?: 'api_server' | 'cli' | 'coding_agent' | 'global_agent'
  session_source?: 'global_agent'
  coding_agent_id?: 'claude-code' | 'codex'
  agent_id?: 'claude-code' | 'codex'
  mode?: 'scoped' | 'global'
  workspace?: string | null
  baseUrl?: string
  base_url?: string
  apiKey?: string
  api_key?: string
  apiMode?: 'chat_completions' | 'codex_responses' | 'anthropic_messages'
  api_mode?: 'chat_completions' | 'codex_responses' | 'anthropic_messages'
  /** Per-session reasoning effort override.
   * Empty/undefined = use config.yaml default. */
  reasoning_effort?: string
  /** Active expert overlay id (专家广场). When set, the multitenancy layer
   *  injects the expert persona overlay for this run only. Empty/undefined =
   *  the default Hermes persona. Also forwarded as the `X-Hermes-Expert-Id`
   *  request header by the run transport. */
  expert_id?: string
  expert_label?: string
  expert_avatar?: string
}

export interface StartRunResponse {
  run_id: string
  status: string
}

// SSE event types from /v1/runs/{id}/events
export interface RunEvent {
  event: string
  run_id?: string
  delta?: string
  /** Payload text for `reasoning.delta` / `thinking.delta` / `reasoning.available` events. */
  text?: string
  tool?: string
  name?: string
  preview?: string
  timestamp?: number
  error?: string
  /** Final response text on `run.completed`. May be empty/null if the agent
   * silently swallowed an upstream error — see chat store for fallback. */
  output?: string | null
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }
  /** session_id tag added by server for client-side filtering */
  session_id?: string
  /** Generated session title from session.title.updated. */
  title?: string
  /** Queue length from run.queued event */
  queue_length?: number
  /** Abort cleanup will be followed by a concrete run.failed event. */
  failure_pending?: boolean
  /** Request-scoped queue item rejected before admission. */
  queue_id?: string
  /** Stable identity shared by a live terminal event and its resume replay. */
  resume_event_id?: string
  /** Stable displayed-command identity; equals client_id when the message was persisted. */
  command_message_id?: string
  /** Exact server-side session generation for credential lifecycle events. */
  session_row_id?: number
  session_incarnation?: number
  /** Queue item that was just removed because it is starting now. */
  dequeued_queue_id?: string
  /** Queued user messages from run.queued/resume payloads. */
  queued_messages?: Array<{
    id?: string | number
    role?: string
    content?: string
    timestamp?: number
    queued?: boolean
  }>
  /** User message broadcast to other windows already watching the same session. */
  message?: {
    id?: string | number
    role?: string
    content?: string
    timestamp?: number
    queued?: boolean
  }
  /** Workspace diff summary from explicit-workspace agent runs. */
  change_id?: string
  workspace?: string
  workspace_kind?: 'git' | 'filesystem'
  files_changed?: number
  additions?: number
  deletions?: number
  truncated?: boolean
  total_patch_bytes?: number
  files?: Array<Record<string, unknown>>
}

export interface ResumeSessionPayload {
  session_id: string
  messages: any[]
  messageTotal?: number
  messageLoadedCount?: number
  messagePageLimit?: number
  hasMoreBefore?: boolean
  isWorking: boolean
  isAborting?: boolean
  events: Array<{ id?: string; event: string; data: RunEvent }>
  inputTokens?: number
  outputTokens?: number
  contextTokens?: number
  queueLength?: number
  queueMessages?: RunEvent['queued_messages']
}

// ============================
// Socket.IO chat run connection
// ============================

let chatRunSocket: Socket | null = null
let globalListenersRegistered = false
let chatRunSocketProfile: string | null = null
let chatRunSocketAgentId: string | null = null
export type ChatRunTransport = 'chat-run' | 'global-agent'
export type ResumeEventConsumption = boolean | string[] | void
let chatRunSocketTransport: ChatRunTransport = 'chat-run'
const consumedResumeEventIds = new Set<string>()
const processingResumeEventIds = new Set<string>()
const MAX_CONSUMED_RESUME_EVENT_IDS = 500

const TRANSIENT_DISCONNECT_REASONS = new Set<string>([
  'transport close',
  'transport error',
  'ping timeout',
])

/**
 * Session event handlers map
 * Maps session_id to event handling functions for isolating concurrent session streams
 */
const sessionEventHandlers = new Map<string, {
  onMessageDelta: (event: RunEvent) => void
  onReasoningDelta: (event: RunEvent) => void
  onThinkingDelta: (event: RunEvent) => void
  onReasoningAvailable: (event: RunEvent) => void
  onToolStarted: (event: RunEvent) => void
  onToolCompleted: (event: RunEvent) => void
  onSubagentEvent?: (event: RunEvent) => void
  onRunStarted: (event: RunEvent) => void
  onRunCompleted: (event: RunEvent) => void
  onRunFailed: (event: RunEvent) => void
  onCompressionStarted: (event: RunEvent) => void
  onCompressionCompleted: (event: RunEvent) => void
  onAbortStarted: (event: RunEvent) => void
  onAbortTimeout?: (event: RunEvent) => void
  onAbortCompleted: (event: RunEvent) => void
  onUsageUpdated: (event: RunEvent) => void
  onAgentEvent?: (event: RunEvent) => void
  onSessionCommand?: (event: RunEvent) => void
  onSessionTitleUpdated?: (event: RunEvent) => void
  onRunQueued?: (event: RunEvent) => void
  onRunRejected?: (event: RunEvent) => void
  onApprovalRequested?: (event: RunEvent) => void
  onApprovalResolved?: (event: RunEvent) => void
  onPeerUserMessage?: (event: RunEvent) => void
  onClarifyRequested?: (event: RunEvent) => void
  onClarifyResolved?: (event: RunEvent) => void
  onAuthRequired?: (event: RunEvent) => void
  onWorkspaceDiffCompleted?: (event: RunEvent) => void
}>()
interface SessionHandlerOwner {
  dispose: () => void
  retire: () => void
}

const sessionHandlerOwners = new Map<string, SessionHandlerOwner>()

function retireAllSessionHandlerOwners(): void {
  for (const owner of [...sessionHandlerOwners.values()]) {
    try {
      owner.retire()
    } catch (error) {
      console.error('Failed to retire chat session owner:', error)
    }
  }
  sessionHandlerOwners.clear()
  sessionEventHandlers.clear()
  processingResumeEventIds.clear()
}

const peerUserMessageHandlers = new Set<(event: RunEvent) => void>()
const sessionCommandHandlers = new Set<(event: RunEvent) => void>()
const sessionTitleUpdatedHandlers = new Set<(event: RunEvent) => void>()
const authResolvedHandlers = new Set<(event: RunEvent) => void>()

/**
 * Global message.delta event handler
 * Distributes events to appropriate session based on session_id
 */
function globalMessageDeltaHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onMessageDelta) {
    handlers.onMessageDelta(event)
  }
}

/**
 * Global reasoning.delta event handler
 */
function globalReasoningDeltaHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onReasoningDelta) {
    handlers.onReasoningDelta(event)
  }
}

/**
 * Global thinking.delta event handler (alias for reasoning.delta)
 */
function globalThinkingDeltaHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onThinkingDelta) {
    handlers.onThinkingDelta(event)
  }
}

/**
 * Global reasoning.available event handler
 */
function globalReasoningAvailableHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onReasoningAvailable) {
    handlers.onReasoningAvailable(event)
  }
}

/**
 * Global tool.started event handler
 */
function globalToolStartedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onToolStarted) {
    handlers.onToolStarted(event)
  }
}

/**
 * Global tool.completed event handler
 */
function globalToolCompletedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onToolCompleted) {
    handlers.onToolCompleted(event)
  }
}

function globalSubagentEventHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onSubagentEvent) {
    handlers.onSubagentEvent(event)
  }
}

/**
 * Global run.started event handler
 */
function globalRunStartedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onRunStarted) {
    handlers.onRunStarted(event)
  }
}

/**
 * Global run.completed event handler
 */
function globalRunCompletedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onRunCompleted) {
    handlers.onRunCompleted(event)
  }

  // Auto-cleanup session handlers on completion (skip if more runs queued)
  if ((event as any).queue_remaining > 0) return
  if (sessionEventHandlers.get(sid) === handlers) unregisterSessionHandlers(sid)
}

/**
 * Global run.failed event handler
 */
function globalRunFailedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onRunFailed) {
    if (!consumeLiveResumeEvent(event, () => handlers.onRunFailed(event))) return
  }

  // Auto-cleanup session handlers on failure (skip if more runs queued)
  if ((event as any).queue_remaining > 0) return
  if (sessionEventHandlers.get(sid) === handlers) unregisterSessionHandlers(sid)
}

/**
 * Global run.queued event handler
 */
function globalRunQueuedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onRunQueued) {
    handlers.onRunQueued(event)
  }
}

function globalRunRejectedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return
  sessionEventHandlers.get(sid)?.onRunRejected?.(event)
}

/**
 * Global compression.started event handler
 */
function globalCompressionStartedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onCompressionStarted) {
    handlers.onCompressionStarted(event)
  }
}

/**
 * Global compression.completed event handler
 */
function globalCompressionCompletedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onCompressionCompleted) {
    handlers.onCompressionCompleted(event)
  }
}

/**
 * Global abort.started event handler
 */
function globalAbortStartedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onAbortStarted) {
    handlers.onAbortStarted(event)
  }
}

/**
 * Global abort.timeout event handler
 */
function globalAbortTimeoutHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onAbortTimeout) {
    handlers.onAbortTimeout(event)
  }
}

/**
 * Global abort.completed event handler
 */
function globalAbortCompletedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onAbortCompleted) {
    if (!consumeLiveResumeEvent(event, () => handlers.onAbortCompleted(event))) return
  }

  // If abort completion is followed by queued runs, keep the handler alive so
  // the next run.started/message.delta/run.completed events are still received.
  if (event.failure_pending) return
  if ((event as any).queue_length > 0) return
  if (sessionEventHandlers.get(sid) === handlers) unregisterSessionHandlers(sid)
}

/**
 * Global usage.updated event handler
 */
function globalUsageUpdatedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onUsageUpdated) {
    handlers.onUsageUpdated(event)
  }
}

function globalSessionCommandHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (!handlers?.onSessionCommand && sessionCommandHandlers.size === 0) return
  consumeLiveResumeEvent(event, () => {
    handlers?.onSessionCommand?.(event)
    for (const handler of sessionCommandHandlers) handler(event)
  })
}

function globalSessionTitleUpdatedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers) {
    handlers.onSessionTitleUpdated?.(event)
  }

  for (const handler of sessionTitleUpdatedHandlers) {
    handler(event)
  }
}

function globalAgentEventHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onAgentEvent) {
    handlers.onAgentEvent(event)
  }
}

function globalRunReattachFailedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onAgentEvent) {
    consumeLiveResumeEvent(event, () => handlers.onAgentEvent?.(event))
  }
}

function globalApprovalRequestedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onApprovalRequested) {
    handlers.onApprovalRequested(event)
  }
}

function globalApprovalResolvedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onApprovalResolved) {
    handlers.onApprovalResolved(event)
  }
}

function globalPeerUserMessageHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onPeerUserMessage) {
    handlers.onPeerUserMessage(event)
  }

  for (const handler of peerUserMessageHandlers) {
    handler(event)
  }
}

function globalClarifyRequestedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onClarifyRequested) {
    handlers.onClarifyRequested(event)
  }
}

function globalAuthRequiredHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onAuthRequired) {
    consumeLiveResumeEvent(event, () => handlers.onAuthRequired?.(event))
  }
}

function globalAuthResolvedHandler(event: RunEvent): void {
  if (!event.session_id || authResolvedHandlers.size === 0) return
  consumeLiveResumeEvent(event, () => {
    for (const handler of authResolvedHandlers) handler(event)
  })
}

function globalClarifyResolvedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onClarifyResolved) {
    handlers.onClarifyResolved(event)
  }
}

function globalWorkspaceDiffCompletedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onWorkspaceDiffCompleted) {
    handlers.onWorkspaceDiffCompleted(event)
  }
}

/**
 * Register event handlers for a session
 * @param sessionId - Session ID
 * @param handlers - Event handling functions
 * @returns Cleanup function to unregister handlers
 */
export function registerSessionHandlers(
  sessionId: string,
  handlers: {
    onMessageDelta: (event: RunEvent) => void
    onReasoningDelta: (event: RunEvent) => void
    onThinkingDelta: (event: RunEvent) => void
    onReasoningAvailable: (event: RunEvent) => void
    onToolStarted: (event: RunEvent) => void
    onToolCompleted: (event: RunEvent) => void
    onSubagentEvent?: (event: RunEvent) => void
    onRunStarted: (event: RunEvent) => void
    onRunCompleted: (event: RunEvent) => void
    onRunFailed: (event: RunEvent) => void
    onCompressionStarted: (event: RunEvent) => void
    onCompressionCompleted: (event: RunEvent) => void
    onAbortStarted: (event: RunEvent) => void
    onAbortTimeout?: (event: RunEvent) => void
    onAbortCompleted: (event: RunEvent) => void
    onUsageUpdated: (event: RunEvent) => void
    onAgentEvent?: (event: RunEvent) => void
    onSessionCommand?: (event: RunEvent) => void
    onSessionTitleUpdated?: (event: RunEvent) => void
    onRunQueued?: (event: RunEvent) => void
    onRunRejected?: (event: RunEvent) => void
    onApprovalRequested?: (event: RunEvent) => void
    onApprovalResolved?: (event: RunEvent) => void
    onPeerUserMessage?: (event: RunEvent) => void
    onClarifyRequested?: (event: RunEvent) => void
    onClarifyResolved?: (event: RunEvent) => void
    onAuthRequired?: (event: RunEvent) => void
    onWorkspaceDiffCompleted?: (event: RunEvent) => void
  },
  options?: {
    profile?: string | null
    transport?: ChatRunTransport
    onReconnectResume?: (data: ResumeSessionPayload) => ResumeEventConsumption | Promise<ResumeEventConsumption>
    onDone?: () => void
    onError?: (error: Error) => void
  },
): () => void {
  const ownerSocket = options ? connectChatRun(options.profile, options.transport) : null
  sessionHandlerOwners.get(sessionId)?.dispose()
  sessionHandlerOwners.delete(sessionId)
  sessionEventHandlers.set(sessionId, handlers)

  if (options && ownerSocket) {
    const socket = ownerSocket
    let disposed = false
    let sawTransientDisconnect = !socket.connected
    let resumedHandler: ((data: ResumeSessionPayload) => void) | null = null

    const clearResumedHandler = () => {
      if (!resumedHandler) return
      removeSocketListener(socket, 'resumed', resumedHandler)
      resumedHandler = null
    }
    const disposeOwner = () => {
      if (disposed) return
      disposed = true
      clearResumedHandler()
      removeSocketListener(socket, 'connect_error', handleConnectError)
      removeSocketListener(socket, 'disconnect', handleDisconnect)
      removeSocketListener(socket, 'connect', handleConnect)
    }
    const failOwner = (error: Error) => {
      if (disposed || sessionEventHandlers.get(sessionId) !== handlers) return
      unregisterSessionHandlers(sessionId)
      options.onError?.(error)
    }
    const handleConnectError = (error: Error) => {
      if (disposed || socket.active) return
      failOwner(error)
    }
    const handleDisconnect = (reason: string) => {
      if (disposed || reason === 'io client disconnect') return
      if (TRANSIENT_DISCONNECT_REASONS.has(reason)) {
        sawTransientDisconnect = true
        return
      }
      failOwner(new Error(`Socket disconnected: ${reason}`))
    }
    const handleConnect = () => {
      if (disposed || !sawTransientDisconnect || sessionEventHandlers.get(sessionId) !== handlers) return
      sawTransientDisconnect = false
      clearResumedHandler()
      resumedHandler = async (data: ResumeSessionPayload) => {
        if (disposed || data.session_id !== sessionId || sessionEventHandlers.get(sessionId) !== handlers) return
        clearResumedHandler()
        const prepared = options.onReconnectResume
          ? prepareResumeEvents(socket, sessionId, data)
          : { data, reservedIds: [] }
        let consumed: ResumeEventConsumption
        try {
          consumed = await options.onReconnectResume?.(prepared.data)
        } catch (error) {
          settlePreparedResumeEvents(socket, sessionId, prepared, false)
          failOwner(error instanceof Error ? error : new Error(String(error)))
          return
        }
        const stillOwner = !disposed && sessionEventHandlers.get(sessionId) === handlers
        settlePreparedResumeEvents(socket, sessionId, prepared, consumed)
        if (!stillOwner || prepared.data.isWorking || (prepared.data.queueLength && prepared.data.queueLength > 0)) return
        unregisterSessionHandlers(sessionId)
        options.onDone?.()
      }
      socket.on('resumed', resumedHandler)
      socket.emit('resume', {
        session_id: sessionId,
        ...(options.profile ? { profile: options.profile } : {}),
      })
    }

    socket.on('connect_error', handleConnectError)
    socket.on('disconnect', handleDisconnect)
    socket.on('connect', handleConnect)
    sessionHandlerOwners.set(sessionId, {
      dispose: disposeOwner,
      retire: () => failOwner(new Error('Chat connection changed before the run finished')),
    })
  }

  // Return cleanup function
  return () => {
    if (sessionEventHandlers.get(sessionId) === handlers) unregisterSessionHandlers(sessionId)
  }
}

/**
 * Unregister event handlers for a session
 * @param sessionId - Session ID
 */
export function unregisterSessionHandlers(sessionId: string): void {
  const owner = sessionHandlerOwners.get(sessionId)
  sessionHandlerOwners.delete(sessionId)
  owner?.dispose()
  sessionEventHandlers.delete(sessionId)
}

export function onPeerUserMessage(handler: (event: RunEvent) => void): () => void {
  peerUserMessageHandlers.add(handler)
  return () => {
    peerUserMessageHandlers.delete(handler)
  }
}

export function onSessionCommand(handler: (event: RunEvent) => void): () => void {
  sessionCommandHandlers.add(handler)
  return () => {
    sessionCommandHandlers.delete(handler)
  }
}

export function onSessionTitleUpdated(handler: (event: RunEvent) => void): () => void {
  sessionTitleUpdatedHandlers.add(handler)
  return () => {
    sessionTitleUpdatedHandlers.delete(handler)
  }
}

export function onAuthResolved(handler: (event: RunEvent) => void): () => void {
  authResolvedHandlers.add(handler)
  return () => {
    authResolvedHandlers.delete(handler)
  }
}

export function respondClarify(
  sessionId: string,
  clarifyId: string,
  response: string,
  transport: ChatRunTransport = 'chat-run',
): void {
  const socket = connectChatRun(null, transport)
  socket.emit('clarify.respond', {
    session_id: sessionId,
    clarify_id: clarifyId,
    response,
  })
}

export function respondToolApproval(
  sessionId: string,
  approvalId: string,
  choice: 'once' | 'session' | 'always' | 'deny',
  transport: ChatRunTransport = 'chat-run',
): void {
  const socket = connectChatRun(null, transport)
  socket.emit('approval.respond', {
    session_id: sessionId,
    approval_id: approvalId,
    choice,
  })
}

export function getChatRunSocket(transport?: ChatRunTransport): Socket | null {
  if (transport && chatRunSocketTransport !== transport) return null
  return chatRunSocket
}

function readLocalStorageItem(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function'
      ? localStorage.getItem(key)
      : null
  } catch {
    return null
  }
}

export function connectChatRun(requestedProfile?: string | null, transport: ChatRunTransport = 'chat-run'): Socket {
  const normalizedRequestedProfile = requestedProfile?.trim() || null
  const activeAgentId = readLocalStorageItem('hermes_active_agent_id')?.trim() || null

  // Resolve the implicit profile before deciding whether the current socket is
  // reusable. The active profile can change while callers continue to omit the
  // optional profile argument.
  let profile = normalizedRequestedProfile || 'default'
  if (!normalizedRequestedProfile) {
    try {
      const profilesStore = useProfilesStore()
      profile = String(profilesStore.activeProfileName || '').trim() || 'default'
    } catch {
      profile = readLocalStorageItem('hermes_active_profile_name')?.trim() || 'default'
    }
  }
  if (
    chatRunSocket &&
    (chatRunSocket.connected || chatRunSocket.active) &&
    chatRunSocketTransport === transport &&
    chatRunSocketProfile === profile &&
    chatRunSocketAgentId === activeAgentId
  ) {
    return chatRunSocket
  }

  // Clean up old socket to prevent duplicate event listeners
  if (chatRunSocket) {
    retireAllSessionHandlerOwners()
    chatRunSocket.removeAllListeners()
    chatRunSocket.disconnect()
    globalListenersRegistered = false
    chatRunSocketProfile = null
    chatRunSocketAgentId = null
  }

  const baseUrl = getBaseUrlValue()
  const token = getApiKey()
  chatRunSocketProfile = profile
  chatRunSocketAgentId = activeAgentId
  chatRunSocketTransport = transport

  const namespace = transport === 'global-agent' ? '/global-agent' : '/chat-run'
  const query: Record<string, string> = { profile }
  if (activeAgentId) query.agent_id = activeAgentId
  chatRunSocket = io(`${baseUrl}${namespace}`, {
    auth: { token },
    query,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    randomizationFactor: 0.5,
    timeout: 30000,
  })

  // Register global listeners only once per socket connection
  if (!globalListenersRegistered) {
    // Message events
    chatRunSocket.on('message.delta', globalMessageDeltaHandler)
    chatRunSocket.on('reasoning.delta', globalReasoningDeltaHandler)
    chatRunSocket.on('thinking.delta', globalThinkingDeltaHandler)
    chatRunSocket.on('reasoning.available', globalReasoningAvailableHandler)

    // Tool events
    chatRunSocket.on('tool.started', globalToolStartedHandler)
    chatRunSocket.on('tool.completed', globalToolCompletedHandler)
    chatRunSocket.on('subagent.start', globalSubagentEventHandler)
    chatRunSocket.on('subagent.tool', globalSubagentEventHandler)
    chatRunSocket.on('subagent.progress', globalSubagentEventHandler)
    chatRunSocket.on('subagent.complete', globalSubagentEventHandler)

    // Run lifecycle events
    chatRunSocket.on('run.started', globalRunStartedHandler)
    chatRunSocket.on('run.failed', globalRunFailedHandler)
    chatRunSocket.on('run.completed', globalRunCompletedHandler)
    chatRunSocket.on('run.queued', globalRunQueuedHandler)
    chatRunSocket.on('run.rejected', globalRunRejectedHandler)
    chatRunSocket.on('approval.requested', globalApprovalRequestedHandler)
    chatRunSocket.on('approval.resolved', globalApprovalResolvedHandler)
    chatRunSocket.on('run.peer_user_message', globalPeerUserMessageHandler)
    chatRunSocket.on('clarify.requested', globalClarifyRequestedHandler)
    chatRunSocket.on('auth.required', globalAuthRequiredHandler)
    chatRunSocket.on('auth.resolved', globalAuthResolvedHandler)
    chatRunSocket.on('clarify.resolved', globalClarifyResolvedHandler)

    // Compression events
    chatRunSocket.on('compression.started', globalCompressionStartedHandler)
    chatRunSocket.on('compression.completed', globalCompressionCompletedHandler)
    chatRunSocket.on('abort.started', globalAbortStartedHandler)
    chatRunSocket.on('abort.timeout', globalAbortTimeoutHandler)
    chatRunSocket.on('abort.completed', globalAbortCompletedHandler)

    // Usage events
    chatRunSocket.on('usage.updated', globalUsageUpdatedHandler)
    chatRunSocket.on('agent.event', globalAgentEventHandler)
    chatRunSocket.on('run.reattach_failed', globalRunReattachFailedHandler)
    chatRunSocket.on('session.command', globalSessionCommandHandler)
    chatRunSocket.on('session.title.updated', globalSessionTitleUpdatedHandler)
    chatRunSocket.on('workspace.diff.completed', globalWorkspaceDiffCompletedHandler)

    globalListenersRegistered = true
  }

  return chatRunSocket
}

export function disconnectChatRun(): void {
  retireAllSessionHandlerOwners()
  if (chatRunSocket) {
    chatRunSocket.disconnect()
    chatRunSocket = null
    chatRunSocketProfile = null
    chatRunSocketAgentId = null
    chatRunSocketTransport = 'chat-run'
    globalListenersRegistered = false
  }
}

function removeSocketListener(socket: Socket, event: string, handler: (...args: any[]) => void): void {
  const candidate = socket as Socket & {
    off?: (event: string, handler: (...args: any[]) => void) => Socket
    removeListener?: (event: string, handler: (...args: any[]) => void) => Socket
  }
  if (typeof candidate.off === 'function') {
    candidate.off(event, handler)
    return
  }
  candidate.removeListener?.(event, handler)
}

function rememberConsumedResumeEventIds(eventIds: string[]): void {
  for (const eventId of eventIds) consumedResumeEventIds.add(eventId)
  while (consumedResumeEventIds.size > MAX_CONSUMED_RESUME_EVENT_IDS) {
    const oldest = consumedResumeEventIds.values().next().value
    if (oldest === undefined) break
    consumedResumeEventIds.delete(oldest)
  }
}

function consumeLiveResumeEvent(event: RunEvent, consume: () => void): boolean {
  const eventId = String(event.resume_event_id || '').trim()
  const sessionId = String(event.session_id || '').trim()
  if (!eventId || !sessionId) {
    consume()
    return true
  }
  if (consumedResumeEventIds.has(eventId) || processingResumeEventIds.has(eventId)) return false
  const socket = chatRunSocket
  processingResumeEventIds.add(eventId)
  try {
    consume()
  } catch (error) {
    processingResumeEventIds.delete(eventId)
    throw error
  }
  processingResumeEventIds.delete(eventId)
  rememberConsumedResumeEventIds([eventId])
  socket?.emit('resume.events.ack', { session_id: sessionId, event_ids: [eventId] })
  return true
}

interface PreparedResumeEvents {
  data: ResumeSessionPayload
  reservedIds: string[]
}

function prepareResumeEvents(socket: Socket, sessionId: string, data: ResumeSessionPayload): PreparedResumeEvents {
  const alreadyConsumed: string[] = []
  const reservedIds: string[] = []
  const events = (data.events || []).filter((event) => {
    if (!event.id) return true
    if (consumedResumeEventIds.has(event.id)) {
      alreadyConsumed.push(event.id)
      return false
    }
    if (processingResumeEventIds.has(event.id)) return false
    processingResumeEventIds.add(event.id)
    reservedIds.push(event.id)
    return true
  })
  if (alreadyConsumed.length > 0) {
    socket.emit('resume.events.ack', { session_id: sessionId, event_ids: [...new Set(alreadyConsumed)] })
  }
  return {
    data: events.length === data.events?.length ? data : { ...data, events },
    reservedIds,
  }
}

function settlePreparedResumeEvents(
  socket: Socket,
  sessionId: string,
  prepared: PreparedResumeEvents,
  consumed: ResumeEventConsumption,
): void {
  const requestedIds = consumed === true
    ? prepared.reservedIds
    : Array.isArray(consumed)
      ? consumed
      : []
  const reservedIds = new Set(prepared.reservedIds)
  const acknowledgedIds = [...new Set(requestedIds.filter(eventId => reservedIds.has(eventId)))]
  for (const eventId of prepared.reservedIds) processingResumeEventIds.delete(eventId)
  if (acknowledgedIds.length === 0) return
  rememberConsumedResumeEventIds(acknowledgedIds)
  socket.emit('resume.events.ack', { session_id: sessionId, event_ids: acknowledgedIds })
}

/**
 * Start a chat run via Socket.IO and stream events back.
 * Returns an AbortController-compatible handle for cancellation.
 */
/**
 * Resume a session via Socket.IO. Returns messages, working status, and events.
 */
export function resumeSession(
  sessionId: string,
  onResumed: (data: ResumeSessionPayload) => ResumeEventConsumption | Promise<ResumeEventConsumption>,
  profile?: string | null,
  transport: ChatRunTransport = 'chat-run',
): Socket {
  const socket = connectChatRun(profile, transport)

  const handleResumed = (data: ResumeSessionPayload) => {
    if (data?.session_id !== sessionId) return
    removeSocketListener(socket, 'resumed', handleResumed)
    const prepared = prepareResumeEvents(socket, sessionId, data)
    void Promise.resolve(onResumed(prepared.data))
      .then((consumed) => {
        settlePreparedResumeEvents(socket, sessionId, prepared, consumed)
      })
      .catch((err) => {
        settlePreparedResumeEvents(socket, sessionId, prepared, false)
        console.error('Failed to apply resumed session:', err)
      })
  }
  socket.on('resumed', handleResumed)
  socket.emit('resume', { session_id: sessionId, ...(profile ? { profile } : {}) })

  return socket
}

export function startRunViaSocket(
  body: StartRunRequest,
  onEvent: (event: RunEvent) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  onStarted?: (runId: string) => void,
  options?: {
    onReconnectResume?: (data: ResumeSessionPayload) => ResumeEventConsumption | Promise<ResumeEventConsumption>
    transport?: ChatRunTransport
  },
): { abort: () => void } {
  const sid = body.session_id
  if (!sid) {
    throw new Error('session_id is required for startRunViaSocket')
  }

  let closed = false
  const socket = connectChatRun(body.profile, options?.transport)
  if (sessionEventHandlers.has(sid)) {
    socket.emit('run', body)
    return {
      abort: () => {
        if (!closed) {
          socket.emit('abort', { session_id: sid })
        }
      },
    }
  }

  let sawTransientDisconnect = false
  let removeTerminalSocketListeners: () => void = () => {}
  let reconnectResumeHandler: ((data: ResumeSessionPayload) => void) | null = null

  const clearReconnectResumeHandler = () => {
    if (!reconnectResumeHandler) return
    removeSocketListener(socket, 'resumed', reconnectResumeHandler)
    reconnectResumeHandler = null
  }

  const emitReconnectResume = () => {
    clearReconnectResumeHandler()
    reconnectResumeHandler = async (data: ResumeSessionPayload) => {
      if (closed || data.session_id !== sid) return
      clearReconnectResumeHandler()
      const onReconnectResume = options?.onReconnectResume
      const prepared = onReconnectResume
        ? prepareResumeEvents(socket, sid, data)
        : { data, reservedIds: [] }
      if (onReconnectResume) {
        let consumed: ResumeEventConsumption
        try {
          consumed = await onReconnectResume(prepared.data)
        } catch (err) {
          settlePreparedResumeEvents(socket, sid, prepared, false)
          handleSocketError(err instanceof Error ? err : new Error(String(err)))
          return
        }
        const stillOwner = !closed && sessionEventHandlers.get(sid) === handlers
        settlePreparedResumeEvents(socket, sid, prepared, consumed)
        if (!stillOwner) return
      }
      if (prepared.data.isWorking || (prepared.data.queueLength && prepared.data.queueLength > 0)) return
      closed = true
      removeTerminalSocketListeners()
      if (sessionEventHandlers.get(sid) === handlers) unregisterSessionHandlers(sid)
      onDone()
    }
    socket.on('resumed', reconnectResumeHandler)
    socket.emit('resume', { session_id: sid, ...(body.profile ? { profile: body.profile } : {}) })
  }

  const handleSocketError = (err: Error) => {
    if (closed) return
    closed = true
    removeTerminalSocketListeners()
    if (sessionEventHandlers.get(sid) === handlers) unregisterSessionHandlers(sid)
    onError(err)
  }
  const handleSocketConnectError = (err: Error) => {
    if (closed || socket.active) return
    handleSocketError(err)
  }
  socket.on('connect_error', handleSocketConnectError)
  const handleSocketDisconnect = (reason: string) => {
    if (closed || reason === 'io client disconnect') return
    if (TRANSIENT_DISCONNECT_REASONS.has(reason)) {
      sawTransientDisconnect = true
      return
    }
    handleSocketError(new Error(`Socket disconnected: ${reason}`))
  }
  socket.on('disconnect', handleSocketDisconnect)

  const handleSocketReconnect = () => {
    if (closed || !sawTransientDisconnect) return
    sawTransientDisconnect = false
    emitReconnectResume()
  }
  socket.on('connect', handleSocketReconnect)

  removeTerminalSocketListeners = () => {
    clearReconnectResumeHandler()
    removeSocketListener(socket, 'connect_error', handleSocketConnectError)
    removeSocketListener(socket, 'disconnect', handleSocketDisconnect)
    removeSocketListener(socket, 'connect', handleSocketReconnect)
  }

  // Define event handlers for this session
  const handlers = {
    onMessageDelta: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onReasoningDelta: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onThinkingDelta: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onReasoningAvailable: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onToolStarted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onToolCompleted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onSubagentEvent: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onRunStarted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
      onStarted?.(evt.run_id || '')
    },
    onRunCompleted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
      if ((evt as any).queue_remaining > 0) return
      closed = true
      removeTerminalSocketListeners()
      onDone()
    },
    onRunFailed: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
      if ((evt as any).queue_remaining > 0) return
      closed = true
      removeTerminalSocketListeners()
      onDone()
    },
    onCompressionStarted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onCompressionCompleted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onAbortStarted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onAbortTimeout: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onAbortCompleted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
      if (evt.failure_pending) return
      if ((evt as any).queue_length > 0) return
      closed = true
      removeTerminalSocketListeners()
      onDone()
    },
    onUsageUpdated: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onAgentEvent: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onSessionCommand: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
      if ((evt as any).terminal === false) return
      closed = true
      removeTerminalSocketListeners()
      if (sessionEventHandlers.get(sid) === handlers) unregisterSessionHandlers(sid)
      onDone()
    },
    onSessionTitleUpdated: (evt: RunEvent) => {
      onEvent(evt)
    },
    onRunQueued: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onRunRejected: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
      if (evt.queue_id !== body.queue_id) return
      closed = true
      removeTerminalSocketListeners()
      if (sessionEventHandlers.get(sid) === handlers) unregisterSessionHandlers(sid)
      onDone()
    },
    onApprovalRequested: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onApprovalResolved: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onClarifyRequested: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onClarifyResolved: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onAuthRequired: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onWorkspaceDiffCompleted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
  }

  // Register handlers in the global session map
  sessionEventHandlers.set(sid, handlers)
  sessionHandlerOwners.set(sid, {
    dispose: () => {
      closed = true
      removeTerminalSocketListeners()
    },
    retire: () => handleSocketError(new Error('Chat connection changed before the run finished')),
  })

  // Emit run request
  socket.emit('run', body)

  return {
    abort: () => {
      if (!closed) {
        socket.emit('abort', { session_id: sid })
      }
    },
  }
}
