import type { Socket } from 'socket.io'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import type { Dirent } from 'fs'
import { join } from 'path'
import yaml from 'js-yaml'
import { getSystemPrompt } from '../../../lib/llm-prompt'
import { getSession, getSessionIncarnation, getSessionRowId, updateSession } from '../../../db/hermes/session-store'
import { config } from '../../../config'
import {
  interruptUnfinishedSubagentSnapshots,
  isReplayableSubagentEvent,
  replayableSubagentEvents,
  RUN_TERMINAL_EVENTS,
  subagentReplayKey,
  subagentSnapshotSupersedes,
} from './subagent-replay'
import { logger } from '../../logger'
import { getProfileDir } from '../hermes-profile'
import { listSkillCredentialStatuses } from '../skill-credentials'
import { buildBrokerMessagesForSession, contentBlocksToBrokerText } from './content-blocks'
import { readSseFrames } from './sse-utils'
import type { ContentBlock, ResponseRunState, SessionMessage, SessionState } from './types'
import type { SourceRef } from '../../../db/hermes/session-store'
import { authorizeSourceRefs, normalizeSourceRefs } from '../source-refs'
import { ensureHermesRunWorkspace, normalizeHermesSessionWorkspace } from './workspace'
import { resolveRunReasoningEffort } from './reasoning-effort'
import { completeWorkspaceRunCheckpoint, discardWorkspaceRunCheckpoint, startWorkspaceRunCheckpoint, type WorkspaceRunCheckpointHandle } from './workspace-diff-tracker'

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

export interface BrokerSessionCommandResult {
  ok?: boolean
  handled?: boolean
  profile_name?: string
  session_id?: string
  command?: string
  type?: string
  action?: string
  message?: string
  kickoff_prompt?: string
  clear_goal_continuations?: boolean
  max_turns?: number | null
  history_count?: number
  [key: string]: unknown
}

export interface BrokerGoalEvaluateResult {
  ok?: boolean
  handled?: boolean
  active?: boolean
  status?: string
  should_continue?: boolean
  continuation_prompt?: string
  verdict?: string
  reason?: string
  message?: string
  [key: string]: unknown
}

