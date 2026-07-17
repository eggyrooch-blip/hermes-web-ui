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
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { extname, isAbsolute, resolve } from 'path'
import { inflateRawSync } from 'zlib'
import { getSystemPrompt } from '../../lib/llm-prompt'
import {
  getSession,
  getSessionDetail,
  addMessage,
  updateSession,
  updateSessionStats,
} from '../../db/hermes/session-store'
import { getSessionDetailFromDb, getSessionDetailFromDbWithProfile } from '../../db/hermes/sessions-db'
import { getModelContextLength } from './model-context'
import { ChatContextCompressor, countTokens, SUMMARY_PREFIX } from '../../lib/context-compressor'
import { getCompressionSnapshot } from '../../db/hermes/compression-snapshot'
import { parseAnthropicContentArray } from '../../lib/llm-json'
import { updateUsage } from '../../db/hermes/usage-store'
import { logger } from '../logger'
import { config } from '../../config'
import { getProfileDir } from './hermes-profile'
import {
  extractFeishuSessionFromCookieHeader,
  getFeishuSessionSecret,
  parseFeishuSessionCookie,
} from '../feishu-oauth'
import { ownerOwnsProfile, resolveOwnedProfileAgentId } from './agent-ownership'
import { ensureWebUserForFeishu } from '../compat-user'
import { authenticateUserToken, isAuthEnabled } from '../../middleware/user-auth'
import { userCanAccessProfile } from '../../db/hermes/users-store'
import {
  handleBrokerRun as handleRunChatBrokerRun,
  parseBrokerSessionCommand,
  respondToBrokerClarify,
  runBrokerGoalEvaluate,
  runBrokerSessionCommand,
  type BrokerGoalEvaluateResult,
  type BrokerSessionCommandResult,
} from './run-chat/handle-broker-run'
import { extractResponseText, responseFunctionCallToToolCall, summarizeToolArguments } from './run-chat/response-utils'
import { readSseFrames } from './run-chat/sse-utils'
import type { ChatRunSource } from './run-chat/types'
import { rewriteAssistantMediaDirectives } from './media-directives'
import {
  bindSessionGeneration,
  createSessionAndBind,
  loadSessionStateWithGenerationFence,
  readSessionGeneration,
  sessionGenerationsEqual,
  stateMatchesSessionGeneration,
} from './run-chat/session-generation'

/**
 * Content block types for Anthropic-compatible message format
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; name: string; path: string; media_type: string }
  | { type: 'file'; name: string; path: string; media_type?: string }

/**
 * Convert ContentBlock[] to string for display/storage
 * - string → 直接返回
 * - ContentBlock[] → 返回 JSON 字符串
 */
function contentBlocksToString(input: string | ContentBlock[]): string {
  if (typeof input === 'string') return input
  return JSON.stringify(input)
}

/**
 * Extract text content from ContentBlock[] for title preview
 */
function extractTextForPreview(input: string | ContentBlock[]): string {
  if (typeof input === 'string') return input

  return input
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * Check if input is ContentBlock array
 */
function isContentBlockArray(input: any): input is ContentBlock[] {
  return Array.isArray(input) && input.length > 0 && ('type' in input[0])
}

const USE_CLIENT_SUPPLIED_HISTORY = process.env.HERMES_WEBUI_CLIENT_HISTORY === '1'
const TEXT_FILE_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml',
  '.xml', '.html', '.css', '.js', '.ts', '.tsx', '.jsx', '.py', '.sh', '.log',
])
const SPREADSHEET_FILE_EXTENSIONS = new Set(['.xlsx'])
const MAX_INLINE_FILE_CHARS = 200_000

async function resolveAccessibleSocketAgentProfile(openid: string, agentId: string, requestedProfile: string): Promise<string | null> {
  const actor = openid.trim()
  const requestedAgentId = agentId.trim()
  if (!actor || !requestedAgentId) return null

  if (requestedProfile && ownerOwnsProfile(actor, requestedProfile)) {
    const ownedAgentId = resolveOwnedProfileAgentId(actor, requestedProfile)
    if (ownedAgentId === requestedAgentId) return requestedProfile
  }

  if (!config.runBrokerUrl) return null
  const headers: Record<string, string> = {
    'X-Hermes-Owner-Open-Id': actor,
  }
  if (config.runBrokerKey) headers.Authorization = `Bearer ${config.runBrokerKey}`
  const res = await fetch(`${config.runBrokerUrl}/api/run-broker/agents/shared`, { method: 'GET', headers })
  if (!res.ok) return null
  const body = await res.json().catch(() => null) as any
  const agents = Array.isArray(body?.agents) ? body.agents : []
  const shared = agents.find((agent: any) => String(agent?.agent_id || '').trim() === requestedAgentId)
  if (!shared) return null
  const profileName = String(shared.profile_name || '').trim()
  if (requestedProfile && profileName && requestedProfile !== profileName) return null
  return profileName || requestedProfile || null
}

function resolveUploadedPath(profile: string, filePath: string): string | null {
  if (!filePath) return null
  const workspaceRoot = resolve(getProfileDir(profile), 'workspace')
  if (isAbsolute(filePath)) {
    const absolutePath = resolve(filePath)
    const uploadRoot = resolve(config.uploadDir)
    const allowedRoots = [workspaceRoot, uploadRoot]
    return allowedRoots.some(root => absolutePath === root || absolutePath.startsWith(`${root}/`))
      ? absolutePath
      : null
  }
  const candidate = resolve(workspaceRoot, filePath)
  if (candidate !== workspaceRoot && !candidate.startsWith(`${workspaceRoot}/`)) return null
  return candidate
}

function shouldInlineFile(block: ContentBlock): boolean {
  if (block.type !== 'file') return false
  const media = (block.media_type || '').toLowerCase()
  if (media.startsWith('text/')) return true
  const extension = extname(block.name || block.path).toLowerCase()
  return TEXT_FILE_EXTENSIONS.has(extension) || SPREADSHEET_FILE_EXTENSIONS.has(extension)
}

async function readInlineFileBlock(profile: string, block: ContentBlock): Promise<string> {
  if (block.type !== 'file') return ''
  const resolvedPath = resolveUploadedPath(profile, block.path)
  if (!resolvedPath || !existsSync(resolvedPath)) {
    return `[File: ${block.name || block.path}]`
  }
  // Non-inlineable files (zip / pdf / binary): we can't dump the bytes into the
  // prompt, but the file already lives in this agent's own workspace. Hand the
  // agent the real path (absolute + relative) so it can read/unzip it with a
  // tool, instead of a pathless `[File: name]` it has no way to locate.
  if (!shouldInlineFile(block)) {
    const name = block.name || block.path
    return `\n\n[附件「${name}」已保存在你的工作目录：${resolvedPath}（相对路径：${block.path}）。请直接用工具读取/解压它，不要让用户粘贴内容。]`
  }
  const extension = extname(block.name || block.path).toLowerCase()
  const content = SPREADSHEET_FILE_EXTENSIONS.has(extension)
    ? extractXlsxText(await readFile(resolvedPath))
    : await readFile(resolvedPath, 'utf-8')
  if (!content) return `[File: ${block.name || block.path}]`
  const trimmed = content.length > MAX_INLINE_FILE_CHARS
    ? `${content.slice(0, MAX_INLINE_FILE_CHARS)}\n\n[File truncated at ${MAX_INLINE_FILE_CHARS} characters]`
    : content
  return `\n\n[File: ${block.name || block.path}]\n${trimmed}`
}

function extractXlsxText(file: Buffer): string {
  const entries = unzipEntries(file)
  const sharedStrings = parseSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf-8') || '')
  const lines: string[] = []
  const sheets = [...entries.keys()]
    .filter(name => name.startsWith('xl/worksheets/') && name.endsWith('.xml'))
    .sort()
    .slice(0, 3)

  for (const sheet of sheets) {
    const xml = entries.get(sheet)?.toString('utf-8') || ''
    const rows: string[] = []
    for (const rowMatch of xml.matchAll(/<row\b[\s\S]*?<\/row>/g)) {
      if (rows.length >= 50) break
      const rowXml = rowMatch[0]
      const values: string[] = []
      for (const cellMatch of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        if (values.length >= 20) break
        values.push(parseXlsxCell(cellMatch[1], cellMatch[2], sharedStrings))
      }
      while (values.length > 0 && values[values.length - 1] === '') values.pop()
      if (values.length > 0) rows.push(values.join('\t'))
    }
    if (rows.length > 0) {
      lines.push(`[${sheet.split('/').pop()?.replace(/\.xml$/, '') || 'sheet'}]`)
      lines.push(...rows)
    }
  }
  return lines.join('\n')
}

