import type { ChildProcess, ExecFileOptions } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { logger } from '../logger'
import { execHermes, spawnHermes } from './hermes-process'
import { detectHermesRootHome } from './hermes-path'

const execOpts = { windowsHide: true }
const BOARD_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const NO_WORKER_LOG_PATTERNS = [
  /^\(no log for [^)]+?\s+—\s+task may not have spawned yet\)$/i,
  /^no worker log(?: for [^\n]+)?$/i,
]

export function normalizeBoardSlug(board?: string | null): string {
  if (board === undefined || board === null) return 'default'
  const trimmed = board.trim().toLowerCase()
  if (!trimmed) throw new Error('Invalid kanban board slug')
  if (!BOARD_SLUG_RE.test(trimmed)) {
    throw new Error('Invalid kanban board slug')
  }
  return trimmed
}

function boardArgs(board?: string | null): string[] {
  return ['kanban', '--board', normalizeBoardSlug(board)]
}

// ─── Types ──────────────────────────────────────────────────────

export type KanbanTaskStatus = 'triage' | 'todo' | 'scheduled' | 'ready' | 'running' | 'blocked' | 'review' | 'done' | 'archived'

export interface KanbanTask {
  id: string
  title: string
  body: string | null
  assignee: string | null
  status: KanbanTaskStatus
  priority: number
  created_by: string | null
  created_at: number
  started_at: number | null
  completed_at: number | null
  workspace_kind: string
  workspace_path: string | null
  tenant: string | null
  result: string | null
  skills: string[] | null
  // Present on hermes-agent 0.21.3 `kanban list/show/create --json` payloads.
  branch_name?: string | null
  project_id?: string | null
  session_id?: string | null
  workflow_template_id?: string | null
  current_step_key?: string | null
  completion_contract?: string | null
  model_override?: string | null
  provider_override?: string | null
  max_retries?: number | null
  last_failure_error?: string | null
  // Added to task payloads by hermes-agent 0.21.4.
  max_runtime_seconds?: number | null
  // Persisted by core but not emitted on 0.21.3 task payloads; kept optional so
  // a future core that does emit it round-trips instead of being dropped.
  goal_mode?: boolean
}

export interface KanbanRun {
  id: number
  task_id: string
  profile: string | null
  status: string
  started_at: number
  ended_at: number | null
  outcome: string | null
  summary: string | null
  error: string | null
}

export interface KanbanComment {
  id: number | string
  task_id: string
  author: string
  body: string
  created_at: number
}

export interface KanbanEvent {
  id: number | string
  task_id: string
  kind: string
  payload: Record<string, unknown> | null
  created_at: number
  run_id: number | null
}

export interface KanbanTaskDetail {
  task: KanbanTask
  comments: KanbanComment[]
  events: KanbanEvent[]
  runs: KanbanRun[]
}

export interface KanbanStats {
  by_status: Record<string, number>
  by_assignee: Record<string, number>
  total: number
}

export interface KanbanAssignee {
  name: string
  on_disk: boolean
  counts: Record<string, number> | null
}

export interface KanbanBoard {
  slug: string
  name: string
  description: string
  icon: string
  color: string
  created_at: number | null
  archived: boolean
  default_workdir?: string | null
  project_id?: string | null
  db_path?: string
  is_current?: boolean
  counts: Record<string, number>
  total: number
}

export interface KanbanBoardCreateOptions {
  slug: string
  name?: string
  description?: string
  icon?: string
  color?: string
  switchCurrent?: boolean
}

export interface KanbanCapabilities {
  source: 'hermes-cli'
  supports: Record<string, boolean>
  missing: string[]
  capabilities: KanbanCapabilityStatus[]
}

export interface KanbanTaskLog {
  task_id: string
  path: string | null
  exists: boolean
  size_bytes: number
  content: string
  truncated: boolean
}

export interface KanbanCapabilityStatus {
  key: string
  status: 'supported' | 'partial' | 'missing'
  reason?: string
  canonicalRoute?: string
  canonicalCommand?: string
  requiresBoard: boolean
}

