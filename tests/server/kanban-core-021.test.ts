import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockExecFileAsync = vi.hoisted(() => vi.fn())
const mockSpawnHermes = vi.hoisted(() => vi.fn())
const mockLoggerError = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/hermes/hermes-process', () => ({
  execHermes: (args: string[], options: unknown) => mockExecFileAsync('hermes', args, options),
  spawnHermes: mockSpawnHermes,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { error: mockLoggerError },
}))

import * as service from '../../packages/server/src/services/hermes/hermes-kanban'

// Every fixture below is a verbatim capture from
// `~/.hermes/runtimes/hermes-agent-v0213-345cd2b057/.venv/bin/hermes kanban … --json`
// (Hermes Agent v0.21.3, 2026.9.14) run against a throwaway HERMES_KANBAN_HOME.
// They are what the WebUI actually receives today; the older fixtures in
// hermes-kanban-service.test.ts encode a contract core no longer emits.

const CORE_0213_TASK = {
  id: 't_f7a507e3',
  title: 'probe task one',
  body: 'hello body',
  assignee: null,
  status: 'ready',
  priority: 5,
  tenant: null,
  workspace_kind: 'scratch',
  workspace_path: null,
  branch_name: null,
  project_id: null,
  created_by: 'user',
  created_at: 1789979737,
  started_at: null,
  completed_at: null,
  result: null,
  skills: [],
  max_retries: null,
  model_override: null,
  provider_override: null,
  session_id: null,
  workflow_template_id: null,
  current_step_key: null,
  completion_contract: 'local-only',
  last_failure_error: null,
}

// 0.21.3 `stats --json`: no `total` key at all, and `by_assignee` is a nested
// per-status map rather than a flat count.
const CORE_0213_STATS = {
  by_status: { ready: 2, running: 1 },
  by_assignee: { alice: { ready: 1, running: 1 }, bob: { ready: 1 } },
  oldest_ready_age_seconds: 51,
  now: 1789979788,
}

// 0.21.3 `show --json`: comments and events carry neither `id` nor `task_id`.
const CORE_0213_DETAIL = {
  task: CORE_0213_TASK,
  latest_summary: null,
  parents: [],
  children: [],
  comments: [
    { author: 'tester', body: 'a probe comment', created_at: 1789979787 },
    { author: 'tester', body: 'second comment', created_at: 1789979790 },
  ],
  events: [
    { kind: 'created', payload: { status: 'ready' }, created_at: 1789979737, run_id: null },
    { kind: 'assigned', payload: { assignee: 'alice' }, created_at: 1789979780, run_id: null },
  ],
  runs: [],
}