function unzipEntries(file: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>()
  const eocdOffset = findZipEndOfCentralDirectory(file)
  if (eocdOffset < 0) return entries
  const centralDirectorySize = file.readUInt32LE(eocdOffset + 12)
  const centralDirectoryOffset = file.readUInt32LE(eocdOffset + 16)
  let offset = centralDirectoryOffset
  const end = centralDirectoryOffset + centralDirectorySize
  while (offset < end && file.readUInt32LE(offset) === 0x02014b50) {
    const method = file.readUInt16LE(offset + 10)
    const compressedSize = file.readUInt32LE(offset + 20)
    const nameLength = file.readUInt16LE(offset + 28)
    const extraLength = file.readUInt16LE(offset + 30)
    const commentLength = file.readUInt16LE(offset + 32)
    const localHeaderOffset = file.readUInt32LE(offset + 42)
    const name = file.subarray(offset + 46, offset + 46 + nameLength).toString('utf-8')
    const localNameLength = file.readUInt16LE(localHeaderOffset + 26)
    const localExtraLength = file.readUInt16LE(localHeaderOffset + 28)
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength
    const compressed = file.subarray(dataStart, dataStart + compressedSize)
    if (method === 0) entries.set(name, compressed)
    if (method === 8) entries.set(name, inflateRawSync(compressed))
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function findZipEndOfCentralDirectory(file: Buffer): number {
  for (let offset = file.length - 22; offset >= 0; offset -= 1) {
    if (file.readUInt32LE(offset) === 0x06054b50) return offset
  }
  return -1
}

function parseSharedStrings(xml: string): string[] {
  if (!xml) return []
  return [...xml.matchAll(/<si\b[\s\S]*?<\/si>/g)]
    .map(match => [...match[0].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map(text => decodeXmlText(text[1]))
      .join(''))
}

function parseXlsxCell(attributes: string, body: string, sharedStrings: string[]): string {
  const type = /\bt="([^"]+)"/.exec(attributes)?.[1] || ''
  if (type === 'inlineStr') {
    return [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map(text => decodeXmlText(text[1]))
      .join('')
  }
  const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] || ''
  if (type === 's') {
    const index = Number(value)
    return Number.isInteger(index) && index >= 0 && index < sharedStrings.length ? sharedStrings[index] : ''
  }
  return decodeXmlText(value)
}

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

export async function buildResponsesInput(input: string | ContentBlock[], profile: string): Promise<any> {
  if (!isContentBlockArray(input)) return input

  const hasImage = input.some(block => block.type === 'image')
  if (!hasImage) {
    const parts: string[] = []
    for (const block of input) {
      if (block.type === 'text') parts.push(block.text)
      if (block.type === 'file') parts.push(await readInlineFileBlock(profile, block))
    }
    return parts.filter(Boolean).join('\n')
  }

  const parts = await convertContentBlocks(input, profile)
  return [{ role: 'user', content: parts }]
}

/**
 * Convert ContentBlock[] to multimodal format for /v1/responses API.
 *
 * - text → { type: "input_text", text }
 * - image → { type: "input_image", image_url: "data:image/...;base64,..." }
 * - file → text mention [File: name]
 */
async function convertContentBlocks(blocks: ContentBlock[], profile: string): Promise<Array<{ type: string; text?: string; image_url?: string }>> {
  const parts: Array<{ type: string; text?: string; image_url?: string }> = []
  const fs = await import('fs/promises')
  const path = await import('path')

  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'input_text', text: block.text })
    } else if (block.type === 'image') {
      try {
        const resolvedPath = resolveUploadedPath(profile, block.path)
        if (!resolvedPath) throw new Error('image path is outside allowed upload roots')
        const buf = await fs.readFile(resolvedPath)
        const ext = path.extname(resolvedPath).toLowerCase().replace('.', '')
        const mime = ext === 'jpg' ? 'jpeg' : ext || 'png'
        const base64 = buf.toString('base64')
        parts.push({ type: 'input_image', image_url: `data:image/${mime};base64,${base64}` })
      } catch {
        parts.push({ type: 'input_text', text: `[Image: ${block.path}]` })
      }
    } else if (block.type === 'file') {
      parts.push({ type: 'input_text', text: await readInlineFileBlock(profile, block) })
    }
  }

  return parts
}

const compressor = new ChatContextCompressor()

// --- Helper: Convert OpenAI format to Anthropic format ---
function convertHistoryFormat(messages: any[]): any[] {
  const result: any[] = []

  for (const m of messages) {
    const role = m.role
    const content = m.content || ''
    delete m.reasoning_content
    if (role === 'tool') {
      // Convert tool message to tool_result in user message
      // Follow Hermes official format: content is a string (not array)
      let pushItem = { ...m }
      pushItem.role = 'user'
      pushItem.content = `[Tool result: ${content}]`
      result.push(pushItem)
      continue
    }

    // Regular user message
    if (role === 'user') {
      // Format: { role: 'user', content: [{ type: 'text', text: '...' }] }
      if (typeof content === 'string') {
        result.push({ role: 'user', content: content })
      } else if (Array.isArray(content)) {
        // Extract text from content blocks for history
        const textParts = content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n')
        result.push({ role: 'user', content: textParts || JSON.stringify(content) })
      }
      continue
    }
    if (role === 'assistant') {
      result.push({ ...m })
      continue
    }
  }
  return result
}

// --- Session state tracking ---