export interface KanbanBoardOptions {
  board?: string
}

export interface KanbanWatchOptions extends KanbanBoardOptions {
  interval?: number
}

export interface KanbanBulkTaskUpdateOptions extends KanbanBoardOptions {
  ids: string[]
  status?: KanbanTaskStatus
  assignee?: string | null
  archive?: boolean
  summary?: string
  reason?: string
  operatorOverride?: boolean
}

export interface KanbanBulkTaskResult {
  id: string
  ok: boolean
  error?: string
}

export interface KanbanBulkTaskUpdateResult {
  results: KanbanBulkTaskResult[]
}

// ─── CLI wrappers ───────────────────────────────────────────────

export async function listBoards(opts?: { includeArchived?: boolean }): Promise<KanbanBoard[]> {
  const args = ['kanban', 'boards', 'list', '--json']
  if (opts?.includeArchived) args.push('--all')

  try {
    const { stdout } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return JSON.parse(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban boards list failed')
    throw new Error(`Failed to list kanban boards: ${err.message}`)
  }
}

async function findBoard(slug: string, includeArchived = true): Promise<KanbanBoard | null> {
  const boards = await listBoards({ includeArchived })
  return boards.find(board => board.slug === slug) || null
}

export async function createBoard(opts: KanbanBoardCreateOptions): Promise<KanbanBoard> {
  const slug = normalizeBoardSlug(opts.slug)
  const args = ['kanban', 'boards', 'create', slug]
  if (opts.name?.trim()) args.push('--name', opts.name.trim())
  if (opts.description?.trim()) args.push('--description', opts.description.trim())
  if (opts.icon?.trim()) args.push('--icon', opts.icon.trim())
  if (opts.color?.trim()) args.push('--color', opts.color.trim())
  if (opts.switchCurrent) args.push('--switch')

  try {
    await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    const board = await findBoard(slug)
    if (!board) throw new Error('created board was not returned by boards list')
    return board
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban boards create failed')
    throw new Error(`Failed to create kanban board: ${err.message}`)
  }
}

export async function archiveBoard(slugInput: string): Promise<void> {
  const slug = normalizeBoardSlug(slugInput)
  if (slug === 'default') throw new Error('Cannot archive the default kanban board')

  try {
    await execHermes(['kanban', 'boards', 'rm', slug], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban boards archive failed')
    throw new Error(`Failed to archive kanban board: ${err.message}`)
  }
}

export async function getCapabilities(): Promise<KanbanCapabilities> {
  const capabilities: KanbanCapabilityStatus[] = [
    { key: 'explicitBoard', status: 'supported', canonicalCommand: '--board', requiresBoard: true },
    { key: 'boardsList', status: 'supported', canonicalRoute: '/boards', canonicalCommand: 'boards list', requiresBoard: false },
    { key: 'boardCreate', status: 'supported', canonicalRoute: '/boards', canonicalCommand: 'boards create', requiresBoard: false },
    { key: 'boardArchive', status: 'supported', canonicalRoute: '/boards/{slug}', canonicalCommand: 'boards rm', requiresBoard: false },
    { key: 'cliCurrentSwitch', status: 'partial', reason: 'Backend keeps explicit board context and does not expose a WUI route for mutating canonical CLI current board', canonicalRoute: '/boards/{slug}/switch', canonicalCommand: 'boards switch', requiresBoard: false },
    { key: 'taskCrudLite', status: 'supported', canonicalRoute: '/tasks', canonicalCommand: 'list/show/create/complete/block/unblock/assign', requiresBoard: true },
    { key: 'commentsWrite', status: 'supported', canonicalRoute: '/tasks/{task_id}/comments', canonicalCommand: 'comment', requiresBoard: true },
    { key: 'commentsRead', status: 'supported', reason: 'Comments are returned on task detail responses', canonicalRoute: '/tasks/{task_id}', canonicalCommand: 'show --json', requiresBoard: true },
    { key: 'taskLog', status: 'supported', canonicalRoute: '/tasks/{task_id}/log', canonicalCommand: 'log', requiresBoard: true },
    { key: 'diagnostics', status: 'supported', canonicalRoute: '/diagnostics', canonicalCommand: 'diagnostics', requiresBoard: true },
    { key: 'reclaim', status: 'supported', canonicalRoute: '/tasks/{task_id}/reclaim', canonicalCommand: 'reclaim', requiresBoard: true },
    { key: 'reassign', status: 'supported', canonicalRoute: '/tasks/{task_id}/reassign', canonicalCommand: 'reassign', requiresBoard: true },
    { key: 'specify', status: 'supported', canonicalRoute: '/tasks/{task_id}/specify', canonicalCommand: 'specify', requiresBoard: true },
    { key: 'dispatch', status: 'supported', canonicalRoute: '/dispatch', canonicalCommand: 'dispatch', requiresBoard: true },
    { key: 'links', status: 'supported', canonicalRoute: '/links', canonicalCommand: 'link/unlink', requiresBoard: true },
    { key: 'bulk', status: 'partial', reason: 'WUI applies supported bulk-equivalent CLI transitions per id and returns per-task outcomes; direct priority/status patch parity remains deferred', canonicalRoute: '/tasks/bulk', canonicalCommand: 'bulk-equivalent via complete/block/unblock/archive/assign', requiresBoard: true },
    { key: 'events', status: 'partial', reason: 'WUI exposes a board-scoped WebSocket bridge backed by the canonical `kanban watch` stream; payload is currently a refresh invalidation signal, not a typed event model', canonicalRoute: '/events', canonicalCommand: 'watch', requiresBoard: true },
    { key: 'homeSubscriptions', status: 'missing', reason: 'Deferred from current WUI parity batch', canonicalRoute: '/home-channels and subscription routes', canonicalCommand: 'notify-*', requiresBoard: true },
  ]
  const supports = Object.fromEntries(capabilities.map(capability => [capability.key, capability.status === 'supported'])) as Record<string, boolean>
  const missing = capabilities
    .filter(capability => capability.status !== 'supported')
    .map(capability => capability.key)
  return { source: 'hermes-cli', supports, missing, capabilities }
}

function parseJsonPayload(stdout: string): unknown[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed)
  if (Array.isArray(parsed)) return parsed
  return [parsed]
}

function isNoWorkerLogError(err: any): boolean {
  const lines = [err?.stderr, err?.stdout, err?.message]
    .filter(Boolean)
    .flatMap(value => String(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean))
  return lines.some(line => NO_WORKER_LOG_PATTERNS.some(pattern => pattern.test(line)))
}

function pushOptional(args: string[], flag: string, value?: string | number | null): void {
  if (value !== undefined && value !== null && String(value).trim() !== '') args.push(flag, String(value))
}

function textFromExecValue(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return value === undefined || value === null ? '' : String(value)
}

async function execKanbanMutation(
  args: string[],
  logMessage: string,
  errorPrefix: string,
  options: ExecFileOptions = {},
): Promise<string> {
  try {
    const { stdout, stderr } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
      ...options,
    })
    const stderrText = textFromExecValue(stderr).trim()
    if (stderrText) throw new Error(stderrText)
    return textFromExecValue(stdout)
  } catch (err: any) {
    logger.error(err, logMessage)
    throw new Error(`${errorPrefix}: ${cliFailureDetail(err)}`)
  }
}

