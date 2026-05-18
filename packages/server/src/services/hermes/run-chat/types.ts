export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; name: string; path: string; media_type: string }
  | { type: 'file'; name: string; path: string; media_type?: string }

export interface SessionMessage {
  id: number | string
  session_id: string
  role: string
  content: string
  runMarker?: string
  tool_call_id?: string | null
  tool_calls?: any[] | null
  tool_name?: string | null
  timestamp: number
  token_count?: number | null
  finish_reason?: string | null
  reasoning?: string | null
  reasoning_details?: string | null
  reasoning_content?: string | null
}

export interface QueuedRun {
  queue_id: string
  input: string | ContentBlock[]
  model?: string
  provider?: string
  instructions?: string
  profile: string
}

export interface ResponseRunState {
  runMarker?: string
  responseId?: string
  insertedKeys: Set<string>
  toolCalls: Map<string, any>
}

export interface SessionState {
  messages: SessionMessage[]
  isWorking: boolean
  events: Array<{ event: string; data: any }>
  abortController?: AbortController
  runId?: string
  profile?: string
  inputTokens?: number
  outputTokens?: number
  isAborting?: boolean
  queue: QueuedRun[]
  responseRun?: ResponseRunState
}