interface SessionMessage {
  id: number | string
  session_id: string
  role: string
  content: string
  runMarker?: string
  run_id?: string | null
  client_id?: string | null
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

interface QueuedRun {
  queue_id: string
  input: string | ContentBlock[]
  source?: ChatRunSource
  model?: string
  provider?: string
  workspace?: string | null
  instructions?: string
  expert_id?: string
  expert_label?: string
  expert_avatar?: string
  goalContinuation?: boolean
  profile: string
}

interface SessionState {
  messages: SessionMessage[]
  isWorking: boolean
  events: Array<{ event: string; data: any }>
  abortController?: AbortController
  goalEvaluationAbortController?: AbortController
  runId?: string
  activeRunMarker?: string
  sessionRowId?: number | null
  sessionIncarnation?: number | null
  profile?: string
  inputTokens?: number
  outputTokens?: number
  isAborting?: boolean
  queue: QueuedRun[]
  responseRun?: ResponseRunState
}

interface ResponseRunState {
  runMarker?: string
  responseId?: string
  insertedKeys: Set<string>
  toolCalls: Map<string, any>
}

function buildBrokerMessagesForSession(messages: SessionMessage[]): Array<Record<string, any>> {
  const brokerMessages: Array<Record<string, any>> = []
  for (const message of messages) {
    const role = message.role
    const content = typeof message.content === 'string' ? message.content : String(message.content || '')
    if (role === 'user') {
      if (content.trim()) brokerMessages.push({ role: 'user', content })
      continue
    }
    if (role === 'assistant') {
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      if (content.trim()) {
        brokerMessages.push({ role: 'assistant', content })
      } else if (toolCalls.length) {
        brokerMessages.push({ role: 'assistant', content: '', tool_calls: toolCalls })
      }
      continue
    }
    if (role === 'tool' && content.trim()) {
      brokerMessages.push({
        role: 'user',
        content: `[Tool result: ${content}]`,
      })
    }
  }
  return brokerMessages
}

function brokerToolIdPart(value: unknown, fallback: string): string {
  const text = String(value ?? fallback).trim()
  return (text || fallback).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || fallback
}

function brokerToolCallId(parsed: any, payload: any, runId: unknown, toolName: unknown): string {
  const explicit = parsed?.tool_call_id || payload.tool_call_id || parsed?.call_id || payload.call_id
  if (explicit) return String(explicit)
  const index = parsed?.index ?? payload.index ?? parsed?.tool_index ?? payload.tool_index
  const suffix = index != null ? `_${brokerToolIdPart(index, '0')}` : ''
  return `broker_tool_${brokerToolIdPart(runId, 'run')}_${brokerToolIdPart(toolName, 'tool')}${suffix}`
}

type RunBrokerChatFrameMapping =
  | {
      type: 'emit'
      event: string
      payload: any
      appendFinalText: boolean
      persistAssistantContent: boolean
    }
  | { type: 'terminal'; event: 'run.completed' | 'run.failed'; payload: any }
  | { type: 'ignore' }

export function mapRunBrokerFrameForChat(parsed: any, frameEvent?: string): RunBrokerChatFrameMapping {
  const payload = parsed?.payload || {}
  const brokerKind = parsed?.kind || parsed?.event || frameEvent
  const runId = parsed?.run_id || parsed?.runId || payload.run_id
  const responseId = runId

  if (brokerKind === 'content' || brokerKind === 'message.delta') {
    const deltaText = parsed?.text || parsed?.delta || payload.text || payload.delta || ''
    if (!deltaText) return { type: 'ignore' }
    return {
      type: 'emit',
      event: 'message.delta',
      appendFinalText: true,
      persistAssistantContent: true,
      payload: {
        event: 'message.delta',
        run_id: runId,
        response_id: responseId,
        delta: deltaText,
      },
    }
  }

  if (brokerKind === 'thinking' || brokerKind === 'reasoning.delta' || brokerKind === 'thinking.delta') {
    const deltaText = parsed?.text || parsed?.delta || payload.text || payload.delta || ''
    if (!deltaText) return { type: 'ignore' }
    if (
      deltaText === '正在连接模型和工具运行环境...' ||
      deltaText === '仍在等待模型或工具返回...'
    ) {
      return { type: 'ignore' }
    }
    return {
      type: 'emit',
      event: 'reasoning.delta',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: {
        event: 'reasoning.delta',
        run_id: runId,
        response_id: responseId,
        delta: deltaText,
        text: deltaText,
      },
    }
  }

  if (brokerKind === 'tool_started' || brokerKind === 'tool.started') {
    const toolName = parsed?.name || parsed?.tool || payload.name || payload.tool
    let args = parsed?.arguments ?? parsed?.args ?? payload.arguments ?? payload.args
    if (args != null && typeof args !== 'string') args = JSON.stringify(args)
    const preview = parsed?.preview || payload.preview || summarizeToolArguments(args || '')
    if (shouldPersistToolPreviewAsArgs(args, preview)) {
      const key = ['terminal', 'execute_code', 'lark_cli'].includes(String(toolName || '')) ? 'cmd' : 'preview'
      args = JSON.stringify({ [key]: String(preview).trim() })
    }
    const toolCallId = brokerToolCallId(parsed, payload, runId, toolName)
    return {
      type: 'emit',
      event: 'tool.started',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: {
        event: 'tool.started',
        run_id: runId,
        response_id: responseId,
        tool_call_id: toolCallId,
        tool: toolName,
        name: toolName,
        arguments: args,
        preview,
      },
    }
  }

  if (brokerKind === 'tool_completed' || brokerKind === 'tool.completed') {
    const toolName = parsed?.name || parsed?.tool || payload.name || payload.tool
    const isError = parsed?.is_error ?? payload.is_error ?? (typeof parsed?.error === 'string' || typeof payload.error === 'string')
    const toolCallId = brokerToolCallId(parsed, payload, runId, toolName)
    return {
      type: 'emit',
      event: 'tool.completed',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: {
        event: 'tool.completed',
        run_id: runId,
        response_id: responseId,
        tool_call_id: toolCallId,
        tool: toolName,
        name: toolName,
        output: parsed?.output ?? parsed?.text ?? payload.output ?? payload.text,
        duration: parsed?.duration ?? payload.duration,
        error: parsed?.error ?? payload.error ?? isError,
        is_error: isError,
      },
    }
  }

  if (brokerKind === 'clarify_required' || brokerKind === 'clarify.requested') {
    const clarifyId = parsed?.clarify_id || payload.clarify_id
    if (!clarifyId) return { type: 'ignore' }
    return {
      type: 'emit',
      event: 'clarify.requested',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: {
        event: 'clarify.requested',
        run_id: runId,
        response_id: responseId,
        clarify_id: String(clarifyId),
        question: String(parsed?.question || payload.question || ''),
        choices: Array.isArray(parsed?.choices) ? parsed.choices : (Array.isArray(payload.choices) ? payload.choices : []),
      },
    }
  }

  if (brokerKind === 'clarify_resolved' || brokerKind === 'clarify.resolved') {
    const clarifyId = parsed?.clarify_id || payload.clarify_id
    if (!clarifyId) return { type: 'ignore' }
    return {
      type: 'emit',
      event: 'clarify.resolved',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: {
        event: 'clarify.resolved',
        run_id: runId,
        response_id: responseId,
        clarify_id: String(clarifyId),
        response: parsed?.response ?? payload.response,
        timed_out: parsed?.timed_out ?? payload.timed_out,
      },
    }
  }

  if (brokerKind === 'auth_required') {
    // A connector's credential expired mid-run. The broker parked the original
    // request keyed by run_id and exposes a replay endpoint; surface a
    // structured event so the chat UI can render an inline re-auth card instead
    // of leaving the failure as free-form assistant text.
    const connectorId = String(parsed?.connector_id || payload.connector_id || '')
    if (!connectorId) return { type: 'ignore' }
    return {
      type: 'emit',
      event: 'auth.required',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: {
        event: 'auth.required',
        run_id: runId,
        response_id: responseId,
        connector_id: connectorId,
        provider: String(parsed?.provider || payload.provider || ''),
      },
    }
  }

  if (brokerKind === 'done' || brokerKind === 'run.completed') {
    return {
      type: 'terminal',
      event: 'run.completed',
      payload: {
        event: 'run.completed',
        run_id: runId,
        response_id: responseId,
        output: parsed?.text || payload.output,
        usage: payload.usage ?? parsed?.usage,
      },
    }
  }

  if (brokerKind === 'error' || brokerKind === 'run.failed') {
    return {
      type: 'terminal',
      event: 'run.failed',
      payload: {
        event: 'run.failed',
        run_id: runId,
        response_id: responseId,
        output: parsed?.text || payload.output,
        usage: payload.usage ?? parsed?.usage,
        error: parsed?.error || payload.error,
      },
    }
  }

  return { type: 'ignore' }
}

// --- BrokerRunController ---
// Fork-only: the broker dispatcher for the external multitenancy run-broker (:8766).
// Not a namespace owner — the upstream ChatRunSocket owns /chat-run and, when
// config.webuiRunBroker is set, hands this controller the namespace via init(nsp).
// This keeps R1 intact: every run/resume/abort/clarify path here is broker-native
// (no upstream AgentBridgeClient), and our Feishu auth (authMiddleware) stays in force.

export class BrokerRunController {
  private nsp!: ReturnType<Server['of']>
  /** profile-scoped session key → session state (messages, working status, events, run tracking) */
  private sessionMap = new Map<string, SessionState>()

  private profileKey(profile?: string): string {
    return profile?.trim() || 'default'
  }

  private sessionStateKey(sessionId: string, profile?: string): string {
    return `${this.profileKey(profile)}\u0000${sessionId}`
  }

  private sessionRoom(sessionId: string, profile?: string): string {
    return `session:${encodeURIComponent(this.profileKey(profile))}:${encodeURIComponent(sessionId)}`
  }

  private getSessionState(sessionId: string, profile?: string): SessionState | undefined {
    return this.sessionMap.get(this.sessionStateKey(sessionId, profile))
  }

  private setSessionState(sessionId: string, profile: string | undefined, state: SessionState): void {
    this.sessionMap.set(this.sessionStateKey(sessionId, profile), state)
  }

  private scopedSessionMap(profile: string): Map<string, SessionState> {
    return {
      get: (sessionId: string) => this.getSessionState(sessionId, profile),
    } as unknown as Map<string, SessionState>
  }

  /** Parent ChatRunSocket hands us its /chat-run namespace when webuiRunBroker. */
  init(nsp: ReturnType<Server['of']>) {
    this.nsp = nsp
    this.nsp.use(this.authMiddleware.bind(this))
    this.nsp.on('connection', this.onConnection.bind(this))
    logger.info('[broker-controller] broker dispatcher attached to /chat-run')
  }

  // --- Auth middleware ---

  private async authMiddleware(socket: Socket, next: (err?: Error) => void) {
    if (config.authMode === 'feishu-oauth-dev') {
      const sessionCookie = extractFeishuSessionFromCookieHeader(socket.handshake.headers?.cookie)
      const user = parseFeishuSessionCookie(sessionCookie, { secret: getFeishuSessionSecret() })
      if (!user) return next(new Error('Authentication failed'))
      const requestedProfile = typeof socket.handshake.query?.profile === 'string'
        ? socket.handshake.query.profile.trim()
        : ''
      const requestedAgentId = typeof socket.handshake.query?.agent_id === 'string'
        ? socket.handshake.query.agent_id.trim()
        : ''
      // Bridge the Feishu identity into the upstream user-store so socket.data.user
      // carries a real numeric `.id` + owned `profiles` (upstream isolation), while
      // retaining the WebUser fields the broker chat paths read. The local `user`
      // (WebUser) is kept intact for the profile/agentId resolution just below.
      socket.data.user = { ...user, ...ensureWebUserForFeishu(user.openid) }
      const sharedAgentProfile = requestedAgentId
        ? await resolveAccessibleSocketAgentProfile(user.openid, requestedAgentId, requestedProfile)
        : null
      if (requestedAgentId && !sharedAgentProfile) {
        return next(new Error('Agent access denied'))
      }
      const resolvedProfile = requestedAgentId
        ? sharedAgentProfile || user.profile
        : requestedProfile && requestedProfile !== user.profile && ownerOwnsProfile(user.openid, requestedProfile)
        ? requestedProfile
        : user.profile
      socket.data.profile = resolvedProfile
      socket.data.agentId = requestedAgentId || resolveOwnedProfileAgentId(user.openid, resolvedProfile)
      return next()
    }

    // Token mode: align with upstream's user-token auth. The rebaselined client
    // login now issues a per-user session token (validated by authenticateUserToken),
    // not the legacy static server token — comparing against getToken() here would
    // reject every real login. Feishu (prod) auth is handled in the branch above.
    const token = socket.handshake.auth?.token as string | undefined
    if (!(await isAuthEnabled())) {
      next()
      return
    }
    const user = await authenticateUserToken(token || '')
    if (!user) {
      return next(new Error('Authentication failed'))
    }
    socket.data.user = user
    const socketProfile = String(socket.handshake.query?.profile || '').trim()
    if (socketProfile && user.role !== 'super_admin' && !userCanAccessProfile(user.id, socketProfile)) {
      return next(new Error('Profile access denied'))
    }
    next()
  }

