import type { Socket } from 'socket.io'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import type { Dirent } from 'fs'
import { join } from 'path'
import yaml from 'js-yaml'
import { getSystemPrompt } from '../../../lib/llm-prompt'
import { getSession } from '../../../db/hermes/session-store'
import { config } from '../../../config'
import { getProfileDir } from '../hermes-profile'
import { buildBrokerMessagesForSession, contentBlocksToString } from './content-blocks'
import { readSseFrames } from './sse-utils'
import type { ContentBlock, ResponseRunState, SessionMessage, SessionState } from './types'

export { readSseFrames } from './sse-utils'

export type RunBrokerChatFrameMapping =
  | {
      type: 'emit'
      event: string
      payload: any
      appendFinalText: boolean
      persistAssistantContent: boolean
    }
  | { type: 'terminal'; event: 'run.completed' | 'run.failed'; payload: any }
  | { type: 'ignore' }

type BuildRunBrokerRequestOptions = {
  input: string | ContentBlock[]
  profile: string
  ownerOpenId?: string
  sessionId?: string
  model?: string
  provider?: string
  agentId?: string
  instructions?: string
  workspace?: string | null
  messages?: SessionMessage[]
  profileDir?: string
  buildInput?: (input: string | ContentBlock[], profile: string) => Promise<any>
  appendInputToMessages?: boolean
}

type ProfileSkillRuntimeEntry = {
  name: string
  slug: string
  description: string
  dir: string
  text: string
}

const PROFILE_SKILL_SLASH_ALIASES: Record<string, string> = {
  hades: 'kep-hades-cli',
}

export async function buildRunBrokerRequest(options: BuildRunBrokerRequestOptions): Promise<Record<string, any>> {
  const {
    input,
    profile,
    ownerOpenId,
    sessionId,
    model,
    provider,
    agentId,
    instructions,
    workspace,
    messages = [],
    buildInput,
    appendInputToMessages = true,
  } = options
  const userKey = ownerOpenId?.trim() || profile
  let content = contentBlocksToString(input).trim()
  const skillRuntime = options.profileDir ? buildProfileSkillRuntimeContext(options.profileDir, content, sessionId) : null
  if (skillRuntime?.content) content = skillRuntime.content
  const metadata: Record<string, any> = {
    source: 'hermes-web-ui',
  }
  if (model) metadata.model = model
  if (provider) metadata.provider = provider
  if (sessionId) metadata.conversation = `webui:${sessionId}`
  metadata.instructions = [
    getSystemPrompt(),
    instructions,
    skillRuntime?.instructions,
  ].filter(Boolean).join('\n')

  if (workspace) {
    const workspaceCtx = `[Current working directory: ${workspace}]`
    metadata.instructions = metadata.instructions
      ? `\n${workspaceCtx}\n${metadata.instructions}`
      : `\n${workspaceCtx}`
  }

  const builtInput = buildInput ? await buildInput(skillRuntime?.content ? content : input, profile) : content
  if (builtInput !== content) {
    metadata.input = builtInput
  }

  return {
    channel: 'webui',
    profile_name: profile,
    ...(agentId ? { agent_id: agentId } : {}),
    user_key: userKey,
    content,
    session_id: sessionId,
    delivery_mode: 'socket',
    credential_subject: userKey,
    requires_host_tools: true,
    metadata,
    messages: [
      ...buildBrokerMessagesForSession(messages),
      ...(appendInputToMessages && content ? [{ role: 'user', content }] : []),
    ],
  }
}

function buildProfileSkillRuntimeContext(profileDir: string, inputText: string, sessionId?: string): { content?: string; instructions?: string } | null {
  const skills = scanProfileRuntimeSkills(profileDir)
  if (!skills.length) return null
  const slash = buildProfileSkillSlashInvocation(skills, inputText, sessionId)
  if (slash) return { content: slash }

  const relevant = skills.filter(skill => shouldInjectProfileSkill(skill, inputText)).slice(0, 2)
  if (!relevant.length) return null
  return {
    instructions: relevant.map(skill => formatProfileSkillBlock(
      skill,
      `The current WebUI message appears to match profile skill "${skill.name}". Follow this skill when it applies.`,
      '',
      sessionId,
    )).join('\n\n'),
  }
}