// execFile rejects with a bare "Command failed: <the whole argv>" and parks the
// CLI's own explanation on err.stderr/err.stdout. Surfacing err.message alone
// therefore tells the operator nothing and echoes the full command line back to
// the client; prefer what the CLI actually said.
function cliFailureDetail(err: any): string {
  const streams = [err?.stderr, err?.stdout]
    .map(value => textFromExecValue(value).trim())
    .filter(Boolean)
  if (streams.length > 0) return streams.join(' | ')
  return String(err?.message || err)
}

export function buildWatchArgs(opts?: KanbanWatchOptions): string[] {
  const args = [...boardArgs(opts?.board), 'watch']
  pushOptional(args, '--interval', opts?.interval ?? 0.5)
  return args
}

export function watchEvents(opts?: KanbanWatchOptions): ChildProcess {
  return spawnHermes(buildWatchArgs(opts), {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...execOpts,
  })
}

export async function linkTasks(parentId: string, childId: string, opts?: KanbanBoardOptions): Promise<{ ok: boolean; output: string }> {
  const output = await execKanbanMutation(
    [...boardArgs(opts?.board), 'link', parentId, childId],
    'Hermes CLI: kanban link failed',
    'Failed to link kanban tasks',
  )
  return { ok: true, output }
}

export async function unlinkTasks(parentId: string, childId: string, opts?: KanbanBoardOptions): Promise<{ ok: boolean; output: string }> {
  const output = await execKanbanMutation(
    [...boardArgs(opts?.board), 'unlink', parentId, childId],
    'Hermes CLI: kanban unlink failed',
    'Failed to unlink kanban tasks',
  )
  return { ok: true, output }
}