type BuildRunBrokerRequestOptions = {
  input: string | ContentBlock[]
  profile: string
  ownerOpenId?: string
  sessionId?: string
  model?: string
  provider?: string
  agentId?: string
  /** Active expert overlay id (专家广场). Forwarded into the broker request
   *  body (`expert_id`) and metadata so the multitenancy layer can inject the
   *  expert persona overlay for this run only. */
  expertId?: string
  projectId?: string
  /** Per-session reasoning-effort override (core's parse_reasoning_effort
   *  vocabulary). Rides in `metadata`, NOT at the request top level: metadata
   *  already carries model / provider / expert_id, reaches the broker as
   *  `event.raw_event.metadata`, and is what the multitenancy layer reads —
   *  the broker's frozen RunRequest would reject an unknown top-level field.
   *  The key is absent entirely when unset, so the profile default applies. */
  reasoningEffort?: string
  instructions?: string
  workspace?: string | null
  workspacePath?: string | null
  messages?: SessionMessage[]
  profileDir?: string
  idempotencyKey?: string
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

const BROKER_SESSION_COMMANDS = new Set(['new', 'reset', 'status', 'plan', 'goal', 'subgoal'])

export function resolveProjectRunBinding(
  session: Pick<NonNullable<ReturnType<typeof getSession>>, 'project_id' | 'project_bound' | 'message_count'> | null,
  requestedProjectId: unknown,
  requestedWorkspace: string | null,
): { projectId?: string; workspace: string | null; persistProjectId: boolean } {
  const requested = typeof requestedProjectId === 'string' ? requestedProjectId.trim() : ''
  const stored = session?.project_id?.trim() || ''
  if (session?.project_bound && (!stored || (requested && requested !== stored))) {
    throw new Error('Session is already bound to a different Project')
  }
  if (stored && requested && requested !== stored) {
    throw new Error('Session Project cannot be changed')
  }
  if (!stored && requested && (session?.message_count || 0) > 1) {
    throw new Error('Project cannot be added after the first turn')
  }
  const projectId = stored || requested || undefined
  return {
    projectId,
    workspace: projectId ? null : requestedWorkspace,
    persistProjectId: Boolean(requested && !stored),
  }
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
    expertId,
    projectId,
    reasoningEffort,
    instructions,
    workspace,
    workspacePath = workspace,
    idempotencyKey,
    messages = [],
    buildInput,
    appendInputToMessages = true,
  } = options
  const userKey = ownerOpenId?.trim() || profile
  let content = contentBlocksToBrokerText(input).trim()
  const skillRuntime = options.profileDir ? buildProfileSkillRuntimeContext(options.profileDir, content, sessionId) : null
  if (skillRuntime?.content) content = skillRuntime.content
  const metadata: Record<string, any> = {
    source: 'hermes-web-ui',
  }
  if (model) metadata.model = model
  if (provider) metadata.provider = provider
  if (expertId) metadata.expert_id = expertId
  if (reasoningEffort) metadata.reasoning_effort = reasoningEffort
  if (sessionId) metadata.conversation = `webui:${sessionId}`
  metadata.instructions = [
    getSystemPrompt(),
    instructions,
    skillRuntime?.instructions,
  ].filter(Boolean).join('\n')

  if (workspacePath) {
    const workspaceCtx = `[Current working directory: ${workspacePath}]`
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
    ...(expertId ? { expert_id: expertId } : {}),
    ...(projectId ? { project_id: projectId } : {}),
    user_key: userKey,
    content,
    session_id: sessionId,
    ...(workspace ? { workspace } : {}),
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
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

export function parseBrokerSessionCommand(input: string | ContentBlock[]): { raw: string; name: string; args: string } | null {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (!raw.startsWith('/')) return null
  const match = raw.match(/^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  const name = match[1].toLowerCase().replace(/_/g, '-')
  if (!BROKER_SESSION_COMMANDS.has(name)) return null
  return { raw, name, args: (match[2] || '').trim() }
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
  const haystack = `${skill.name}\n${skill.description}\n${skill.text}`.toLowerCase()
  const input = inputText.toLowerCase()
  if (skill.name === 'meegle') {
    return /飞书项目|meegle|meego|project\.feishu\.cn|工作项/.test(input)
  }
  if (!isPreloadProfileSkill(skill)) return false
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

export function buildRunBrokerHeaders(options: { runBrokerKey?: string; ownerOpenId?: string; agentId?: string; expertId?: string; executionEngine?: 'hermes' | 'harness' }): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const key = options.runBrokerKey?.trim()
  const ownerOpenId = options.ownerOpenId?.trim()
  const agentId = options.agentId?.trim()
  const expertId = options.expertId?.trim()
  if (key) headers.Authorization = `Bearer ${key}`
  if (ownerOpenId) {
    headers['X-Hermes-Owner-Open-Id'] = ownerOpenId
    headers['X-Hermes-Feishu-OpenId'] = ownerOpenId
  }
  if (agentId) headers['X-Hermes-Agent-Id'] = agentId
  if (expertId) headers['X-Hermes-Expert-Id'] = expertId
  if (options.executionEngine === 'harness') headers['X-Hermes-Expert-Engine'] = 'harness'
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

export function mapRunBrokerFrameForChat(
  parsed: any,
  frameEvent?: string,
  fallbackRunId?: string,
): RunBrokerChatFrameMapping {
  const payload = parsed?.payload || {}
  const brokerKind = parsed?.kind || parsed?.event || frameEvent
  const runId = parsed?.run_id || parsed?.runId || payload.run_id || fallbackRunId
  const responseId = runId

  if (brokerKind === 'workflow_stage' || brokerKind === 'workflow.stage') {
    const stage = String(parsed?.stage || payload.stage || '').trim()
    if (!stage) return { type: 'ignore' }
    return {
      type: 'emit',
      event: 'workflow.stage',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: {
        event: 'workflow.stage',
        run_id: runId,
        response_id: responseId,
        stage,
        status: String(parsed?.status || payload.status || ''),
        summary: String(parsed?.summary || payload.summary || ''),
        related_ids: parsed?.related_ids || payload.related_ids || {},
        audit_id: String(parsed?.audit_id || payload.audit_id || ''),
      },
    }
  }

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

  // TRAE-style inline authorization: a tool needs the user to grant a CLI
  // credential mid-run. The broker owns the whole handshake (it is the only
  // thing that can mint a verification URL); the frames it streams carry no
  // token, no open_id, no profile and no URL — only an opaque authorization_id
  // plus the service and scopes we are allowed to show. This is deliberately
  // NOT the `auth.required` / `credential.replay` path: nothing here resurrects
  // a parked run.
  if (brokerKind === 'authorization_required' || brokerKind === 'authorization.required') {
    const authorizationId = parsed?.authorization_id || payload.authorization_id
    if (!authorizationId) return { type: 'ignore' }
    const scopes = Array.isArray(parsed?.scopes)
      ? parsed.scopes
      : (Array.isArray(payload.scopes) ? payload.scopes : [])
    return {
      type: 'emit',
      event: 'authorization.required',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: {
        event: 'authorization.required',
        run_id: runId,
        response_id: responseId,
        authorization_id: String(authorizationId),
        service: String(parsed?.service || payload.service || ''),
        scopes: scopes.map((scope: unknown) => String(scope)),
        expires_at: Number(parsed?.expires_at ?? payload.expires_at ?? 0) || 0,
        state: String(parsed?.state || payload.state || 'pending'),
      },
    }
  }

  if (brokerKind === 'authorization_resolved' || brokerKind === 'authorization.resolved') {
    const authorizationId = parsed?.authorization_id || payload.authorization_id
    if (!authorizationId) return { type: 'ignore' }
    return {
      type: 'emit',
      event: 'authorization.resolved',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: {
        event: 'authorization.resolved',
        run_id: runId,
        response_id: responseId,
        authorization_id: String(authorizationId),
        service: String(parsed?.service || payload.service || ''),
        state: String(parsed?.state || payload.state || ''),
        reason: String(parsed?.reason || payload.reason || ''),
      },
    }
  }

  if (brokerKind === 'approval_required' || brokerKind === 'approval.requested') {
    const approvalId = parsed?.approval_id || payload.approval_id
    if (!approvalId) return { type: 'ignore' }
    return {
      type: 'emit',
      event: 'approval.requested',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: {
        event: 'approval.requested',
        run_id: runId,
        response_id: responseId,
        approval_id: String(approvalId),
        command: String(parsed?.command || payload.command || ''),
        description: String(parsed?.description || payload.description || ''),
        choices: ['once', 'deny'],
        allow_permanent: false,
      },
    }
  }

  if (brokerKind === 'approval_resolved' || brokerKind === 'approval.resolved') {
    const approvalId = parsed?.approval_id || payload.approval_id
    if (!approvalId) return { type: 'ignore' }
    return {
      type: 'emit',
      event: 'approval.resolved',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: {
        event: 'approval.resolved',
        run_id: runId,
        response_id: responseId,
        approval_id: String(approvalId),
        choice: parsed?.choice ?? payload.choice,
        timed_out: parsed?.timed_out ?? payload.timed_out,
      },
    }
  }

  if (brokerKind === 'heartbeat' || brokerKind === 'harness_heartbeat') {
    return {
      type: 'emit',
      event: 'run.status',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: {
        event: 'run.status',
        run_id: runId,
        response_id: responseId,
        text: String(parsed?.text || payload.text || ''),
      },
    }
  }

  if (brokerKind === 'gate_required') {
    const approvalId = parsed?.approval_id || payload.approval_id
    if (!approvalId) return { type: 'ignore' }
    return {
      type: 'emit',
      event: 'approval.requested',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: {
        event: 'approval.requested',
        run_id: runId,
        response_id: responseId,
        approval_id: String(approvalId),
        gate: String(parsed?.gate || payload.gate || ''),
        checklist: Array.isArray(parsed?.checklist) ? parsed.checklist : (Array.isArray(payload.checklist) ? payload.checklist : []),
        command: String(parsed?.command || payload.command || `Gate ${parsed?.gate || payload.gate || ''}`),
        description: String(parsed?.description || payload.description || ''),
        choices: ['approve', 'reject', 'rework'],
        allow_permanent: false,
      },
    }
  }

  if (brokerKind === 'gate_resolved') {
    const approvalId = parsed?.approval_id || payload.approval_id
    if (!approvalId) return { type: 'ignore' }
    return {
      type: 'emit',
      event: 'approval.resolved',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: {
        event: 'approval.resolved',
        run_id: runId,
        response_id: responseId,
        approval_id: String(approvalId),
        choice: parsed?.decision ?? payload.decision,
      },
    }
  }

  if (brokerKind === 'auth_required') {
    // A connector's credential expired mid-run. The broker parked the original
    // request keyed by run_id + exposes a replay endpoint; surface a structured
    // event so the chat UI renders an inline re-auth card instead of leaving the
    // failure as free-form assistant text.
    const credentialKind = String(parsed?.credential_kind || payload.credential_kind || '')
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
        provider: String(parsed?.provider || payload.provider || (credentialKind ? 'harness' : '')),
        workflow_id: String(parsed?.workflow_id || payload.workflow_id || ''),
        credential_kind: credentialKind,
      },
    }
  }

  if (brokerKind === 'auth_resolved') {
    const credentialKind = String(parsed?.credential_kind || payload.credential_kind || '')
    return {
      type: 'emit',
      event: 'auth.resolved',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: {
        event: 'auth.resolved',
        run_id: runId,
        response_id: responseId,
        connector_id: String(parsed?.connector_id || payload.connector_id || ''),
        workflow_id: String(parsed?.workflow_id || payload.workflow_id || ''),
        credential_kind: credentialKind,
      },
    }
  }

  if (brokerKind === 'done' || brokerKind === 'run.completed') {
    const sourceRefs = normalizeSourceRefs(parsed?.source_refs) as SourceRef[]
    return {
      type: 'terminal',
      event: 'run.completed',
      payload: {
        event: 'run.completed',
        run_id: runId,
        response_id: responseId,
        output: parsed?.text || payload.output,
        usage: payload.usage ?? parsed?.usage,
        ...(sourceRefs?.length ? { source_refs: sourceRefs } : {}),
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

  // Subagent telemetry. The broker (MT) re-emits core's own event names
  // (`subagent.start|spawn_requested|tool|progress|complete|text|thinking`)
  // as SSE kinds, so the chat UI can render the same `delegate_task` card it
  // already renders in bridge mode. The client store matches on the event name
  // and field names only (`stores/hermes/chat.ts` handleSubagentEvent), so the
  // key set here must stay identical to the bridge payload built in
  // `handle-bridge-run.ts` — otherwise the two modes render differently.
  if (typeof brokerKind === 'string' && brokerKind.startsWith('subagent.')) {
    const subagentId = parsed?.subagent_id ?? payload.subagent_id
    const toolName = payload.tool_name ?? parsed?.name ?? payload.tool ?? payload.name
    const text = parsed?.text ?? payload.text ?? ''
    const summary = parsed?.summary ?? payload.summary
    const durationSeconds = parsed?.duration_seconds ?? payload.duration_seconds
    return {
      type: 'emit',
      event: brokerKind,
      appendFinalText: false,
      persistAssistantContent: false,
      payload: {
        event: brokerKind,
        run_id: runId,
        response_id: responseId,
        subagent_id: subagentId,
        parent_id: parsed?.parent_id ?? payload.parent_id,
        depth: parsed?.depth ?? payload.depth,
        task_index: parsed?.task_index ?? payload.task_index,
        task_count: parsed?.task_count ?? payload.task_count,
        goal: parsed?.goal ?? payload.goal,
        model: parsed?.model ?? payload.model,
        toolsets: parsed?.toolsets ?? payload.toolsets,
        tool_count: parsed?.tool_count ?? payload.tool_count,
        child_session_id: parsed?.child_session_id ?? payload.child_session_id,
        delegation_id: parsed?.delegation_id ?? payload.delegation_id,
        tool: toolName,
        name: toolName,
        preview: text || summary || payload.tool_preview || parsed?.preview || payload.preview || '',
        text,
        status: parsed?.status ?? payload.status,
        summary,
        duration: durationSeconds,
        duration_seconds: durationSeconds,
        input_tokens: parsed?.input_tokens ?? payload.input_tokens,
        output_tokens: parsed?.output_tokens ?? payload.output_tokens,
        reasoning_tokens: parsed?.reasoning_tokens ?? payload.reasoning_tokens,
        api_calls: parsed?.api_calls ?? payload.api_calls,
        cost_usd: parsed?.cost_usd ?? payload.cost_usd,
        files_read: parsed?.files_read ?? payload.files_read,
        files_written: parsed?.files_written ?? payload.files_written,
        output_tail: parsed?.output_tail ?? payload.output_tail,
        // The broker clamps `text`, `args` and `summary` to keep one NDJSON
        // line readable by the parent. Without these markers a clipped summary
        // renders as if it were the whole result, so the card cannot tell the
        // user that something was cut.
        text_truncated: parsed?.text_truncated ?? payload.text_truncated,
        args_truncated: parsed?.args_truncated ?? payload.args_truncated,
        args_bytes: parsed?.args_bytes ?? payload.args_bytes,
        summary_truncated: parsed?.summary_truncated ?? payload.summary_truncated,
      },
    }
  }

  return { type: 'ignore' }
}

export function rememberBrokerWorkflowEvent(
  state: Pick<SessionState, 'events'>,
  event: string,
  data: any,
): void {
  // Subagent cards must survive an F5 mid-delegation, and the in-run reconnect
  // path needs them re-emitted (see subagent-replay.ts). Keep exactly one frame
  // per card: newest wins, except that a completed card is terminal — a late
  // `subagent.tool` must not drag it back to "running". Frames with no client
  // listener (`text` / `thinking` / `spawn_requested`) stream live but are not
  // remembered, so they can never displace a completion either.
  //
  // The update happens IN PLACE. Deleting and re-pushing would reorder cards
  // (start A, start B, complete A replays as B then A) and the client renders
  // replayed cards in the order it receives them.
  if (event.startsWith('subagent.')) {
    if (!isReplayableSubagentEvent(event)) return
    const key = subagentReplayKey(data)
    const index = state.events.findIndex(item => (
      String(item.event || '').startsWith('subagent.') && subagentReplayKey(item.data) === key
    ))
    if (index < 0) {
      // First frame for this card owns its position and its timestamp; the
      // client uses created_at so a replayed card keeps its original place in
      // the transcript instead of jumping to "now".
      state.events.push({ event, data: { ...data, created_at: data?.created_at ?? Date.now() } })
      return
    }
    const previous = state.events[index]
    if (!subagentSnapshotSupersedes(String(previous.event || ''), event)) return
    state.events[index] = {
      event,
      data: { ...data, created_at: previous.data?.created_at ?? data?.created_at ?? Date.now() },
    }
    return
  }

  // The parent run ended. Any card still short of its own completion was cut
  // off with it, so store it as terminal now — otherwise every later resume
  // replays a card that will never finish as "running".
  if (RUN_TERMINAL_EVENTS.has(event)) {
    interruptUnfinishedSubagentSnapshots(
      state.events,
      String(data?.run_id || data?.response_id || ''),
    )
    return
  }
  if (event === 'workflow.stage') {
    state.events = state.events.filter(item => item.event !== event)
    state.events.push({ event, data })
    return
  }
  if (event === 'approval.requested') {
    const approvalId = String(data?.approval_id || '')
    state.events = state.events.filter(item => (
      item.event !== event || String(item.data?.approval_id || '') !== approvalId
    ))
    state.events.push({ event, data })
    return
  }
  if (event === 'approval.resolved') {
    const approvalId = String(data?.approval_id || '')
    state.events = state.events.filter(item => (
      item.event !== 'approval.requested' || String(item.data?.approval_id || '') !== approvalId
    ))
    return
  }
  if (event === 'auth.required') {
    const workflowId = String(data?.workflow_id || '')
    state.events = state.events.filter(item => (
      item.event !== event || String(item.data?.workflow_id || '') !== workflowId
    ))
    state.events.push({ event, data })
    return
  }
  if (event === 'auth.resolved') {
    const workflowId = String(data?.workflow_id || '')
    state.events = state.events.filter(item => (
      item.event !== 'auth.required' || String(item.data?.workflow_id || '') !== workflowId
    ))
    return
  }
  // Inline authorization must survive an F5 — clarify famously does not, because
  // it has no branch here. Keyed by authorization_id so two concurrent requests
  // in one session do not clobber each other.
  if (event === 'authorization.required') {
    const authorizationId = String(data?.authorization_id || '')
    state.events = state.events.filter(item => (
      item.event !== event || String(item.data?.authorization_id || '') !== authorizationId
    ))
    state.events.push({ event, data })
    return
  }
  if (event === 'authorization.resolved') {
    const authorizationId = String(data?.authorization_id || '')
    state.events = state.events.filter(item => (
      item.event !== 'authorization.required' || String(item.data?.authorization_id || '') !== authorizationId
    ))
  }
}

export async function fetchBrokerHarnessWorkflowSnapshot(options: {
  socket: Socket
  profile: string
  sessionId: string
  agentId?: string
}): Promise<any> {
  if (!config.runBrokerUrl) throw new Error('HERMES_RUN_BROKER_URL is required when HERMES_WEBUI_RUN_BROKER=1')
  const ownerOpenId = String(options.socket.data?.user?.openid || options.socket.data?.user?.id || '').trim()
  if (!ownerOpenId) throw new Error('owner identity is required for Harness workflow restore')
  const res = await fetch(`${config.runBrokerUrl}/api/run-broker/harness/workflows/by-session`, {
    method: 'POST',
    headers: buildRunBrokerHeaders({
      runBrokerKey: config.runBrokerKey,
      ownerOpenId,
      agentId: options.agentId,
    }),
    body: JSON.stringify({
      profile_name: options.profile,
      session_id: options.sessionId,
      action: 'snapshot',
    }),
  })
  if (!res.ok) throw new Error(`Harness workflow snapshot failed (${res.status})`)
  return await res.json()
}

export async function respondToBrokerClarify(options: {
  socket: Socket
  profile: string
  agentId?: string
  sessionId: string
  clarifyId: string
  response: string
}): Promise<void> {
  const brokerUrl = config.runBrokerUrl
  if (!brokerUrl) throw new Error('HERMES_RUN_BROKER_URL is required when HERMES_WEBUI_RUN_BROKER=1')
  const ownerOpenId = String(options.socket.data?.user?.openid || options.socket.data?.user?.id || '').trim()
  if (!ownerOpenId) throw new Error('owner identity is required for clarify response')
  const res = await fetch(`${brokerUrl}/api/run-broker/clarify/${encodeURIComponent(options.clarifyId)}/respond`, {
    method: 'POST',
    headers: buildRunBrokerHeaders({
      runBrokerKey: config.runBrokerKey,
      ownerOpenId,
      agentId: options.agentId,
    }),
    body: JSON.stringify({
      profile_name: options.profile,
      ...(options.agentId ? { agent_id: options.agentId } : {}),
      session_id: options.sessionId,
      response: options.response,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Run broker clarify ${res.status}: ${text}`)
  }
}

export async function respondToBrokerApproval(options: {
  socket: Socket
  profile: string
  agentId?: string
  sessionId: string
  approvalId: string
  choice: string
  comment?: string
}): Promise<void> {
  const brokerUrl = config.runBrokerUrl
  if (!brokerUrl) throw new Error('HERMES_RUN_BROKER_URL is required when HERMES_WEBUI_RUN_BROKER=1')
  const ownerOpenId = String(options.socket.data?.user?.openid || options.socket.data?.user?.id || '').trim()
  if (!ownerOpenId) throw new Error('owner identity is required for approval response')
  const res = await fetch(`${brokerUrl}/api/run-broker/approval/${encodeURIComponent(options.approvalId)}/respond`, {
    method: 'POST',
    headers: buildRunBrokerHeaders({
      runBrokerKey: config.runBrokerKey,
      ownerOpenId,
      agentId: options.agentId,
    }),
    body: JSON.stringify({
      profile_name: options.profile,
      ...(options.agentId ? { agent_id: options.agentId } : {}),
      session_id: options.sessionId,
      choice: options.choice,
      comment: options.comment || '',
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Run broker approval ${res.status}: ${text}`)
  }
}

export type BrokerAuthorizationAction = 'authorize' | 'confirm' | 'cancel'

export interface BrokerAuthorizationResult {
  ok?: boolean
  authorization_id?: string
  /** Only ever produced by the broker — the WebUI never builds an auth URL. */
  verification_uri?: string
  state?: string
  reason?: string
  [key: string]: unknown
}

/**
 * Drive one step of the inline authorization handshake on the broker.
 *
 * `authorize` asks for the verification URL, `confirm` polls whether the user
 * finished, `cancel` withdraws the request. Deliberately mirrors
 * respondToBrokerClarify (same owner-open-id requirement, same body shape); it
 * shares nothing with the credential.replay run-resurrection path.
 *
 * A 404/409 means the request is gone/consumed/expired: it throws so the caller
 * can surface a terminal failure rather than spinning a retry loop. The broker's
 * response body is intentionally NOT folded into the error — it can echo request
 * detail, and this string reaches the browser.
 */
export async function respondToBrokerAuthorization(options: {
  socket: Socket
  profile: string
  agentId?: string
  sessionId: string
  authorizationId: string
  action: BrokerAuthorizationAction
}): Promise<BrokerAuthorizationResult> {
  const brokerUrl = config.runBrokerUrl
  if (!brokerUrl) throw new Error('HERMES_RUN_BROKER_URL is required when HERMES_WEBUI_RUN_BROKER=1')
  const ownerOpenId = String(options.socket.data?.user?.openid || options.socket.data?.user?.id || '').trim()
  if (!ownerOpenId) throw new Error('owner identity is required for authorization response')
  const res = await fetch(
    `${brokerUrl}/api/run-broker/authorization/${encodeURIComponent(options.authorizationId)}/${options.action}`,
    {
      method: 'POST',
      headers: buildRunBrokerHeaders({
        runBrokerKey: config.runBrokerKey,
        ownerOpenId,
        agentId: options.agentId,
      }),
      body: JSON.stringify({
        profile_name: options.profile,
        ...(options.agentId ? { agent_id: options.agentId } : {}),
        session_id: options.sessionId,
      }),
    },
  )
  if (!res.ok) {
    throw new Error(`Run broker authorization ${res.status}`)
  }
  const body = await res.json().catch(() => ({}))
  return (body && typeof body === 'object' ? body : {}) as BrokerAuthorizationResult
}

export async function resumeBrokerHarnessCredential(options: {
  socket: Socket
  profile: string
  agentId?: string
  sessionId: string
  workflowId: string
  credentialKind: string
  connectorId: string
}): Promise<void> {
  const brokerUrl = config.runBrokerUrl
  if (!brokerUrl) throw new Error('HERMES_RUN_BROKER_URL is required when HERMES_WEBUI_RUN_BROKER=1')
  const ownerOpenId = String(options.socket.data?.user?.openid || options.socket.data?.user?.id || '').trim()
  if (!ownerOpenId) throw new Error('owner identity is required for Harness credential resume')
  const connectorId = String(options.connectorId || '').trim()
  if (!connectorId) throw new Error('Harness connector id is required')
  const statuses = await listSkillCredentialStatuses({
    profileName: options.profile,
    profileDir: getProfileDir(options.profile),
    user: options.socket.data?.user,
  })
  if (!statuses.credentials.some(entry => (
    entry.id === connectorId && entry.status === 'authenticated'
  ))) {
    throw new Error('Harness connector is not authenticated')
  }
  const res = await fetch(`${brokerUrl}/api/run-broker/harness/workflows/${encodeURIComponent(options.workflowId)}`, {
    method: 'POST',
    headers: buildRunBrokerHeaders({
      runBrokerKey: config.runBrokerKey,
      ownerOpenId,
      agentId: options.agentId,
    }),
    body: JSON.stringify({
      profile_name: options.profile,
      session_id: options.sessionId,
      action: 'resume_credential',
      credential_kind: options.credentialKind,
      connector_id: connectorId,
      credential_verified: true,
    }),
  })
  if (!res.ok) throw new Error(`Harness credential resume failed (${res.status})`)
}

export async function runBrokerSessionCommand(options: {
  socket: Socket
  profile: string
  agentId?: string
  expertId?: string
  sessionId: string
  command: string
  signal?: AbortSignal
}): Promise<BrokerSessionCommandResult> {
  const brokerUrl = config.runBrokerUrl
  if (!brokerUrl) throw new Error('HERMES_RUN_BROKER_URL is required when HERMES_WEBUI_RUN_BROKER=1')
  const ownerOpenId = String(options.socket.data?.user?.openid || options.socket.data?.user?.id || '').trim()
  if (!ownerOpenId) throw new Error('owner identity is required for session command')
  const res = await fetch(`${brokerUrl}/api/run-broker/session-commands`, {
    method: 'POST',
    headers: buildRunBrokerHeaders({
      runBrokerKey: config.runBrokerKey,
      ownerOpenId,
      agentId: options.agentId,
      expertId: options.expertId,
    }),
    body: JSON.stringify({
      profile_name: options.profile,
      ...(options.agentId ? { agent_id: options.agentId } : {}),
      ...(options.expertId ? { expert_id: options.expertId } : {}),
      session_id: options.sessionId,
      command: options.command,
    }),
    signal: options.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Run broker session command ${res.status}: ${text}`)
  }
  return await res.json() as BrokerSessionCommandResult
}

export async function runBrokerGoalEvaluate(options: {
  socket: Socket
  profile: string
  agentId?: string
  sessionId: string
  finalResponse: string
  signal?: AbortSignal
}): Promise<BrokerGoalEvaluateResult> {
  const brokerUrl = config.runBrokerUrl
  if (!brokerUrl) throw new Error('HERMES_RUN_BROKER_URL is required when HERMES_WEBUI_RUN_BROKER=1')
  const ownerOpenId = String(options.socket.data?.user?.openid || options.socket.data?.user?.id || '').trim()
  if (!ownerOpenId) throw new Error('owner identity is required for goal evaluation')
  const res = await fetch(`${brokerUrl}/api/run-broker/goals/evaluate`, {
    method: 'POST',
    headers: buildRunBrokerHeaders({
      runBrokerKey: config.runBrokerKey,
      ownerOpenId,
      agentId: options.agentId,
    }),
    body: JSON.stringify({
      profile_name: options.profile,
      ...(options.agentId ? { agent_id: options.agentId } : {}),
      session_id: options.sessionId,
      final_response: options.finalResponse,
    }),
    signal: options.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Run broker goal evaluate ${res.status}: ${text}`)
  }
  return await res.json() as BrokerGoalEvaluateResult
}

export type HandleBrokerRunContext = {
  sessionMap: Map<string, SessionState>
  getResponseRunState: (state: SessionState, runMarker?: string) => ResponseRunState
  recordParkedCredentialRun: (state: SessionState, sessionId: string, payload: any) => any
  markCompleted: (
    socket: Socket,
    sessionId: string,
    state: SessionState,
    runMarker: string | undefined,
    info: { event: string; run_id?: string; final_response?: string },
    isCurrent: () => boolean,
    persist: boolean,
    pendingFailure?: string,
  ) => Promise<{ finalized: boolean; error?: string; aborted?: boolean; pendingEventId?: string }>
  abandonRun: (sessionId: string, state: SessionState, runMarker: string | undefined) => boolean
  dequeueNextQueuedRun: (socket: Socket, sessionId: string, state: SessionState) => boolean
  buildInput: (input: string | ContentBlock[], profile: string) => Promise<any>
  publishRunAssistantMedia?: (
    sessionId: string,
    runMarker: string | undefined,
    profile: string,
    fallbackContent: string,
  ) => string | undefined
}

export function appendBrokerFailureMessage(
  context: HandleBrokerRunContext,
  sessionId: string | undefined,
  runMarker: string | undefined,
  error: string,
) {
  if (!sessionId) return
  const state = context.sessionMap.get(sessionId)
  if (!state) return
  const alreadyHasRunOutput = state.messages.some(message => (
    message.runMarker === runMarker && message.role !== 'user'
  ))
  if (alreadyHasRunOutput) return

  const run = context.getResponseRunState(state, runMarker)
  const detail = error.trim() || 'Run broker failed'
  const content = `运行失败：${detail.slice(0, 2000)}`
  // Stamp run_id at creation: this message is appended AFTER the terminal
  // event's stamping loop ran, so it would otherwise stay unmatched and the
  // socket-resume path would hydrate it without run_id (workspace diff chips
  // vanish on reload of the just-failed session).
  state.messages.push({
    id: state.messages.length + 1,
    session_id: sessionId,
    runMarker,
    run_id: run.responseId || runMarker,
    role: 'assistant',
    content,
    finish_reason: 'error',
    timestamp: Math.floor(Date.now() / 1000),
  })
}

export async function handleBrokerRun(
  socket: Socket,
  data: { input: string | ContentBlock[]; session_id?: string; model?: string; provider?: string; workspace?: string | null; instructions?: string; expert_id?: string; project_id?: string; execution_engine?: 'hermes' | 'harness'; replay_run_id?: string; reasoning_effort?: string },
  profile: string,
  runMarker: string | undefined,
  emit: (event: string, payload: any) => void,
  context: HandleBrokerRunContext,
) {
  const { input, session_id, model, provider, instructions, expert_id } = data
  // handleRun already acquired, generation-validated, and marked the exact
  // state. Reuse it at the handoff instead of repeating DB identity getters
  // outside this handler's fail-safe try.
  const state = session_id ? context.sessionMap.get(session_id) : undefined
  const abortController = new AbortController()
  if (state) {
    state.isWorking = true
    state.events = replayableSubagentEvents(state.events, { interrupted: true })
    state.activeRunMarker = runMarker
    state.runId = runMarker
    state.abortController = abortController
    context.getResponseRunState(state, runMarker).responseId = runMarker
  }
  const isCurrentRun = () => !session_id || Boolean(
    state
    && context.sessionMap.get(session_id) === state
    && state.activeRunMarker === runMarker,
  )
  let identityError: unknown
  const abandonStaleRunSafely = () => {
    try {
      return abandonStaleRun()
    } catch (err) {
      identityError = err
      return false
    }
  }
  const finishRun = async (info: { event: string; run_id?: string; final_response?: string }) => {
    if (!identityError && abandonStaleRunSafely()) return false
    if (!session_id || !state) return true
    interruptUnfinishedSubagentSnapshots(state.events, info.run_id || state.runId)
    const identityFailure = () => identityError instanceof Error
      ? identityError.message
      : identityError == null ? undefined : String(identityError)
    let result = await context.markCompleted(
      socket,
      session_id,
      state,
      runMarker,
      info,
      () => {
        const generationChanged = sessionGenerationChanged()
        return !identityError && !generationChanged
      },
      !identityError,
      identityFailure(),
    )
    if (!result.finalized && identityError && isCurrentRun()) {
      result = await context.markCompleted(socket, session_id, state, runMarker, info, () => true, false, identityFailure())
    }
    if (!result.finalized) {
      if (!identityError) abandonStaleRunSafely()
      return false
    }
    if (result.error) {
      const queueLen = queueLength()
      emit('run.failed', {
        event: 'run.failed',
        error: result.error,
        queue_remaining: queueLen,
        ...(result.pendingEventId ? { resume_event_id: result.pendingEventId } : {}),
      })
      dequeueNext()
      return false
    }
    if (result.aborted) {
      dequeueNext()
      return false
    }
    return true
  }
  const queueLength = () => session_id && state && context.sessionMap.get(session_id) === state
    ? state.queue.length
    : 0
  const dequeueNext = () => {
    if (session_id && state && state.queue.length > 0) {
      context.dequeueNextQueuedRun(socket, session_id, state)
    }
  }
  const appendFailure = (error: string) => {
    if (!isCurrentRun() || identityError || state?.isAborting) return
    const generationChanged = sessionGenerationChanged()
    if (!identityError && !generationChanged) appendBrokerFailureMessage(context, session_id, runMarker, error)
  }

  // Replay mode: re-run the request the broker parked under this run_id after a
  // credential expiry. We hit the broker's replay endpoint (no request body —
  // the broker holds the original) and relay its frames back over THIS socket,
  // reusing the identical SSE→map→emit machinery a normal run uses so the
  // replayed answer streams into the same chat session.
  const replayRunId = typeof data.replay_run_id === 'string' ? data.replay_run_id.trim() : ''
  const isReplay = replayRunId.length > 0
  let replayRejected = false
  const rejectReplay = () => {
    if (!isReplay || replayRejected || !session_id) return
    replayRejected = true
    socket.emit('run.reattach_failed', {
      event: 'run.reattach_failed',
      session_id,
      run_id: replayRunId,
      terminal: true,
      error: 'Session no longer exists',
      message: 'Replay failed because this session was deleted or replaced.',
    })
  }
  const brokerUrl = config.runBrokerUrl
  const ownerOpenId = String(socket.data?.user?.openid || socket.data?.user?.id || '').trim()
  const agentId = (socket.data?.agentId as string | undefined)?.trim()
  let workspace: string | null = null
  let sessionWorkspace: string | null = null
  let projectIdForRun: string | undefined
  let workspaceDiffRunId = runMarker || ''
  let workspaceDiffCompleted = false
  let workspaceDiffCheckpoint: WorkspaceRunCheckpointHandle | null = null
  let sessionRow: ReturnType<typeof getSession> = null
  let workspaceDiffSessionRowId: number | null = null
  let workspaceDiffSessionIncarnation: number | null = null
  let identityCaptured = false
  const sessionGenerationChanged = () => {
    if (!identityCaptured || identityError || !session_id) return false
    try {
      return getSessionRowId(session_id) !== workspaceDiffSessionRowId
        || getSessionIncarnation(session_id) !== workspaceDiffSessionIncarnation
    } catch (err) {
      identityError = err
      return false
    }
  }
  const abandonStaleRun = () => {
    if (!session_id || !state) return false
    if (isCurrentRun()) {
      const generationChanged = sessionGenerationChanged()
      if (identityError) throw identityError
      if (!generationChanged) return false
    }
    discardWorkspaceRunCheckpoint({ sessionId: session_id, checkpoint: workspaceDiffCheckpoint })
    context.abandonRun(session_id, state, runMarker)
    rejectReplay()
    return true
  }
  const emitWorkspaceDiffCompleted = async () => {
    if (!session_id || !workspace || !workspaceDiffCheckpoint || workspaceDiffCompleted) return
    workspaceDiffCompleted = true
    try {
      const change = await completeWorkspaceRunCheckpoint({
        sessionId: session_id,
        runId: workspaceDiffRunId,
        workspace,
        checkpoint: workspaceDiffCheckpoint,
      })
      if (abandonStaleRun()) return
      if (change) emit('workspace.diff.completed', { event: 'workspace.diff.completed', ...change })
    } catch (err) {
      logger.warn({ err, sessionId: session_id, workspace }, '[workspace-diff] failed to complete broker checkpoint')
    }
  }

  try {
    if (!brokerUrl) throw new Error('HERMES_RUN_BROKER_URL is required when HERMES_WEBUI_RUN_BROKER=1')
    try {
      sessionRow = session_id ? getSession(session_id) : null
      workspaceDiffSessionRowId = session_id ? getSessionRowId(session_id) : null
      workspaceDiffSessionIncarnation = session_id ? getSessionIncarnation(session_id) : null
      identityCaptured = true
    } catch (err) {
      identityError = err
      throw err
    }
    // getSession() looks a session up by id ALONE — the sessions table has a profile
    // column but no query filters on it. Without this fence a socket authenticated as
    // profile B could pass profile A's session_id and write into A's transcript, adopt
    // A's persisted model/provider, and inherit A's workspace below. Fail closed before
    // any message write or broker fetch. Strict equality is safe for shared agents:
    // the socket middleware already resolves socket.data.profile to the SHARED profile
    // (broker-controller.ts sharedAgentProfile / ownerOwnsProfile), so legitimate shared
    // access arrives with the owner's profile. Legacy rows are safe too — both the row
    // mapper and createSession default a blank profile to 'default'.
    if (sessionRow && sessionRow.profile !== profile) {
      logger.warn(
        { sessionId: session_id, sessionProfile: sessionRow.profile, socketProfile: profile },
        '[broker-run] rejected cross-profile session access',
      )
      if (session_id && state) context.abandonRun(session_id, state, runMarker)
      rejectReplay()
      socket.emit('run.rejected', {
        event: 'run.rejected',
        session_id,
        error: 'Session belongs to a different profile',
      })
      return
    }
    if (isReplay && (!sessionRow || workspaceDiffSessionRowId == null || workspaceDiffSessionIncarnation == null)) {
      if (session_id && state) context.abandonRun(session_id, state, runMarker)
      rejectReplay()
      return
    }
    let projectBinding
    try {
      projectBinding = resolveProjectRunBinding(sessionRow, data.project_id, data.workspace || null)
    } catch (err) {
      if (session_id && state) context.abandonRun(session_id, state, runMarker)
      socket.emit('run.rejected', {
        event: 'run.rejected',
        session_id,
        error: err instanceof Error ? err.message : 'Invalid Project binding',
      })
      return
    }
    projectIdForRun = projectBinding.projectId
    if (!isReplay && session_id && sessionRow && projectBinding.persistProjectId) {
      updateSession(session_id, { project_id: projectIdForRun || null, project_bound: false })
      sessionRow = { ...sessionRow, project_id: projectIdForRun || null }
    }
    // The STORED binding always wins; `data.workspace` can only ever bind a session
    // that has none. Gating the payload on message_count looks tempting here and is
    // wrong: the controller persists the first user message BEFORE dispatch
    // (broker-controller.ts, "Write user message to local DB immediately"), so on a
    // brand-new session's first turn the row already reads message_count=1 and the
    // freshly picked workspace — which lives only in this payload — would be dropped.
    sessionWorkspace = (!isReplay && session_id)
      ? await normalizeHermesSessionWorkspace(profile, sessionRow?.workspace || projectBinding.workspace)
      : null
    workspace = (!isReplay && session_id)
      ? await ensureHermesRunWorkspace(profile, sessionWorkspace)
      : null
    if (abandonStaleRun()) return
    // `sessionWorkspace` is forced to null on a replay (the binding is not
    // re-resolved there), so writing it back would erase the session's workspace.
    if (!isReplay && session_id && sessionRow && sessionRow.workspace !== sessionWorkspace) {
      updateSession(session_id, { workspace: sessionWorkspace })
    }
    // Harness owns an isolated per-workflow clone. Scanning the profile workspace
    // here would attribute files from unrelated historical runs to this answer.
    workspaceDiffCheckpoint = session_id && workspace && sessionRow?.execution_engine !== 'harness'
      ? await startWorkspaceRunCheckpoint({ sessionId: session_id, workspace })
      : null
    if (abandonStaleRun()) return
    if (abortController.signal.aborted) throw new DOMException('aborted', 'AbortError')
    // The chat header's model choice is persisted on the session row, but the client
    // only sends model/provider on the session's first turn. Without this fallback every
    // later turn reaches the gateway with no model and silently drops back to the
    // profile default. Fall back to the STORED PAIR (never mix request provider with
    // session model); no validation here on purpose — an invalid model must fail loudly
    // at the gateway rather than be silently swapped.
    const useSessionModel = !model && !!sessionRow?.model
    const runModel = useSessionModel ? sessionRow!.model : model
    const runProvider = useSessionModel ? (sessionRow!.provider || undefined) : provider
    const request = isReplay ? null : await buildRunBrokerRequest({
      input,
      profile,
      ownerOpenId,
      agentId,
      expertId: expert_id,
      projectId: projectIdForRun,
      sessionId: session_id,
      model: runModel,
      provider: runProvider,
      // Shared with the bridge path; '' (cleared) beats the row, and
      // buildRunBrokerRequest drops the key when the result is empty.
      reasoningEffort: resolveRunReasoningEffort(data.reasoning_effort, sessionRow?.reasoning_effort),
      instructions,
      workspace: projectIdForRun ? null : sessionWorkspace,
      workspacePath: workspace,
      messages: state?.messages || [],
      profileDir: getProfileDir(profile),
      idempotencyKey: runMarker ? `webui:${session_id || 'no-session'}:${runMarker}` : undefined,
      buildInput: context.buildInput,
      appendInputToMessages: false,
    })
    if (abandonStaleRun()) return
    if (abortController.signal.aborted) throw new DOMException('aborted', 'AbortError')
    const res = isReplay
      ? await fetch(`${brokerUrl}/api/run-broker/credentials/replay/${encodeURIComponent(replayRunId)}`, {
        method: 'POST',
        headers: buildRunBrokerHeaders({
          runBrokerKey: config.runBrokerKey,
          ownerOpenId,
          agentId,
          expertId: expert_id,
          executionEngine: sessionRow?.execution_engine,
        }),
        signal: abortController.signal,
      })
      : await fetch(`${brokerUrl}/api/run-broker/runs`, {
        method: 'POST',
        headers: buildRunBrokerHeaders({
          runBrokerKey: config.runBrokerKey,
          ownerOpenId,
          agentId,
          expertId: expert_id,
          executionEngine: sessionRow?.execution_engine,
        }),
        body: JSON.stringify(request),
        signal: abortController.signal,
      })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const error = `Run broker ${res.status}: ${text}`
      await emitWorkspaceDiffCompleted()
      appendFailure(error)
      if (!(await finishRun({ event: 'run.failed' }))) return
      const queueLen = queueLength()
      emit('run.failed', { event: 'run.failed', error, queue_remaining: queueLen })
      dequeueNext()
      return
    }
    if (!isReplay && session_id && projectIdForRun) {
      try {
        const receiptResponse = await fetch(
          `${brokerUrl}/api/run-broker/sessions/${encodeURIComponent(session_id)}/project`,
          {
            headers: buildRunBrokerHeaders({
              runBrokerKey: config.runBrokerKey,
              ownerOpenId,
              agentId,
              expertId: expert_id,
              executionEngine: sessionRow?.execution_engine,
            }),
            signal: abortController.signal,
          },
        )
        if (!receiptResponse.ok) throw new Error(`receipt ${receiptResponse.status}`)
        const payload = await receiptResponse.json() as { receipt?: Record<string, unknown> }
        const receipt = payload.receipt || {}
        updateSession(session_id, {
          project_id: typeof receipt.project_id === 'string' ? receipt.project_id : null,
          project_name: typeof receipt.project_name === 'string' ? receipt.project_name : null,
          project_bound: true,
          workspace: typeof receipt.workspace === 'string' ? receipt.workspace : null,
        })
        emit('project.bound', { event: 'project.bound', receipt })
      } catch (err) {
        logger.warn({ err, sessionId: session_id }, '[chat-run-socket] project receipt read-back failed')
      }
    }
    if (!res.body) {
      const error = 'Run broker response stream missing'
      await emitWorkspaceDiffCompleted()
      appendFailure(error)
      if (!(await finishRun({ event: 'run.failed' }))) return
      const queueLen = queueLength()
      emit('run.failed', { event: 'run.failed', error, queue_remaining: queueLen })
      dequeueNext()
      return
    }

    let runId: string | undefined
    let finalText = ''
    for await (const frame of readSseFrames(res.body)) {
      if (abandonStaleRun()) return
      let parsed: any
      try {
        parsed = JSON.parse(frame.data)
      } catch {
        continue
      }
      const mapped = mapRunBrokerFrameForChat(parsed, frame.event, runMarker)
      if (mapped.type === 'ignore') continue

      if (mapped.type === 'emit') {
        const eventRunId = mapped.payload.run_id || mapped.payload.response_id
        if (eventRunId) runId = String(eventRunId)
        if (eventRunId) workspaceDiffRunId = String(eventRunId)
        if (mapped.appendFinalText) finalText += mapped.payload.delta || ''

        if (session_id) {
          const currentState = isCurrentRun() ? state : undefined
          if (currentState) {
            const run = context.getResponseRunState(currentState, runMarker)
            run.responseId = runId || run.responseId
            currentState.runId = run.responseId || runMarker
            if (runId) {
              for (const message of currentState.messages) {
                if (message.runMarker === runMarker) message.run_id = runId
              }
            }
            const now = Math.floor(Date.now() / 1000)

            if (mapped.event === 'auth.required' && !mapped.payload.workflow_id) {
              mapped.payload = context.recordParkedCredentialRun(currentState, session_id, mapped.payload)
            }
            rememberBrokerWorkflowEvent(currentState, mapped.event, mapped.payload)

            if (mapped.event === 'message.delta' && mapped.persistAssistantContent) {
              const deltaText = mapped.payload.delta || ''
              const last = [...currentState.messages].reverse().find(m => m.runMarker === runMarker)
              if (last?.role === 'assistant' && last.finish_reason == null && !last.tool_calls?.length) {
                last.run_id = last.run_id || run.responseId || null
                last.content += deltaText
              } else {
                currentState.messages.push({
                  id: currentState.messages.length + 1,
                  session_id,
                  runMarker,
                  run_id: run.responseId || null,
                  role: 'assistant',
                  content: deltaText,
                  timestamp: now,
                })
              }
            }

            if (mapped.event === 'reasoning.delta') {
              const last = [...currentState.messages].reverse().find(m => m.runMarker === runMarker)
              if (last?.role === 'assistant' && last.finish_reason == null && !last.tool_calls?.length) {
                last.run_id = last.run_id || run.responseId || null
                last.reasoning = (last.reasoning || '') + (mapped.payload.delta || '')
              } else {
                currentState.messages.push({
                  id: currentState.messages.length + 1,
                  session_id,
                  runMarker,
                  run_id: run.responseId || null,
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
                  currentState.messages.push({
                    id: currentState.messages.length + 1,
                    session_id,
                    runMarker,
                    run_id: run.responseId || null,
                    role: 'assistant',
                    content: '',
                    tool_calls: [toolCall],
                    finish_reason: 'tool_calls',
                    timestamp: now,
                  })
                } else {
                  const existingAssistant = [...currentState.messages]
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
              const key = callId ? `tool:${callId}` : `tool:${currentState.messages.length + 1}`
              const output = typeof mapped.payload.output === 'string'
                ? mapped.payload.output
                : JSON.stringify(mapped.payload.output ?? '')
              if (!run.insertedKeys.has(key)) {
                run.insertedKeys.add(key)
                const toolName = mapped.payload.name || mapped.payload.tool || run.toolCalls.get(callId)?.function?.name || null
                currentState.messages.push({
                  id: currentState.messages.length + 1,
                  session_id,
                  runMarker,
                  run_id: run.responseId || null,
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
        if (eventRunId) workspaceDiffRunId = String(eventRunId)
        let clientSourceRefs: SourceRef[] = []
        if (session_id && runId) {
          const currentState = isCurrentRun() ? state : undefined
          if (currentState) {
            // Settle the run's subagent cards before anything else can resume:
            // a card that never reported completion was cut off with the run.
            rememberBrokerWorkflowEvent(currentState, mapped.event, mapped.payload)
            currentState.runId = runId
            context.getResponseRunState(currentState, runMarker).responseId = runId
            for (const message of currentState.messages) {
              if (message.runMarker === runMarker) message.run_id = runId
            }
            if (mapped.event === 'run.completed' && mapped.payload.source_refs?.length) {
              let finalAssistant = [...currentState.messages].reverse().find(message => (
                message.runMarker === runMarker
                && message.role === 'assistant'
                && !message.tool_calls?.length
                && Boolean(message.content?.trim())
              ))
              const completedOutput = String(mapped.payload.output || finalText || '').trim()
              if (!finalAssistant && completedOutput) {
                finalAssistant = {
                  id: currentState.messages.length + 1,
                  session_id,
                  runMarker,
                  run_id: runId,
                  role: 'assistant',
                  content: completedOutput,
                  timestamp: Math.floor(Date.now() / 1000),
                }
                currentState.messages.push(finalAssistant)
              }
              if (finalAssistant) {
                finalAssistant.source_refs = mapped.payload.source_refs
                const authorized = await authorizeSourceRefs({
                  profile,
                  ownerOpenId: ownerOpenId || '',
                  messages: currentState.messages,
                })
                clientSourceRefs = authorized.get(String(finalAssistant.id)) || []
              }
            }
          }
        }
        if (mapped.event === 'run.completed' && isCurrentRun()) {
          const finalMessage = [...(state?.messages || [])].reverse().find(message => (
            message.runMarker === runMarker
            && message.role === 'assistant'
            && String(message.content || '').trim()
            && !message.tool_calls?.length
          ))
          if (finalMessage && finalMessage.finish_reason == null) finalMessage.finish_reason = 'stop'
        }
        const rawOutput = String(mapped.payload.output || finalText || '')
        const parsedContent = mapped.event === 'run.completed' && session_id
          ? context.publishRunAssistantMedia?.(session_id, runMarker, profile, rawOutput)
          : undefined
        const output = parsedContent ?? rawOutput
        await emitWorkspaceDiffCompleted()
        if (mapped.event === 'run.failed') {
          appendFailure(mapped.payload.error || output || 'Run broker failed')
        }
        if (!(await finishRun({
          event: mapped.event,
          run_id: runId,
          final_response: output,
        }))) return
        const queueLen = queueLength()
        emit(mapped.event, {
          ...mapped.payload,
          ...(mapped.event === 'run.completed' ? { source_refs: clientSourceRefs } : {}),
          ...(parsedContent !== undefined ? { parsed_content: parsedContent } : {}),
          output,
          queue_remaining: queueLen,
        })
        dequeueNext()
        return
      }
    }

    const error = 'Run broker stream ended without a terminal event'
    await emitWorkspaceDiffCompleted()
    appendFailure(error)
    if (!(await finishRun({ event: 'run.failed', run_id: runId }))) return
    const queueLen = queueLength()
    emit('run.failed', {
      event: 'run.failed',
      run_id: runId,
      response_id: runId,
      error,
      queue_remaining: queueLen,
    })
    dequeueNext()
  } catch (err: any) {
    if (!identityError && abandonStaleRunSafely()) return
    const error = err?.name === 'AbortError' ? 'aborted' : err?.message || String(err)
    await emitWorkspaceDiffCompleted()
    appendFailure(error)
    if (!(await finishRun({ event: 'run.failed' }))) return
    const queueLen = queueLength()
    emit('run.failed', {
      event: 'run.failed',
      error,
      queue_remaining: queueLen,
    })
    dequeueNext()
  }
}