function buildProfileSkillSlashInvocation(skills: ProfileSkillRuntimeEntry[], inputText: string, sessionId?: string): string | undefined {
  const raw = inputText.trim()
  if (!raw.startsWith('/')) return undefined
  const [head, ...rest] = raw.split(/\s+/)
  const command = normalizeProfileSkillSlug(head.slice(1))
  if (!command || command.includes('/')) return undefined
  const target = PROFILE_SKILL_SLASH_ALIASES[command] || command
  const skill = skills.find(item => item.slug === target || normalizeProfileSkillSlug(item.name) === target)
  if (!skill) return undefined
  return formatProfileSkillBlock(
    skill,
    `The user has invoked the "${skill.name}" skill, indicating they want you to follow its instructions. The full profile-local skill content is loaded below.`,
    rest.join(' '),
    sessionId,
  )
}

function formatProfileSkillBlock(skill: ProfileSkillRuntimeEntry, activationNote: string, userInstruction = '', sessionId?: string): string {
  const rendered = renderProfileSkillText(skill.text, skill.dir, sessionId)
  const parts = [
    `[SYSTEM: ${activationNote}]`,
    '',
    rendered.trim(),
    '',
    `[Skill directory: ${skill.dir}]`,
    'Resolve any relative paths in this skill against that directory. Run scripts by absolute path and do not expose credential values.',
  ]
  if (userInstruction) {
    parts.push('', `The user has provided the following instruction alongside the skill invocation: ${userInstruction}`)
  }
  return parts.join('\n')
}

function renderProfileSkillText(text: string, skillDir: string, sessionId?: string): string {
  return text
    .replaceAll('{baseDir}', skillDir)
    .replaceAll('${HERMES_SKILL_DIR}', skillDir)
    .replaceAll('${SESSION_ID}', sessionId || '')
}

function shouldInjectProfileSkill(skill: ProfileSkillRuntimeEntry, inputText: string): boolean {
  if (!isPreloadProfileSkill(skill)) return false
  const haystack = `${skill.name}\n${skill.description}\n${skill.text}`.toLowerCase()
  const input = inputText.toLowerCase()
  if (skill.name === 'keep-record' || haystack.includes('record_tool') || haystack.includes('keep health')) {
    return /keep|记录|记一下|登记|打卡|饮食|吃|早餐|午餐|中午|晚餐|体重|体脂|围度|运动|睡眠|生理|肥肠|鸡蛋|鸡腿|青椒/.test(input)
  }
  if (skill.name === 'kep-hades-cli' || haystack.includes('hades')) {
    return /hades|投放|广告|计划|campaign|申请/.test(input)
  }
  return false
}

function isPreloadProfileSkill(skill: ProfileSkillRuntimeEntry): boolean {
  return /(?:^|\n)\s*preload:\s*true\b/i.test(skill.text) || /(?:^|\n)\s*lazyLoad:\s*false\b/i.test(skill.text)
}

function scanProfileRuntimeSkills(profileDir: string): ProfileSkillRuntimeEntry[] {
  const root = join(profileDir, 'skills')
  const disabled = getDisabledProfileSkills(profileDir)
  const out: ProfileSkillRuntimeEntry[] = []
  const visit = (dir: string, depth: number) => {
    if (depth > 4) return
    for (const entry of safeListDirents(dir)) {
      if (!isDirectoryLikeSync(dir, entry) || entry.name.startsWith('.')) continue
      const child = join(dir, entry.name)
      const skillPath = join(child, 'SKILL.md')
      if (existsSync(skillPath)) {
        const text = readSmallText(skillPath)
        const meta = parseSkillFrontmatter(text)
        const name = String(meta.name || entry.name).trim()
        if (!name || disabled.has(name)) continue
        out.push({
          name,
          slug: normalizeProfileSkillSlug(name),
          description: String(meta.description || '').trim(),
          dir: child,
          text,
        })
      } else {
        visit(child, depth + 1)
      }
    }
  }
  visit(root, 0)
  return out
}