export async function addComment(taskId: string, body: string, opts?: KanbanBoardOptions & { author?: string }): Promise<{ ok: boolean; output: string }> {
  const args = [...boardArgs(opts?.board), 'comment', taskId, body]
  pushOptional(args, '--author', opts?.author)
  try {
    const { stdout } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return { ok: true, output: stdout }
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban comment failed')
    throw new Error(`Failed to comment on kanban task: ${err.message}`)
  }
}

export async function getTaskLog(taskId: string, opts?: KanbanBoardOptions & { tail?: number }): Promise<KanbanTaskLog> {
  const args = [...boardArgs(opts?.board), 'log', taskId]
  pushOptional(args, '--tail', opts?.tail)
  try {
    const { stdout } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    const sizeBytes = Buffer.byteLength(stdout, 'utf8')
    return {
      task_id: taskId,
      path: null,
      exists: true,
      size_bytes: sizeBytes,
      content: stdout,
      truncated: opts?.tail !== undefined && sizeBytes >= opts.tail,
    }
  } catch (err: any) {
    const detail = await getTask(taskId, opts)
    if (!detail) throw new Error('Kanban task not found')
    if ((err.code === 1 || err.status === 1) && isNoWorkerLogError(err)) {
      return {
        task_id: taskId,
        path: null,
        exists: false,
        size_bytes: 0,
        content: '',
        truncated: false,
      }
    }
    logger.error(err, 'Hermes CLI: kanban log failed')
    throw new Error(`Failed to read kanban task log: ${err.message}`)
  }
}

export async function getDiagnostics(opts?: KanbanBoardOptions & { task?: string; severity?: string }): Promise<unknown[]> {
  const args = [...boardArgs(opts?.board), 'diagnostics', '--json']
  pushOptional(args, '--task', opts?.task)
  pushOptional(args, '--severity', opts?.severity)
  try {
    const { stdout } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    // hermes-agent 0.21.4 appends a home-scope row (`task_id: null`, carrying
    // `dispatch_profiles`) after the per-task rows. It describes the host, not a
    // task the caller owns, so it never reaches the API.
    const rows: unknown[] = JSON.parse(stdout)
    return rows.filter(row => !(row && typeof row === 'object' && (row as { task_id?: unknown }).task_id === null))
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban diagnostics failed')
    throw new Error(`Failed to get kanban diagnostics: ${err.message}`)
  }
}

export async function reclaimTask(taskId: string, opts?: KanbanBoardOptions & { reason?: string }): Promise<{ ok: boolean; output: string }> {
  const args = [...boardArgs(opts?.board), 'reclaim', taskId]
  pushOptional(args, '--reason', opts?.reason)
  try {
    const { stdout } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return { ok: true, output: stdout }
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban reclaim failed')
    throw new Error(`Failed to reclaim kanban task: ${err.message}`)
  }
}