  // --- Connection handler ---

  private onConnection(socket: Socket) {
    const profile = (socket.data?.profile as string | undefined) || (socket.handshake.query?.profile as string) || 'default'

    socket.on('run', async (data: {
      input: string | ContentBlock[]
      __skipSessionCommand?: boolean
      __hideUserMessage?: boolean
      session_id?: string
      source?: ChatRunSource
      model?: string
      provider?: string
      workspace?: string | null
      instructions?: string
      expert_id?: string
      expert_label?: string
      expert_avatar?: string
      queue_id?: string
    }) => {
      const sessionCommand = config.webuiRunBroker && data.session_id && !data.__skipSessionCommand
        ? parseBrokerSessionCommand(data.input)
        : null
      const serializedCommand = sessionCommand?.name === 'plan' || sessionCommand?.name === 'goal'
      let admittedState: SessionState | undefined
      if (data.session_id) {
        try {
          admittedState = this.getOrCreateSession(data.session_id, profile)
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          logger.warn({ err, sessionId: data.session_id }, '[chat-run-socket] rejected run before generation admission')
          socket.emit('run.rejected', {
            event: 'run.rejected',
            session_id: data.session_id,
            queue_id: data.queue_id,
            error,
          })
          return
        }
        if (sessionCommand && !serializedCommand) {
          await this.handleBrokerSessionCommand(socket, data, profile, admittedState)
          return
        }
        if (admittedState.isWorking) {
          admittedState.queue.push({
            queue_id: data.queue_id || `queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            input: data.input,
            source: data.source,
            model: data.model,
            provider: data.provider,
            workspace: data.workspace,
            instructions: data.instructions,
            expert_id: data.expert_id,
            expert_label: data.expert_label,
            expert_avatar: data.expert_avatar,
            profile,
          })
          admittedState.goalEvaluationAbortController?.abort()
          this.nsp.to(this.sessionRoom(data.session_id, profile)).emit('run.queued', {
            event: 'run.queued',
            session_id: data.session_id,
            queue_length: admittedState.queue.length,
          })
          logger.info('[chat-run-socket] queued run for session %s (queue: %d)', data.session_id, admittedState.queue.length)
          return
        }
      }
      if (sessionCommand && admittedState) {
        await this.handleBrokerSessionCommand(socket, data, profile, admittedState)
        return
      }
      await this.handleRun(socket, data, profile)
    })

    socket.on('cancel_queued_run', (data: { session_id?: string; queue_id?: string }) => {
      if (!data.session_id || !data.queue_id) return
      const state = this.getSessionState(data.session_id, profile)
      if (!state?.queue.length) return
      const before = state.queue.length
      state.queue = state.queue.filter(item => item.queue_id !== data.queue_id)
      if (state.queue.length === before) return
      this.nsp.to(this.sessionRoom(data.session_id, profile)).emit('run.queued', {
        event: 'run.queued',
        session_id: data.session_id,
        queue_length: state.queue.length,
      })
      logger.info('[chat-run-socket] cancelled queued run %s for session %s (queue: %d)',
        data.queue_id, data.session_id, state.queue.length)
    })

    socket.on('resume', async (data: { session_id?: string }) => {
      if (!data.session_id) return
      const sid = data.session_id
      const room = this.sessionRoom(sid, profile)
      socket.join(room)
      this.resumeSession(socket, sid, profile)
    })

    socket.on('abort', (data: { session_id?: string }) => {
      if (data.session_id) {
        void this.handleAbort(socket, data.session_id, profile)
      }
    })

    socket.on('clarify.respond', async (data: { session_id?: string; clarify_id?: string; response?: string }) => {
      const sessionId = String(data.session_id || '').trim()
      const clarifyId = String(data.clarify_id || '').trim()
      if (!sessionId || !clarifyId) return
      try {
        await respondToBrokerClarify({
          socket,
          profile,
          agentId: (socket.data?.agentId as string | undefined)?.trim(),
          sessionId,
          clarifyId,
          response: String(data.response || ''),
        })
        this.nsp.to(this.sessionRoom(sessionId, profile)).emit('clarify.resolved', {
          event: 'clarify.resolved',
          session_id: sessionId,
          clarify_id: clarifyId,
          response: String(data.response || ''),
        })
      } catch (err: any) {
        socket.emit('clarify.failed', {
          event: 'clarify.failed',
          session_id: sessionId,
          clarify_id: clarifyId,
          error: err?.message || String(err),
        })
      }
    })

    // Re-auth loop: after the user re-authorizes an expired connector, replay the
    // parked request through the SAME socket-run relay so the answer streams back
    // into this chat session (the broker holds the original request; we do not
    // resend it from the client).
    socket.on('credential.replay', async (data: { session_id?: string; run_id?: string; connector_id?: string; provider?: string }) => {
      const sessionId = String(data.session_id || '').trim()
      const runId = String(data.run_id || '').trim()
      if (!sessionId || !runId) return
      await this.handleReplay(socket, sessionId, runId, profile, {
        connectorId: String(data.connector_id || ''),
        provider: String(data.provider || ''),
      })
    })
  }
  private handleMessage(messages: SessionMessage[], sid: string): any[] {
    let _messages = []
    try {
      _messages = messages
        .filter(m => (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') && m.content !== undefined)
        .map((m, idx, arr) => {
          const msg: any = {
            id: m.client_id || m.id,
            session_id: sid,
            role: m.role,
            content: m.content || '',
            reasoning: m.reasoning || '',
            timestamp: m.timestamp,
          }
          if (m.run_id) msg.run_id = m.run_id
          if (m.client_id) msg.client_id = m.client_id
          // Convert Anthropic format content to OpenAI format
          // Check if content is a stringified array (Hermes Gateway behavior) - only for assistant messages
          if (m.role === 'assistant' && typeof m.content === 'string') {
            // Handle double-serialized content: "[{'type': 'text', ...}]" -> "[{'type': 'text', ...}]"
            let contentToParse = m.content
            const trimmed = m.content.trim()
            if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
              contentToParse = trimmed.slice(1, -1)
              logger.info('[chat-run-socket] resume message %s: double-serialized, removed outer quotes', m.id)
            }

            if (contentToParse.startsWith('[') && contentToParse.endsWith(']')) {
              try {
                // Use robust LLM JSON parser
                const parsedContent = parseAnthropicContentArray(contentToParse)
                const textBlocks: string[] = []
                const toolCalls: any[] = []
                let reasoningContent: string | null = null

                for (const block of parsedContent) {
                  if (block.type === 'thinking') {
                    reasoningContent = block.thinking || null
                  } else if (block.type === 'text') {
                    textBlocks.push(block.text || '')
                  } else if (block.type === 'tool_use') {
                    toolCalls.push({
                      id: block.id,
                      type: 'function',
                      function: {
                        name: block.name,
                        arguments: typeof block.input === 'object' ? JSON.stringify(block.input) : (block.input ?? '{}')
                      }
                    })
                  }
                }

                msg.content = textBlocks.join('') || ''
                if (toolCalls.length > 0) {
                  msg.tool_calls = toolCalls
                }
                if (reasoningContent) {
                  msg.reasoning = reasoningContent
                }
              } catch (e) {
                logger.warn(e, '[chat-run-socket] failed to parse array content for message %s, keeping original', m.id)
                // Parsing failed, keep original content
                msg.content = m.content
              }
            }
          } else if (Array.isArray(m.content)) {
            const textBlocks: string[] = []
            const toolCalls: any[] = []
            let reasoningContent: string | null = null

            for (const block of m.content) {
              if (block.type === 'thinking') {
                reasoningContent = block.thinking
              } else if (block.type === 'text') {
                textBlocks.push(block.text)
              } else if (block.type === 'tool_use') {
                toolCalls.push({
                  id: block.id,
                  type: 'function',
                  function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input ?? {})
                  }
                })
              }
            }

            msg.content = textBlocks.join('') || ''
            if (toolCalls.length > 0) {
              msg.tool_calls = toolCalls
            }
            if (reasoningContent) {
              msg.reasoning = reasoningContent
            }
          }

          if (m.tool_calls?.length) {
            // Filter out tool_calls with empty/invalid id and remove internal fields
            const cleanedToolCalls = m.tool_calls
              .filter((tc: any) => tc.id && tc.id.length > 0)
              .map((tc: any) => ({
                id: tc.id,
                type: tc.type,
                function: tc.function
              }))
            if (cleanedToolCalls.length > 0) {
              msg.tool_calls = cleanedToolCalls
            }
          }

          // For tool messages, ensure tool_call_id exists
          if (m.role === 'tool') {
            let callId = m.tool_call_id
            if (!callId || callId.length === 0) {
              // Try to reconstruct tool_call_id from previous assistant message
              const prevMsg = arr[idx - 1]
              if (prevMsg?.role === 'assistant' && prevMsg.tool_calls?.length) {
                // Find matching tool_call by tool_name
                const tc = prevMsg.tool_calls.find((t: any) => t.function?.name === m.tool_name)
                if (tc?.id) {
                  callId = tc.id
                }
              }
            }
            // Skip tool message if no valid tool_call_id
            if (!callId || callId.length === 0) {
              return null
            }
            msg.tool_call_id = callId
          }

          if (m.tool_name) msg.tool_name = m.tool_name
          if (m.reasoning) msg.reasoning = m.reasoning
          return msg
        })
        .filter(m => m !== null)
    } catch (error) {

    }
    return _messages
  }
  private async resumeSession(socket: Socket, sid: string, profile?: string) {
    const state = await loadSessionStateWithGenerationFence({
      sessionId: sid,
      getState: () => this.getSessionState(sid, profile),
      setState: next => this.setSessionState(sid, profile, next),
      discardState: stale => {
        this.abandonRun(sid, this.profileKey(profile), stale, stale.activeRunMarker)
      },
      loadState: () => this.loadSessionStateFromDb(sid, profile),
    })
    socket.emit('resumed', {
      session_id: sid,
      messages: state.messages,
      isWorking: state.isWorking,
      isAborting: state.isAborting || false,
      events: state.isWorking ? state.events : [],
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      queueLength: state.queue?.length || 0,
    })

    logger.info('[chat-run-socket] socket %s resumed session %s (working: %s, messages: %d)',
      socket.id, sid, state.isWorking, state.messages.length)
  }

  private async getSessionDetailForProfile(sid: string, profile?: string) {
    const localDetail = getSessionDetail(sid)
    const localProfile = localDetail?.profile || 'default'
    if (localDetail?.source === 'api_server' && (!profile || localProfile === profile)) {
      return localDetail
    }
    return profile
      ? await getSessionDetailFromDbWithProfile(sid, profile)
      : await getSessionDetailFromDb(sid)
  }

  private async loadSessionStateFromDb(sid: string, profile?: string): Promise<SessionState> {
    try {
      const detail = await this.getSessionDetailForProfile(sid, profile)
      const messages = detail?.messages ? this.handleMessage(detail.messages, sid) : []

      let inputTokens: number
      let outputTokens: number
      const snapshot = getCompressionSnapshot(sid)
      if (snapshot) {
        const newMessages = messages.slice(snapshot.lastMessageIndex + 1)
        inputTokens = countTokens(SUMMARY_PREFIX + snapshot.summary) +
          newMessages.filter(m => m.role === 'user').reduce((sum, m) => sum + countTokens(m.content || ''), 0)
        outputTokens = newMessages
          .filter(m => m.role === 'assistant' || m.role === 'tool')
          .reduce((sum, m) => sum + countTokens(m.content || '') + countTokens(m.tool_calls + '' || ''), 0)
      } else {
        inputTokens = messages.filter(m => m.role === 'user').reduce((sum, m) => sum + countTokens(m.content || ''), 0)
        outputTokens = messages
          .filter(m => m.role === 'assistant' || m.role === 'tool')
          .reduce((sum, m) => sum + countTokens(m.content || '') + countTokens(m.tool_calls + '' || ''), 0)
      }

      logger.info('[chat-run-socket] loaded session %s from DB (%d messages)', sid, messages.length)
      return {
        messages,
        isWorking: false,
        events: [],
        inputTokens,
        outputTokens,
        queue: [],
      }
    } catch (err) {
      logger.warn(err, '[chat-run-socket] failed to load session %s from DB', sid)
      return { messages: [], isWorking: false, events: [], queue: [] }
    }
  }
  // --- Run handler ---

  private async handleRun(
    socket: Socket,
    data: { input: string | ContentBlock[]; __skipSessionCommand?: boolean; __hideUserMessage?: boolean; session_id?: string; source?: ChatRunSource; model?: string; provider?: string; workspace?: string | null; instructions?: string; expert_id?: string; expert_label?: string; expert_avatar?: string; queue_id?: string },
    profile: string,
    skipUserMessage = false,
  ) {
    const { input, session_id, model, provider, instructions, expert_id } = data

    // Local marker used only to group in-memory messages for this streamed response.
    const runMarker = session_id
      ? `resp_run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      : undefined

    // Emit helper: tag every payload with session_id
    const emit = (event: string, payload: any) => {
      const tagged = session_id ? { ...payload, session_id } : payload
      if (session_id) {
        this.nsp.to(this.sessionRoom(session_id, profile)).emit(event, tagged)
      } else if (socket.connected) {
        socket.emit(event, tagged)
      }
    }

    const now = Math.floor(Date.now() / 1000)
    let state: SessionState | undefined
    try {
      // Mark working immediately on run start, and append user message.
      if (session_id) {
        state = this.getOrCreateSession(session_id, profile)
        state.isWorking = true
        state.events = []
        state.profile = profile
        state.activeRunMarker = runMarker

        const existingSession = getSession(session_id)
        if (!data.__hideUserMessage) {
          // Convert ContentBlock[] to string for storage
          const inputStr = contentBlocksToString(input)
          state.messages.push({
            id: data.queue_id || state.messages.length + 1,
            session_id,
            runMarker,
            role: 'user',
            content: inputStr,
            timestamp: now,
          })

          // Create session in local DB if it doesn't exist
          if (!existingSession) {
            const previewText = extractTextForPreview(input)
            const preview = previewText.replace(/[\r\n]/g, ' ').substring(0, 100)
            createSessionAndBind(state, {
              id: session_id,
              profile,
              agent: (socket.data?.agentId as string | undefined)?.trim(),
              user_id: String(socket.data?.user?.openid || socket.data?.user?.id || '') || null,
              model,
              title: preview,
            })
          }

          // Write user message to local DB immediately
          addMessage({
            session_id,
            client_id: data.queue_id || null,
            role: 'user',
            content: inputStr,
            timestamp: now,
          })
        }

        const cleanExpertId = typeof expert_id === 'string' ? expert_id.trim() : ''
        const isCodingAgentRun = data.source === 'coding_agent' || existingSession?.source === 'coding_agent'
        if (cleanExpertId && !isCodingAgentRun) {
          updateSession(session_id, {
            expert_id: cleanExpertId,
            expert_label: typeof data.expert_label === 'string' && data.expert_label.trim()
              ? data.expert_label.trim()
              : cleanExpertId,
            expert_avatar: typeof data.expert_avatar === 'string' && data.expert_avatar.trim()
              ? data.expert_avatar.trim()
              : null,
          } as any)
        }

        // A brand-new session was initially bound to {null,null}; capture the
        // row/incarnation created above before the broker handler revalidates it.
        bindSessionGeneration(state, readSessionGeneration(session_id))
        socket.join(this.sessionRoom(session_id, profile))
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      if (session_id && state && this.getSessionState(session_id, profile) === state && state.activeRunMarker === runMarker) {
        state.isWorking = false
        state.isAborting = false
        state.abortController = undefined
        state.runId = undefined
        state.activeRunMarker = undefined
        state.responseRun = undefined
        state.profile = undefined
        state.events = []
        emit('run.failed', {
          event: 'run.failed',
          run_id: runMarker,
          error,
          queue_remaining: state.queue.length,
        })
        this.dequeueNextQueuedRun(socket, session_id, profile, state)
      } else {
        emit('run.failed', { event: 'run.failed', run_id: runMarker, error, queue_remaining: 0 })
      }
      return
    }
    if (config.webuiRunBroker) {
      await this.handleBrokerRun(socket, {
        input,
        session_id,
        model,
        provider,
        workspace: data.workspace,
        instructions,
        expert_id,
      }, profile, runMarker, emit)
      return
    }

  }


  private getResponseRunState(state: SessionState, runMarker?: string): ResponseRunState {
    if (!state.responseRun || state.responseRun.runMarker !== runMarker) {
      state.responseRun = {
        runMarker,
        insertedKeys: new Set<string>(),
        toolCalls: new Map<string, any>(),
      }
    }
    return state.responseRun
  }

  /** Flush all non-user messages for this run to DB in order. */
  private flushResponseRunToDb(state: SessionState, sessionId: string) {
    const run = state.responseRun
    if (!run?.runMarker) return
    const firstUser = state.messages.find(msg => msg.role === 'user')?.content || ''
    if (!getSession(sessionId)) {
      createSessionAndBind(state, {
        id: sessionId,
        profile: state.profile || 'default',
        agent: '',
        title: firstUser.replace(/[\r\n]/g, ' ').slice(0, 100),
      })
    }
    const detail = getSessionDetail(sessionId)
    const hasUserMessage = detail?.messages?.some(message => message.role === 'user')
    if (firstUser && !hasUserMessage) {
      addMessage({
        session_id: sessionId,
        role: 'user',
        content: firstUser,
        timestamp: state.messages.find(msg => msg.role === 'user')?.timestamp,
      })
    }
    let flushed = 0
    for (const msg of state.messages) {
      if (msg.runMarker !== run.runMarker) continue
      if (msg.role === 'user') continue
      if (msg.role === 'assistant' && state.profile && msg.content) {
        msg.content = rewriteAssistantMediaDirectives({
          content: msg.content,
          profileDir: getProfileDir(state.profile),
        })
      }
      addMessage({
        session_id: sessionId,
        run_id: msg.run_id || run.responseId || state.runId || null,
        role: msg.role,
        content: msg.content || '',
        tool_call_id: msg.tool_call_id ?? null,
        tool_calls: msg.tool_calls ?? null,
        tool_name: msg.tool_name ?? null,
        finish_reason: msg.finish_reason ?? null,
        reasoning: msg.reasoning ?? null,
        reasoning_details: msg.reasoning_details ?? null,
        reasoning_content: msg.reasoning_content ?? null,
        timestamp: msg.timestamp,
      })
      flushed++
    }
    logger.info('[chat-run-socket] flushResponseRunToDb: flushed %d messages for session %s',
      flushed, sessionId)
  }

  private rewriteRunAssistantMedia(
    sessionId: string,
    runMarker: string | undefined,
    profile: string,
    fallbackContent: string,
  ): string | undefined {
    const state = this.getSessionState(sessionId, profile)
    if (!state) return fallbackContent
    const profileDir = getProfileDir(profile)
    let latestAssistant: SessionMessage | undefined
    for (let i = state.messages.length - 1; i >= 0; i -= 1) {
      const msg = state.messages[i]
      if (msg.runMarker !== runMarker || msg.role !== 'assistant' || msg.tool_calls?.length) continue
      latestAssistant = msg
      break
    }
    if (!latestAssistant) {
      return rewriteAssistantMediaDirectives({ content: fallbackContent, profileDir })
    }
    latestAssistant.content = rewriteAssistantMediaDirectives({
      content: latestAssistant.content || fallbackContent,
      profileDir,
    })
    return latestAssistant.content
  }

  private persistCommandMessage(sessionId: string, state: SessionState, content: string) {
    const text = String(content || '').trim()
    if (!text) return
    const now = Math.floor(Date.now() / 1000)
    if (!getSession(sessionId)) {
      createSessionAndBind(state, {
        id: sessionId,
        profile: state.profile || 'default',
        title: text.replace(/[\r\n]/g, ' ').slice(0, 100),
      })
    }
    state.messages.push({
      id: state.messages.length + 1,
      session_id: sessionId,
      role: 'command',
      content: text,
      timestamp: now,
    })
    addMessage({
      session_id: sessionId,
      role: 'command',
      content: text,
      timestamp: now,
    })
  }

  private emitSessionCommand(socket: Socket, sessionId: string, profile: string, payload: Record<string, unknown>) {
    this.emitToSession(socket, sessionId, profile, 'session.command', {
      event: 'session.command',
      session_id: sessionId,
      ok: true,
      ...payload,
    })
  }

  private async handleBrokerSessionCommand(
    socket: Socket,
    data: {
      input: string | ContentBlock[]
      session_id?: string
      source?: ChatRunSource
      model?: string
      provider?: string
      instructions?: string
      expert_id?: string
      expert_label?: string
      expert_avatar?: string
      queue_id?: string
    },
    profile: string,
    state?: SessionState,
  ) {
    const sessionId = String(data.session_id || '').trim()
    const parsed = parseBrokerSessionCommand(data.input)
    if (!sessionId || !parsed) return false
    if (!state) {
      try {
        state = this.getOrCreateSession(sessionId, profile)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        socket.emit('run.rejected', {
          event: 'run.rejected',
          session_id: sessionId,
          queue_id: data.queue_id,
          error,
        })
        return true
      }
    }

    const serialized = parsed.name === 'plan' || parsed.name === 'goal'
    const commandMarker = serialized
      ? `command_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      : undefined
    let commandGeneration = {
      rowId: state.sessionRowId ?? null,
      incarnation: state.sessionIncarnation ?? null,
    }
    const commandAbortController = serialized ? new AbortController() : undefined

    if (serialized && (state.isWorking || state.activeRunMarker)) {
      state.queue.push({
        queue_id: data.queue_id || `queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        input: data.input,
        source: data.source,
        model: data.model,
        provider: data.provider,
        instructions: data.instructions,
        expert_id: data.expert_id,
        expert_label: data.expert_label,
        expert_avatar: data.expert_avatar,
        profile,
      })
      state.goalEvaluationAbortController?.abort()
      this.nsp.to(this.sessionRoom(sessionId, profile)).emit('run.queued', {
        event: 'run.queued',
        session_id: sessionId,
        queue_length: state.queue.length,
      })
      return true
    }

    if (serialized) {
      state.isWorking = true
      state.isAborting = false
      state.activeRunMarker = commandMarker
      state.runId = commandMarker
      state.abortController = commandAbortController
      state.events = []
    }
    const hasCommandToken = () => (
      this.getSessionState(sessionId, profile) === state
      && (!serialized || state.activeRunMarker === commandMarker)
    )
    const commandGenerationIsCurrent = () => (
      sessionGenerationsEqual(readSessionGeneration(sessionId), commandGeneration)
      && stateMatchesSessionGeneration(state, commandGeneration)
    )
    const releaseCommand = () => {
      if (!serialized || state.activeRunMarker !== commandMarker) return false
      state.isWorking = false
      state.isAborting = false
      state.abortController = undefined
      state.runId = undefined
      state.activeRunMarker = undefined
      state.responseRun = undefined
      state.profile = undefined
      state.events = []
      return true
    }
    const discardStaleCommand = (removeMappedState = false) => {
      commandAbortController?.abort()
      if (removeMappedState && this.getSessionState(sessionId, profile) === state) {
        this.abandonRun(sessionId, profile, state, state.activeRunMarker)
        return
      }
      releaseCommand()
    }

    try {
      state.profile = profile
      socket.join(this.sessionRoom(sessionId, profile))
      try {
        this.persistCommandMessage(sessionId, state, parsed.raw)
      } finally {
        if (state.sessionRowId !== undefined && state.sessionIncarnation !== undefined) {
          commandGeneration = {
            rowId: state.sessionRowId,
            incarnation: state.sessionIncarnation,
          }
        }
      }
      commandGeneration = readSessionGeneration(sessionId)

      const result: BrokerSessionCommandResult = await runBrokerSessionCommand({
        socket,
        profile,
        agentId: (socket.data?.agentId as string | undefined)?.trim(),
        sessionId,
        command: parsed.raw,
        signal: commandAbortController?.signal,
      })

      if (commandAbortController?.signal.aborted || state.isAborting) {
        throw new DOMException('aborted', 'AbortError')
      }
      if (!hasCommandToken()) {
        discardStaleCommand()
        return true
      }
      if (!commandGenerationIsCurrent()) {
        discardStaleCommand(true)
        return true
      }

      const commandName = String(result.command || parsed.name)
      const action = String(result.action || parsed.name)
      const message = typeof result.message === 'string' ? result.message.trim() : ''
      const kickoffPrompt = typeof result.kickoff_prompt === 'string' ? result.kickoff_prompt.trim() : ''
      const hiddenPrompt = (
        kickoffPrompt ||
        (commandName === 'plan' && result.handled && message ? message : '')
      ).trim()
      const shouldStartRun = Boolean(result.handled && hiddenPrompt && (commandName === 'plan' || commandName === 'goal'))
      const eventMessage = commandName === 'plan' && shouldStartRun ? 'Plan started.' : message

      if (eventMessage) {
        this.persistCommandMessage(sessionId, state, eventMessage)
      }
      if (!shouldStartRun) releaseCommand()
      this.emitSessionCommand(socket, sessionId, profile, {
        command: commandName,
        action,
        terminal: serialized
          ? !shouldStartRun && state.queue.length === 0
          : !state.isWorking,
        started: shouldStartRun,
        message: eventMessage,
        type: result.type,
        historyCount: result.history_count,
        handled: result.handled,
      })
      if (shouldStartRun) {
        releaseCommand()
        await this.handleRun(socket, {
          input: hiddenPrompt,
          __skipSessionCommand: true,
          __hideUserMessage: true,
          session_id: sessionId,
          source: data.source,
          model: data.model,
          provider: data.provider,
          instructions: data.instructions,
          expert_id: data.expert_id,
          expert_label: data.expert_label,
          expert_avatar: data.expert_avatar,
        }, profile)
      } else if (serialized) {
        this.dequeueNextQueuedRun(socket, sessionId, profile, state)
      }
    } catch (err) {
      const tokenCurrent = hasCommandToken()
      let generationCurrent = false
      let generationError: unknown
      if (tokenCurrent) {
        try {
          generationCurrent = commandGenerationIsCurrent()
        } catch (identityErr) {
          generationError = identityErr
        }
      }
      if (!tokenCurrent || (!generationCurrent && !generationError)) {
        discardStaleCommand(tokenCurrent && !generationCurrent && !generationError)
        return true
      }

      const aborted = Boolean(commandAbortController?.signal.aborted)
      const detailSource = generationError || err
      const detail = detailSource instanceof Error ? detailSource.message : String(detailSource)
      releaseCommand()
      if (aborted) {
        this.emitToSession(socket, sessionId, profile, 'abort.completed', {
          event: 'abort.completed',
          run_id: commandMarker,
          synced: true,
          queue_length: state.queue.length,
          failure_pending: Boolean(generationError),
        })
      }
      if (!aborted || generationError) {
        const message = `Command failed: ${detail}`
        if (!generationError) {
          try {
            this.persistCommandMessage(sessionId, state, message)
          } catch (persistErr) {
            logger.warn({ err: persistErr, sessionId }, '[chat-run-socket] failed to persist command error')
          }
        }
        this.emitSessionCommand(socket, sessionId, profile, {
          command: parsed.name,
          ok: false,
          action: 'error',
          terminal: serialized ? state.queue.length === 0 : !state.isWorking,
          message,
        })
      }
      if (serialized) this.dequeueNextQueuedRun(socket, sessionId, profile, state)
    }
    return true
  }

  private async maybeEvaluateGoalAfterRun(
    socket: Socket,
    sessionId: string,
    profile: string | undefined,
    finalResponse: string | undefined,
    state: SessionState,
    isCurrent?: () => boolean,
  ) {
    const responseText = String(finalResponse || '').trim()
    if (!config.webuiRunBroker || !profile || !responseText || state.queue.some(item => !item.goalContinuation)) return
    const goalEvaluationAbortController = new AbortController()
    const runSignal = state.abortController?.signal
    const abortGoalEvaluation = () => goalEvaluationAbortController.abort()
    if (runSignal?.aborted) abortGoalEvaluation()
    else runSignal?.addEventListener('abort', abortGoalEvaluation, { once: true })
    state.goalEvaluationAbortController = goalEvaluationAbortController
    let result: BrokerGoalEvaluateResult
    try {
      result = await runBrokerGoalEvaluate({
        socket,
        profile,
        agentId: (socket.data?.agentId as string | undefined)?.trim(),
        sessionId,
        finalResponse: responseText,
        signal: goalEvaluationAbortController.signal,
      })
    } catch (err) {
      logger.warn({ err, sessionId, profile }, '[chat-run-socket] broker goal evaluate failed')
      return
    } finally {
      runSignal?.removeEventListener('abort', abortGoalEvaluation)
      if (state.goalEvaluationAbortController === goalEvaluationAbortController) {
        state.goalEvaluationAbortController = undefined
      }
    }
    if ((isCurrent && !isCurrent()) || state.queue.some(item => !item.goalContinuation)) return
    const continuation = typeof result.continuation_prompt === 'string'
      ? result.continuation_prompt.trim()
      : ''
    if (!result.should_continue || !continuation) return
    const message = typeof result.message === 'string' && result.message.trim()
      ? result.message.trim()
      : 'Continuing goal.'
    this.persistCommandMessage(sessionId, state, message)
    this.emitSessionCommand(socket, sessionId, profile, {
      command: 'goal',
      action: 'continue',
      terminal: false,
      started: true,
      message,
      verdict: result.verdict,
      reason: result.reason,
    })
    state.queue.push({
      queue_id: `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      input: continuation,
      profile,
      goalContinuation: true,
    })
  }

  // --- Abort handler ---

  private async handleAbort(socket: Socket, sessionId: string, profile: string) {
    const state = this.getSessionState(sessionId, profile)
    if (!state?.isWorking || (!state.runId && !state.abortController)) {
      logger.info({ sessionId }, '[chat-run-socket][abort] ignored: no active run')
      if (state) {
        state.isWorking = false
        state.isAborting = false
        state.abortController = undefined
        state.runId = undefined
        state.events = []
      }
      this.emitToSession(socket, sessionId, profile, 'abort.completed', {
        event: 'abort.completed',
        synced: false,
        ignored: true,
      })
      return
    }

    const runId = state.runId
    state.isAborting = true
    this.replaceState(sessionId, profile, 'abort.started', {
      event: 'abort.started',
      run_id: runId,
      graceMs: 5000,
    })
    this.emitToSession(socket, sessionId, profile, 'abort.started', {
      event: 'abort.started',
      run_id: runId,
      graceMs: 5000,
    })
    logger.info({ sessionId, runId }, '[chat-run-socket][abort] started')

    if (state.abortController) {
      state.abortController.abort()
    }
  }

  /** Mark a session run as completed/failed so reconnecting clients get notified */
  private async markCompleted(
    socket: Socket,
    sessionId: string,
    profileKey: string,
    state: SessionState,
    runMarker: string | undefined,
    info: { event: string; run_id?: string; final_response?: string },
    isCurrentGeneration: () => boolean,
    persist: boolean,
    failurePending = false,
  ): Promise<{ finalized: boolean; error?: string; aborted?: boolean }> {
    const ownsRun = () => (
      this.getSessionState(sessionId, profileKey) === state
      && state.activeRunMarker === runMarker
      && isCurrentGeneration()
    )
    if (!ownsRun()) return { finalized: false }

    const profile = state.profile
    let wasAborting = Boolean(state.isAborting)
    const completedRunId = info.run_id || state.runId || runMarker || 'response_stream'
    let finalizationError: string | undefined
    if (persist) {
      try {
        this.flushResponseRunToDb(state, sessionId)
        updateSessionStats(sessionId)
        const emit = (event: string, payload: any) => {
          this.nsp.to(this.sessionRoom(sessionId, profileKey)).emit(event, { ...payload, session_id: sessionId })
        }
        await this.calcAndUpdateUsage(sessionId, state, emit, profile, ownsRun)
        wasAborting ||= Boolean(state.isAborting)
        if (!ownsRun()) return { finalized: false }
        if (!wasAborting && info.event === 'run.completed') {
          await this.maybeEvaluateGoalAfterRun(
            socket,
            sessionId,
            profile,
            info.final_response,
            state,
            () => ownsRun() && !state.isAborting,
          )
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        finalizationError = `Run finalization failed: ${detail}`
        logger.warn({ err, sessionId, runMarker }, '[chat-run-socket] broker run finalization persistence failed')
      }
    }
    wasAborting ||= Boolean(state.isAborting)
    if (!ownsRun()) return { finalized: false }

    state.isWorking = false
    state.isAborting = false
    state.abortController = undefined
    state.goalEvaluationAbortController = undefined
    state.runId = undefined
    state.activeRunMarker = undefined
    state.responseRun = undefined
    state.profile = undefined
    state.events = []
    if (wasAborting) {
      this.replaceState(sessionId, profileKey, 'abort.completed', {
        event: 'abort.completed',
        run_id: completedRunId,
        synced: true,
        queue_length: state.queue.length,
        failure_pending: Boolean(finalizationError || failurePending),
      })
      this.emitToSession(socket, sessionId, profileKey, 'abort.completed', {
        event: 'abort.completed',
        run_id: completedRunId,
        synced: true,
        queue_length: state.queue.length,
        failure_pending: Boolean(finalizationError || failurePending),
      })
    }
    return {
      finalized: true,
      ...(wasAborting ? { aborted: true } : {}),
      ...(finalizationError ? { error: finalizationError } : {}),
    }
  }

  private abandonRun(sessionId: string, profileKey: string, state: SessionState, runMarker: string | undefined): boolean {
    if (state.activeRunMarker !== runMarker) return false
    state.abortController?.abort()
    state.goalEvaluationAbortController?.abort()
    state.isWorking = false
    state.isAborting = false
    state.abortController = undefined
    state.goalEvaluationAbortController = undefined
    state.runId = undefined
    state.activeRunMarker = undefined
    state.responseRun = undefined
    state.profile = undefined
    state.events = []
    state.queue.length = 0
    const key = this.sessionStateKey(sessionId, profileKey)
    if (this.sessionMap.get(key) === state) this.sessionMap.delete(key)
    return true
  }

  private dequeueNextQueuedRun(
    socket: Socket,
    sessionId: string,
    fallbackProfile = 'default',
    expectedState?: SessionState,
  ) {
    const state = this.getSessionState(sessionId, fallbackProfile)
    if (!state?.queue.length || (expectedState && state !== expectedState) || state.isWorking || state.activeRunMarker) return false

    const next = state.queue.shift()!
    logger.info('[chat-run-socket] dequeuing queued run for session %s (remaining: %d)', sessionId, state.queue.length)
    this.nsp.to(this.sessionRoom(sessionId, fallbackProfile)).emit('run.queued', {
      event: 'run.queued',
      session_id: sessionId,
      queue_length: state.queue.length,
      dequeued_queue_id: next.queue_id,
    })
    const nextData = {
      input: next.input,
      session_id: sessionId,
      queue_id: next.queue_id,
      source: next.source,
      model: next.model,
      provider: next.provider,
      workspace: next.workspace,
      instructions: next.instructions,
      expert_id: next.expert_id,
      expert_label: next.expert_label,
      expert_avatar: next.expert_avatar,
      __skipSessionCommand: next.goalContinuation,
      __hideUserMessage: next.goalContinuation,
    }
    const nextProfile = next.profile || fallbackProfile
    if (!next.goalContinuation && parseBrokerSessionCommand(next.input)) {
      void this.handleBrokerSessionCommand(socket, nextData, nextProfile, state)
    } else {
      void this.handleRun(socket, nextData, nextProfile, true)
    }
    return true
  }

  /**
   * Calculate usage from DB and update state + emit to clients.
   * @returns { inputTokens, outputTokens } for the caller to use
   */
  private async calcAndUpdateUsage(
    sid: string,
    state: SessionState,
    emit: (event: string, payload: any) => void,
    profile?: string,
    isCurrent?: () => boolean,
  ): Promise<{ inputTokens: number; outputTokens: number }> {
    try {
      const detail = await this.getSessionDetailForProfile(sid, profile || state.profile)
      if (isCurrent && !isCurrent()) return { inputTokens: 0, outputTokens: 0 }
      const msgs = detail?.messages
        ?.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool') || []

      const snapshot = getCompressionSnapshot(sid)
      let inputTokens: number
      let outputTokens: number
      if (snapshot && msgs.length) {
        const newMessages = msgs.slice(snapshot.lastMessageIndex + 1)
        inputTokens = countTokens(SUMMARY_PREFIX + snapshot.summary) +
          newMessages.filter(m => m.role === 'user').reduce((sum, m) => sum + countTokens(m.content || ''), 0)
        outputTokens = newMessages
          .filter(m => m.role === 'assistant' || m.role === 'tool')
          .reduce((sum, m) => sum + countTokens(m.content || '') + countTokens(m.tool_calls + '' || ''), 0)
      } else {
        inputTokens = msgs.filter(m => m.role === 'user').reduce((sum, m) => sum + countTokens(m.content || ''), 0)
        outputTokens = msgs
          .filter(m => m.role === 'assistant' || m.role === 'tool')
          .reduce((sum, m) => sum + countTokens(m.content || '') + countTokens(m.tool_calls + '' || ''), 0)
      }
      state.inputTokens = inputTokens
      state.outputTokens = outputTokens
      emit('usage.updated', {
        event: 'usage.updated',
        session_id: sid,
        inputTokens,
        outputTokens,
      })
      return { inputTokens, outputTokens }
    } catch (err: any) {
      logger.warn(err, '[chat-run-socket] failed to calculate usage for session %s', sid)
      return { inputTokens: 0, outputTokens: 0 }
    }
  }

  private async handleBrokerRun(
    socket: Socket,
    data: { input: string | ContentBlock[]; session_id?: string; model?: string; provider?: string; workspace?: string | null; instructions?: string; expert_id?: string; replay_run_id?: string },
    profile: string,
    runMarker: string | undefined,
    emit: (event: string, payload: any) => void,
  ) {
    return handleRunChatBrokerRun(socket, data, profile, runMarker, emit, {
      sessionMap: this.scopedSessionMap(profile),
      getResponseRunState: this.getResponseRunState.bind(this),
      markCompleted: (socket, sessionId, state, marker, info, isCurrent, persist, failurePending) => (
        this.markCompleted(socket, sessionId, profile, state, marker, info, isCurrent, persist, failurePending)
      ),
      abandonRun: (sessionId, state, marker) => this.abandonRun(sessionId, profile, state, marker),
      dequeueNextQueuedRun: (socket, sessionId, state) => (
        this.dequeueNextQueuedRun(socket, sessionId, profile, state)
      ),
      buildInput: buildResponsesInput,
    })
  }

  /**
   * Replay the request the broker parked under `runId` (credential re-auth loop).
   * Unlike handleRun, no user message is appended — the original request is
   * already in the transcript — the replayed run just streams its answer back
   * into the session via the shared broker-run relay.
   */
  private async handleReplay(
    socket: Socket,
    sessionId: string,
    runId: string,
    profile: string,
    card?: { connectorId: string; provider: string },
  ) {
    const runMarker = `resp_run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const state = await loadSessionStateWithGenerationFence({
      sessionId,
      getState: () => this.getSessionState(sessionId, profile),
      setState: next => this.setSessionState(sessionId, profile, next),
      discardState: stale => {
        this.abandonRun(sessionId, profile, stale, stale.activeRunMarker)
      },
      loadState: async () => getSession(sessionId)
        ? await this.loadSessionStateFromDb(sessionId, profile)
        : { messages: [], isWorking: false, events: [], queue: [] },
    })
    // Concurrency guard: the failed run that produced the re-auth card has
    // already completed (it emitted done), so isWorking is normally false here.
    // If another run is genuinely in-flight (e.g. the user sent a follow-up
    // during the 120s auth window), do NOT clobber its shared SessionState AND
    // do NOT emit a session-scoped run.failed (that would tear down the innocent
    // sibling run's tools/messages). Instead re-surface the re-auth card so the
    // user can retry once the session is idle — non-destructive.
    if (state.isWorking) {
      if (card?.connectorId) {
        this.nsp.to(this.sessionRoom(sessionId, profile)).emit('auth.required', {
          event: 'auth.required',
          session_id: sessionId,
          run_id: runId,
          connector_id: card.connectorId,
          provider: card.provider,
        })
      }
      return
    }
    state.isWorking = true
    state.events = []
    state.profile = profile
    socket.join(this.sessionRoom(sessionId, profile))

    const emit = (event: string, payload: any) => {
      this.nsp.to(this.sessionRoom(sessionId, profile)).emit(event, { ...payload, session_id: sessionId })
    }
    if (config.webuiRunBroker) {
      await this.handleBrokerRun(socket, { input: '', session_id: sessionId, replay_run_id: runId }, profile, runMarker, emit)
    }
  }


  /** Get or create session state in sessionMap */
  private getOrCreateSession(sessionId: string, profile?: string): SessionState {
    const generation = readSessionGeneration(sessionId)
    let state = this.getSessionState(sessionId, profile)
    if (state && !stateMatchesSessionGeneration(state, generation)) {
      this.abandonRun(sessionId, this.profileKey(profile), state, state.activeRunMarker)
      state = undefined
    }
    if (!state) {
      state = { messages: [], isWorking: false, events: [], queue: [] }
      bindSessionGeneration(state, generation)
      this.setSessionState(sessionId, profile, state)
    }
    return state
  }

  /** Append a state event for a session (used for replay on reconnect) */
  private pushState(sessionId: string, profile: string | undefined, event: string, data: any) {
    const state = this.getOrCreateSession(sessionId, profile)
    state.events.push({ event, data })
  }

  /** Replace the last state with the same event name, or append if different */
  private replaceState(sessionId: string, profile: string | undefined, event: string, data: any) {
    const state = this.getSessionState(sessionId, profile)
    if (state) {
      const idx = state.events.findIndex(s => s.event === event)
      if (idx >= 0) {
        state.events[idx] = { event, data }
        return
      }
    }
    this.pushState(sessionId, profile, event, data)
  }

  private emitToSession(socket: Socket, sessionId: string, profile: string | undefined, event: string, payload: any) {
    const tagged = { ...payload, session_id: sessionId }
    const room = this.sessionRoom(sessionId, profile)
    this.nsp.to(room).emit(event, tagged)
    if (!this.nsp.adapter?.rooms?.get(room)?.size && socket.connected) {
      socket.emit(event, tagged)
    }
  }

  /** Close all active upstream response streams */
  close() {
    for (const [sessionId, state] of this.sessionMap.entries()) {
      if (state.abortController) {
        try {
          state.abortController.abort()
        } catch (e) {
          logger.warn(e, '[chat-run-socket] failed to abort controller for session %s', sessionId)
        }
      }
    }
    this.sessionMap.clear()
    logger.info('[chat-run-socket] closed all connections and cleared state')
  }
}

function shouldPersistToolPreviewAsArgs(args: string | undefined, preview: unknown): boolean {
  if (args && args !== '{}' && args !== '[]') return false
  if (typeof preview !== 'string') return false
  const text = preview.trim()
  if (!text || text === 'generating arguments') return false
  return true
}

function hasUsefulToolArguments(args: string): boolean {
  if (!args || args === '{}' || args === '[]') return false
  try {
    const parsed = JSON.parse(args)
    if (!parsed || typeof parsed !== 'object') return false
    return Object.values(parsed).some(value => {
      if (typeof value === 'string') return Boolean(value.trim())
      return value != null
    })
  } catch {
    return Boolean(args.trim())
  }
}