describe('kanban alignment with hermes-agent core 0.21.3', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps every 0.21.3 task field on list and create instead of dropping the new columns', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: JSON.stringify([CORE_0213_TASK]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify(CORE_0213_TASK) })

    const [listed] = await service.listTasks({ board: 'default' })
    const created = await service.createTask('probe task one', { board: 'default' })

    for (const task of [listed, created]) {
      expect(task.completion_contract).toBe('local-only')
      expect(task).toHaveProperty('branch_name', null)
      expect(task).toHaveProperty('project_id', null)
      expect(task).toHaveProperty('session_id', null)
      expect(task).toHaveProperty('workflow_template_id', null)
      expect(task).toHaveProperty('current_step_key', null)
      expect(task).toHaveProperty('model_override', null)
      expect(task).toHaveProperty('provider_override', null)
      expect(task).toHaveProperty('max_retries', null)
      expect(task).toHaveProperty('last_failure_error', null)
    }
  })

  it('derives a board total from by_status because 0.21.3 stats has no total field', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: JSON.stringify(CORE_0213_STATS) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })

    const stats = await service.getStats({ board: 'default' })

    expect(CORE_0213_STATS).not.toHaveProperty('total')
    expect(stats.total).toBe(3)
    expect(stats.by_status).toEqual({ ready: 2, running: 1, archived: 0 })
  })

  it('flattens the nested by_assignee map into per-assignee counts', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: JSON.stringify(CORE_0213_STATS) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })

    const stats = await service.getStats({ board: 'default' })

    expect(stats.by_assignee).toEqual({ alice: 2, bob: 1 })
    for (const count of Object.values(stats.by_assignee)) {
      expect(typeof count).toBe('number')
    }
  })

  it('folds archived tasks into both stats maps and into the total', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: JSON.stringify(CORE_0213_STATS) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { ...CORE_0213_TASK, id: 'a1', status: 'archived', assignee: 'alice' },
          { ...CORE_0213_TASK, id: 'a2', status: 'archived', assignee: null },
        ]),
      })

    const stats = await service.getStats({ board: 'default' })

    expect(stats.by_status.archived).toBe(2)
    expect(stats.by_assignee).toEqual({ alice: 3, bob: 1, default: 1 })
    expect(stats.total).toBe(5)
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', '--board', 'default', 'list', '--json', '--archived', '--status', 'archived'])
  })

  it('drops malformed stats counts rather than emitting NaN into the board header', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: JSON.stringify({ by_status: { ready: 2, broken: 'many', negative: -1 }, by_assignee: {} }) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })

    const stats = await service.getStats({ board: 'default' })

    expect(stats.by_status).toEqual({ ready: 2, archived: 0 })
    expect(stats.total).toBe(2)
    expect(Number.isNaN(stats.total)).toBe(false)
  })

  it('synthesizes unique comment and event ids because 0.21.3 omits them', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: JSON.stringify(CORE_0213_DETAIL) })

    const detail = await service.getTask('t_f7a507e3', { board: 'default' })

    expect(detail).not.toBeNull()
    expect(detail!.comments.map(comment => comment.id)).toEqual([
      't_f7a507e3:comment:0',
      't_f7a507e3:comment:1',
    ])
    expect(detail!.events.map(event => event.id)).toEqual([
      't_f7a507e3:event:0',
      't_f7a507e3:event:1',
    ])
    for (const row of [...detail!.comments, ...detail!.events]) {
      expect(row.task_id).toBe('t_f7a507e3')
    }
    const ids = [...detail!.comments, ...detail!.events].map(row => String(row.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('preserves ids a future core does emit instead of overwriting them', async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: JSON.stringify({
        ...CORE_0213_DETAIL,
        comments: [{ id: 41, task_id: 't_f7a507e3', author: 'tester', body: 'kept', created_at: 1 }],
        events: [{ id: 7, task_id: 't_f7a507e3', kind: 'created', payload: null, created_at: 1, run_id: null }],
      }),
    })

    const detail = await service.getTask('t_f7a507e3', { board: 'default' })

    expect(detail!.comments[0].id).toBe(41)
    expect(detail!.events[0].id).toBe(7)
  })

  it('records created_by so the creator passes their own ownership check', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: JSON.stringify(CORE_0213_TASK) })

    await service.createTask('probe task one', { board: 'default', assignee: 'feishu_x', createdBy: 'feishu_x' })

    // Without --created-by the CLI stamps the literal "user", which
    // taskOwnedBy() then rejects, hiding the task from whoever made it.
    expect(mockExecFileAsync.mock.calls[0][1]).toEqual([
      'kanban', '--board', 'default', 'create', 'probe task one', '--json',
      '--assignee', 'feishu_x', '--created-by', 'feishu_x',
    ])
  })

  it('omits --created-by when no owner profile could be resolved', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: JSON.stringify(CORE_0213_TASK) })

    await service.createTask('probe task one', { board: 'default' })

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', '--board', 'default', 'create', 'probe task one', '--json'])
  })

  it('reports what the CLI said on a failed mutation, not the raw command line', async () => {
    const failure: any = new Error('Command failed: /path/to/hermes kanban --board default block t_1 secret reason')
    failure.stderr = 'cannot block t_1'
    failure.stdout = ''
    mockExecFileAsync.mockRejectedValueOnce(failure)

    await expect(service.blockTask('t_1', 'secret reason', { board: 'default' }))
      .rejects.toThrow('Failed to block kanban task: cannot block t_1')

    // The opaque execFile message echoes the whole argv back to the client.
    await expect(service.blockTask('t_1', 'secret reason', { board: 'default' }).catch(err => { throw err }))
      .rejects.not.toThrow(/Command failed/)
  })

  it('falls back to the error message when the CLI printed nothing', async () => {
    mockExecFileAsync.mockRejectedValueOnce(Object.assign(new Error('spawn ENOENT'), { stderr: '', stdout: '' }))

    await expect(service.unblockTasks(['t_1'], { board: 'default' }))
      .rejects.toThrow('Failed to unblock kanban tasks: spawn ENOENT')
  })

  it('runs an operator completion with the goal judge disabled but the real kanban home kept', async () => {
    const previousKanbanHome = process.env.HERMES_KANBAN_HOME
    process.env.HERMES_KANBAN_HOME = '/tmp/real-kanban-home'
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'Completed t_f7a507e3', stderr: '' })

    try {
      await service.completeTasks(['t_f7a507e3'], 'operator done', { board: 'default', operatorOverride: true })
    } finally {
      if (previousKanbanHome === undefined) delete process.env.HERMES_KANBAN_HOME
      else process.env.HERMES_KANBAN_HOME = previousKanbanHome
    }

    const [, args, options] = mockExecFileAsync.mock.calls[0]
    expect(args).toEqual(['kanban', '--board', 'default', 'complete', 't_f7a507e3', '--summary', 'operator done', '--force'])
    const env = (options as { env: Record<string, string> }).env
    expect(env.HERMES_KANBAN_HOME).toBe('/tmp/real-kanban-home')
    expect(env.HERMES_HOME).toMatch(/hermes-kanban-operator-/)
    expect(env.HERMES_HOME).not.toBe('/tmp/real-kanban-home')
  })

  it('leaves the environment untouched for a non-operator completion', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await service.completeTasks(['t_f7a507e3'], undefined, { board: 'default' })

    const [, args, options] = mockExecFileAsync.mock.calls[0]
    expect(args).toEqual(['kanban', '--board', 'default', 'complete', 't_f7a507e3'])
    expect((options as { env?: unknown }).env).toBeUndefined()
  })
})