export async function reassignTask(taskId: string, profile: string, opts?: KanbanBoardOptions & { reclaim?: boolean; reason?: string }): Promise<{ ok: boolean; output: string }> {
  const args = [...boardArgs(opts?.board), 'reassign', taskId, profile]
  if (opts?.reclaim) args.push('--reclaim')
  pushOptional(args, '--reason', opts?.reason)
  try {
    const { stdout } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return { ok: true, output: stdout }
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban reassign failed')
    throw new Error(`Failed to reassign kanban task: ${err.message}`)
  }
}

export async function specifyTask(taskId: string, opts?: KanbanBoardOptions & { author?: string }): Promise<unknown[]> {
  const args = [...boardArgs(opts?.board), 'specify', taskId, '--json']
  pushOptional(args, '--author', opts?.author)
  try {
    const { stdout } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return parseJsonPayload(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban specify failed')
    throw new Error(`Failed to specify kanban task: ${err.message}`)
  }
}

export async function dispatch(opts?: KanbanBoardOptions & { dryRun?: boolean; max?: number; failureLimit?: number }): Promise<unknown> {
  const args = [...boardArgs(opts?.board), 'dispatch', '--json']
  if (opts?.dryRun) args.push('--dry-run')
  pushOptional(args, '--max', opts?.max)
  pushOptional(args, '--failure-limit', opts?.failureLimit)
  try {
    const { stdout } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return JSON.parse(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban dispatch failed')
    throw new Error(`Failed to dispatch kanban tasks: ${err.message}`)
  }
}

export async function listTasks(opts?: {
  board?: string
  status?: string
  assignee?: string
  tenant?: string
  includeArchived?: boolean
}): Promise<KanbanTask[]> {
  const args = [...boardArgs(opts?.board), 'list', '--json']
  if (opts?.includeArchived) args.push('--archived')
  if (opts?.status) args.push('--status', opts.status)
  if (opts?.assignee) args.push('--assignee', opts.assignee)
  if (opts?.tenant) args.push('--tenant', opts.tenant)

  try {
    const { stdout } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return JSON.parse(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban list failed')
    throw new Error(`Failed to list kanban tasks: ${err.message}`)
  }
}

export async function getTask(taskId: string, opts?: KanbanBoardOptions): Promise<KanbanTaskDetail | null> {
  try {
    const { stdout } = await execHermes([...boardArgs(opts?.board), 'show', taskId, '--json'], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    const detail = JSON.parse(stdout) as KanbanTaskDetail
    // hermes-agent 0.21.3 `kanban show --json` emits comments/events without an
    // `id` or `task_id`. Synthesize stable ones so list keys stay unique.
    const resolvedTaskId = detail.task?.id || taskId
    detail.comments = (detail.comments || []).map((comment, index) => ({
      ...comment,
      id: comment.id ?? `${resolvedTaskId}:comment:${index}`,
      task_id: comment.task_id || resolvedTaskId,
    }))
    detail.events = (detail.events || []).map((event, index) => ({
      ...event,
      id: event.id ?? `${resolvedTaskId}:event:${index}`,
      task_id: event.task_id || resolvedTaskId,
    }))
    return detail
  } catch (err: any) {
    if (err.code === 1 || err.status === 1) return null
    logger.error(err, 'Hermes CLI: kanban show failed')
    throw new Error(`Failed to get kanban task: ${err.message}`)
  }
}

export async function createTask(
  title: string,
  opts?: {
    board?: string
    body?: string
    assignee?: string
    createdBy?: string
    priority?: number
    tenant?: string
    workspace?: string
    branch?: string
    triage?: boolean
    skills?: string[]
    maxRuntime?: string
    maxRetries?: number
    goalMode?: boolean
    goalMaxTurns?: number
  },
): Promise<KanbanTask> {
  const args = [...boardArgs(opts?.board), 'create', title, '--json']
  if (opts?.body) args.push('--body', opts.body)
  if (opts?.assignee) args.push('--assignee', opts.assignee)
  // Core defaults created_by to the literal "user", which fails every
  // owner check downstream. Always record a profile the owner actually owns.
  if (opts?.createdBy) args.push('--created-by', opts.createdBy)
  if (opts?.priority !== undefined) args.push('--priority', String(opts.priority))
  if (opts?.tenant) args.push('--tenant', opts.tenant)
  if (opts?.workspace) args.push('--workspace', opts.workspace)
  if (opts?.branch) args.push('--branch', opts.branch)
  if (opts?.triage) args.push('--triage')
  if (opts?.maxRuntime) args.push('--max-runtime', opts.maxRuntime)
  if (opts?.maxRetries !== undefined) args.push('--max-retries', String(opts.maxRetries))
  if (opts?.goalMode) args.push('--goal')
  if (opts?.goalMaxTurns !== undefined) args.push('--goal-max-turns', String(opts.goalMaxTurns))
  for (const skill of opts?.skills || []) {
    if (skill.trim()) args.push('--skill', skill.trim())
  }

  try {
    const { stdout } = await execHermes(args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return JSON.parse(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban create failed')
    throw new Error(`Failed to create kanban task: ${err.message}`)
  }
}

export async function completeTasks(
  taskIds: string[],
  summary?: string,
  opts?: KanbanBoardOptions & { operatorOverride?: boolean },
): Promise<void> {
  const args = [...boardArgs(opts?.board), 'complete', ...taskIds]
  if (summary) args.push('--summary', summary)

  if (!opts?.operatorOverride) {
    await execKanbanMutation(args, 'Hermes CLI: kanban complete failed', 'Failed to complete kanban tasks')
    return
  }

  // hermes-agent 0.21.4 refuses to complete a running task under a live worker
  // claim unless the caller passes `--force` (core's own dashboard does the same
  // for a human completion). 0.21.3 has no such flag, so retry without it there.
  try {
    await execOperatorCompletion([...args, '--force'])
  } catch (err: any) {
    if (!/unrecognized arguments: --force/.test(err?.message || '')) throw err
    await execOperatorCompletion(args)
  }
}

async function execOperatorCompletion(args: string[]): Promise<void> {
  // A completion a human clicked in the dashboard is an explicit operator
  // override. hermes-agent 0.21.3 still runs `_goal_mode_handoff_rejection`
  // (hermes_cli/kanban.py) on every `complete` of a goal-mode task, so an
  // auxiliary LLM judge can refuse the operator. Run the CLI with an isolated
  // HERMES_HOME whose config disables only that judge, while keeping the real
  // shared kanban home so the write still lands on the same board DB.
  const isolatedHome = await mkdtemp(join(tmpdir(), 'hermes-kanban-operator-'))
  try {
    await writeFile(
      join(isolatedHome, 'config.yaml'),
      'auxiliary:\n  goal_judge:\n    provider: __operator_override_disabled__\n',
      'utf8',
    )
    const kanbanHome = process.env.HERMES_KANBAN_HOME?.trim() || detectHermesRootHome()
    await execKanbanMutation(
      args,
      'Hermes CLI: kanban operator completion failed',
      'Failed to complete kanban tasks',
      {
        env: {
          ...process.env,
          HERMES_HOME: isolatedHome,
          HERMES_KANBAN_HOME: kanbanHome,
        },
      },
    )
  } finally {
    await rm(isolatedHome, { recursive: true, force: true }).catch(err => {
      logger.error(err, 'Hermes CLI: failed to clean up operator completion config')
    })
  }
}

export async function blockTask(taskId: string, reason: string, opts?: KanbanBoardOptions): Promise<void> {
  await execKanbanMutation(
    [...boardArgs(opts?.board), 'block', taskId, reason],
    'Hermes CLI: kanban block failed',
    'Failed to block kanban task',
  )
}

export async function unblockTasks(taskIds: string[], opts?: KanbanBoardOptions): Promise<void> {
  await execKanbanMutation(
    [...boardArgs(opts?.board), 'unblock', ...taskIds],
    'Hermes CLI: kanban unblock failed',
    'Failed to unblock kanban tasks',
  )
}

export async function assignTask(taskId: string, profile: string, opts?: KanbanBoardOptions): Promise<void> {
  await execKanbanMutation(
    [...boardArgs(opts?.board), 'assign', taskId, profile],
    'Hermes CLI: kanban assign failed',
    'Failed to assign kanban task',
  )
}

export async function archiveTasks(taskIds: string[], opts?: KanbanBoardOptions): Promise<void> {
  await execKanbanMutation(
    [...boardArgs(opts?.board), 'archive', ...taskIds],
    'Hermes CLI: kanban archive failed',
    'Failed to archive kanban tasks',
  )
}

async function applyBulkStatus(taskId: string, opts: KanbanBulkTaskUpdateOptions): Promise<void> {
  switch (opts.status) {
    case undefined:
      return
    case 'done':
      return completeTasks([taskId], opts.summary, opts)
    case 'blocked':
      return blockTask(taskId, opts.reason?.trim() || 'Bulk update', opts)
    case 'ready':
      return unblockTasks([taskId], opts)
    case 'archived':
      return archiveTasks([taskId], opts)
    default:
      throw new Error(`Bulk status ${opts.status} is not supported by the CLI bridge`)
  }
}

export async function bulkUpdateTasks(opts: KanbanBulkTaskUpdateOptions): Promise<KanbanBulkTaskUpdateResult> {
  const ids = opts.ids.map(id => id.trim()).filter(Boolean)
  const results: KanbanBulkTaskResult[] = []
  for (const id of ids) {
    try {
      if (opts.archive) await archiveTasks([id], opts)
      else await applyBulkStatus(id, opts)
      if (opts.assignee !== undefined) await assignTask(id, opts.assignee?.trim() || 'none', opts)
      results.push({ id, ok: true })
    } catch (err: any) {
      results.push({ id, ok: false, error: err?.message || String(err) })
    }
  }
  return { results }
}

export async function getStats(opts?: KanbanBoardOptions): Promise<KanbanStats> {
  try {
    const { stdout } = await execHermes([...boardArgs(opts?.board), 'stats', '--json'], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    // hermes-agent 0.21.3 `kanban stats --json` returns
    // `{ by_status, by_assignee, oldest_ready_age_seconds, now }` — there is no
    // `total`, and `by_assignee` is nested per status ({alice: {ready: 1}}),
    // not a flat count. Flatten both here so the API contract stays numeric.
    const raw = JSON.parse(stdout) as {
      by_status?: Record<string, unknown>
      by_assignee?: Record<string, unknown>
    }
    const byStatus: Record<string, number> = {}
    for (const [status, value] of Object.entries(raw.by_status || {})) {
      const count = Number(value)
      if (Number.isFinite(count) && count >= 0) byStatus[status] = count
    }
    const byAssignee: Record<string, number> = {}
    for (const [assignee, value] of Object.entries(raw.by_assignee || {})) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        byAssignee[assignee] = value
        continue
      }
      if (value && typeof value === 'object') {
        byAssignee[assignee] = Object.values(value as Record<string, unknown>)
          .reduce<number>((total, count) => total + (Number.isFinite(Number(count)) ? Number(count) : 0), 0)
      }
    }
    // `stats` never counts archived tasks, so fold them in from an explicit list.
    const archivedTasks = await listTasks({ board: opts?.board, status: 'archived', includeArchived: true })
    byStatus.archived = archivedTasks.length
    for (const task of archivedTasks) {
      const assignee = task.assignee?.trim() || 'default'
      byAssignee[assignee] = (byAssignee[assignee] || 0) + 1
    }
    return {
      by_status: byStatus,
      by_assignee: byAssignee,
      total: Object.values(byStatus).reduce((total, count) => total + count, 0),
    }
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban stats failed')
    throw new Error(`Failed to get kanban stats: ${err.message}`)
  }
}

export async function getAssignees(opts?: KanbanBoardOptions): Promise<KanbanAssignee[]> {
  try {
    const { stdout } = await execHermes([...boardArgs(opts?.board), 'assignees', '--json'], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return JSON.parse(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban assignees failed')
    throw new Error(`Failed to get kanban assignees: ${err.message}`)
  }
}