function isDirectoryLikeSync(parentDir: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return statSync(join(parentDir, entry.name)).isDirectory()
  } catch {
    return false
  }
}

function parseSkillFrontmatter(text: string): Record<string, any> {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return {}
  try {
    return (yaml.load(match[1]) as Record<string, any>) || {}
  } catch {
    return {}
  }
}

function getDisabledProfileSkills(profileDir: string): Set<string> {
  const configPath = join(profileDir, 'config.yaml')
  try {
    const cfg = yaml.load(readSmallText(configPath)) as any
    return new Set((Array.isArray(cfg?.skills?.disabled) ? cfg.skills.disabled : []).map((item: unknown) => String(item)))
  } catch {
    return new Set()
  }
}

function normalizeProfileSkillSlug(value: string): string {
  return value.toLowerCase().replace(/[_\s]+/g, '-').replace(/[^a-z0-9-]+/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

function safeListDirents(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function readSmallText(path: string): string {
  try {
    const stat = existsSync(path) ? readFileSync(path, 'utf-8') : ''
    return stat.length > 256_000 ? stat.slice(0, 256_000) : stat
  } catch {
    return ''
  }
}

export function buildRunBrokerHeaders(options: { runBrokerKey?: string; ownerOpenId?: string; agentId?: string }): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const key = options.runBrokerKey?.trim()
  const ownerOpenId = options.ownerOpenId?.trim()
  const agentId = options.agentId?.trim()
  if (key) headers.Authorization = `Bearer ${key}`
  if (ownerOpenId) {
    headers['X-Hermes-Owner-Open-Id'] = ownerOpenId
    headers['X-Hermes-Feishu-OpenId'] = ownerOpenId
  }
  if (agentId) headers['X-Hermes-Agent-Id'] = agentId
  return headers
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

function summarizeToolArguments(args: string): string | undefined {
  if (!args) return undefined
  try {
    const parsed = JSON.parse(args)
    if (!parsed || typeof parsed !== 'object') return args.slice(0, 120)
    const preferredKeys = ['cmd', 'command', 'code', 'query', 'path', 'url', 'prompt']
    for (const key of preferredKeys) {
      const value = parsed[key]
      if (typeof value === 'string' && value.trim()) {
        return value.replace(/\s+/g, ' ').slice(0, 160)
      }
    }
    const first = Object.entries(parsed).find(([, value]) => typeof value === 'string' && value.trim())
    if (first) return String(first[1]).replace(/\s+/g, ' ').slice(0, 160)
    return JSON.stringify(parsed).slice(0, 160)
  } catch {
    return args.replace(/\s+/g, ' ').slice(0, 160)
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

export type HandleBrokerRunContext = {
  sessionMap: Map<string, SessionState>
  getOrCreateSession: (sessionId: string) => SessionState
  getResponseRunState: (state: SessionState, runMarker?: string) => ResponseRunState
  markCompleted: (socket: Socket, sessionId: string, info: { event: string; run_id?: string }) => Promise<void>
  dequeueNextQueuedRun: (socket: Socket, sessionId: string) => void
  buildInput: (input: string | ContentBlock[], profile: string) => Promise<any>
}

export async function handleBrokerRun(
  socket: Socket,
  data: { input: string | ContentBlock[]; session_id?: string; model?: string; provider?: string; instructions?: string },
  profile: string,
  runMarker: string | undefined,
  emit: (event: string, payload: any) => void,
  context: HandleBrokerRunContext,
) {
  const { input, session_id, model, provider, instructions } = data
  const brokerUrl = config.runBrokerUrl
  if (!brokerUrl) {
    const queueLen = session_id ? context.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
    if (session_id) await context.markCompleted(socket, session_id, { event: 'run.failed' })
    emit('run.failed', {
      event: 'run.failed',
      error: 'HERMES_RUN_BROKER_URL is required when HERMES_WEBUI_RUN_BROKER=1',
      queue_remaining: queueLen,
    })
    return
  }

  const ownerOpenId = (socket.data?.user?.openid as string | undefined)?.trim()
  const sessionRow = session_id ? getSession(session_id) : null
  const request = await buildRunBrokerRequest({
    input,
    profile,
    ownerOpenId,
    sessionId: session_id,
    model,
    provider,
    instructions,
    workspace: sessionRow?.workspace || null,
    messages: session_id ? context.sessionMap.get(session_id)?.messages || [] : [],
    profileDir: getProfileDir(profile),
    buildInput: context.buildInput,
    appendInputToMessages: false,
  })

  const abortController = new AbortController()
  if (session_id) {
    const state = context.getOrCreateSession(session_id)
    state.isWorking = true
    state.runId = undefined
    state.abortController = abortController
    context.getResponseRunState(state, runMarker)
  }

  try {
    const res = await fetch(`${brokerUrl}/api/run-broker/runs`, {
      method: 'POST',
      headers: buildRunBrokerHeaders({
        runBrokerKey: config.runBrokerKey,
        ownerOpenId,
      }),
      body: JSON.stringify(request),
      signal: abortController.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const queueLen = session_id ? context.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
      if (session_id) await context.markCompleted(socket, session_id, { event: 'run.failed' })
      emit('run.failed', { event: 'run.failed', error: `Run broker ${res.status}: ${text}`, queue_remaining: queueLen })
      if (session_id && queueLen > 0) context.dequeueNextQueuedRun(socket, session_id)
      return
    }
    if (!res.body) {
      const queueLen = session_id ? context.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
      if (session_id) await context.markCompleted(socket, session_id, { event: 'run.failed' })
      emit('run.failed', { event: 'run.failed', error: 'Run broker response stream missing', queue_remaining: queueLen })
      if (session_id && queueLen > 0) context.dequeueNextQueuedRun(socket, session_id)
      return
    }

    let runId: string | undefined
    let finalText = ''
    for await (const frame of readSseFrames(res.body)) {
      let parsed: any
      try {
        parsed = JSON.parse(frame.data)
      } catch {
        continue
      }
      const mapped = mapRunBrokerFrameForChat(parsed, frame.event)
      if (mapped.type === 'ignore') continue

      if (mapped.type === 'emit') {
        const eventRunId = mapped.payload.run_id || mapped.payload.response_id
        if (eventRunId) runId = String(eventRunId)
        if (mapped.appendFinalText) finalText += mapped.payload.delta || ''

        if (session_id) {
          const state = context.sessionMap.get(session_id)
          if (state) {
            const run = context.getResponseRunState(state, runMarker)
            run.responseId = runId || run.responseId
            const now = Math.floor(Date.now() / 1000)

            if (mapped.event === 'message.delta' && mapped.persistAssistantContent) {
              const deltaText = mapped.payload.delta || ''
              const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
              if (last?.role === 'assistant' && last.finish_reason == null && !last.tool_calls?.length) {
                last.content += deltaText
              } else {
                state.messages.push({
                  id: state.messages.length + 1,
                  session_id,
                  runMarker,
                  role: 'assistant',
                  content: deltaText,
                  timestamp: now,
                })
              }
            }

            if (mapped.event === 'reasoning.delta') {
              const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
              if (last?.role === 'assistant' && last.finish_reason == null && !last.tool_calls?.length) {
                last.reasoning = (last.reasoning || '') + (mapped.payload.delta || '')
              } else {
                state.messages.push({
                  id: state.messages.length + 1,
                  session_id,
                  runMarker,
                  role: 'assistant',
                  content: '',
                  reasoning: mapped.payload.delta || '',
                  timestamp: now,
                })
              }
            }

            if (mapped.event === 'tool.started') {
              const callId = mapped.payload.tool_call_id
              if (callId) {
                const toolCall = {
                  id: callId,
                  type: 'function',
                  function: {
                    name: mapped.payload.name || mapped.payload.tool || 'tool',
                    arguments: mapped.payload.arguments || '{}',
                  },
                }
                run.toolCalls.set(callId, toolCall)
                const key = `assistant:${callId}`
                if (!run.insertedKeys.has(key)) {
                  run.insertedKeys.add(key)
                  state.messages.push({
                    id: state.messages.length + 1,
                    session_id,
                    runMarker,
                    role: 'assistant',
                    content: '',
                    tool_calls: [toolCall],
                    finish_reason: 'tool_calls',
                    timestamp: now,
                  })
                } else {
                  const existingAssistant = [...state.messages]
                    .reverse()
                    .find((message: any) => message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.some((call: any) => call.id === callId))
                  const existingToolCalls = Array.isArray(existingAssistant?.tool_calls) ? existingAssistant.tool_calls : null
                  if (existingAssistant && existingToolCalls) {
                    existingAssistant.tool_calls = existingToolCalls.map((call: any) => {
                      if (call.id !== callId) return call
                      const previousArgs = call.function?.arguments || '{}'
                      const nextArgs = toolCall.function.arguments || '{}'
                      return hasUsefulToolArguments(nextArgs) && !hasUsefulToolArguments(previousArgs) ? toolCall : call
                    })
                  }
                }
              }
            }

            if (mapped.event === 'tool.completed') {
              const callId = mapped.payload.tool_call_id
              const key = callId ? `tool:${callId}` : `tool:${state.messages.length + 1}`
              const output = typeof mapped.payload.output === 'string'
                ? mapped.payload.output
                : JSON.stringify(mapped.payload.output ?? '')
              if (!run.insertedKeys.has(key)) {
                run.insertedKeys.add(key)
                const toolName = mapped.payload.name || mapped.payload.tool || run.toolCalls.get(callId)?.function?.name || null
                state.messages.push({
                  id: state.messages.length + 1,
                  session_id,
                  runMarker,
                  role: 'tool',
                  content: output,
                  tool_call_id: callId || null,
                  tool_name: toolName,
                  timestamp: now,
                })
              }
            }
          }
        }

        emit(mapped.event, mapped.payload)
        continue
      }

      if (mapped.type === 'terminal') {
        const eventRunId = mapped.payload.run_id || mapped.payload.response_id
        if (eventRunId) runId = String(eventRunId)
        const queueLen = session_id ? context.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
        if (session_id) await context.markCompleted(socket, session_id, { event: mapped.event, run_id: runId })
        emit(mapped.event, {
          ...mapped.payload,
          output: mapped.payload.output || finalText,
          queue_remaining: queueLen,
        })
        if (session_id && queueLen > 0) context.dequeueNextQueuedRun(socket, session_id)
        return
      }
    }

    const queueLen = session_id ? context.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
    if (session_id) await context.markCompleted(socket, session_id, { event: 'run.failed', run_id: runId })
    emit('run.failed', {
      event: 'run.failed',
      run_id: runId,
      response_id: runId,
      error: 'Run broker stream ended without a terminal event',
      queue_remaining: queueLen,
    })
    if (session_id && queueLen > 0) context.dequeueNextQueuedRun(socket, session_id)
  } catch (err: any) {
    const queueLen = session_id ? context.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
    if (session_id) await context.markCompleted(socket, session_id, { event: 'run.failed' })
    emit('run.failed', {
      event: 'run.failed',
      error: err?.name === 'AbortError' ? 'aborted' : err?.message || String(err),
      queue_remaining: queueLen,
    })
    if (session_id && queueLen > 0) context.dequeueNextQueuedRun(socket, session_id)
  }
}
