import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockExecFileAsync = vi.hoisted(() => vi.fn())
const mockLoggerError = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/hermes/hermes-process', () => ({
  execHermes: (args: string[], options: unknown) => mockExecFileAsync('hermes', args, options),
  spawnHermes: vi.fn(),
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { error: mockLoggerError },
}))

import * as service from '../../packages/server/src/services/hermes/hermes-kanban'

// Verbatim captures from `~/.hermes/runtimes/hermes-agent-v0214-d337b736aa/.venv/bin/hermes`
// (Hermes Agent v0.21.4, 2026.9.21) against a throwaway HERMES_HOME, except where noted.

const CORE_0214_TASK = {
  id: 't_b2e2f1f2', title: 'Task A', body: 'body a', assignee: 'alice', status: 'ready', priority: 2,
  tenant: 't1', workspace_kind: 'scratch', workspace_path: null, branch_name: null, project_id: null,
  created_by: 'alice', created_at: 1790170915, started_at: null, completed_at: null, result: null,
  skills: [], max_runtime_seconds: null, max_retries: null, model_override: null, provider_override: null,
  session_id: null, workflow_template_id: null, current_step_key: null, completion_contract: 'local-only',
  last_failure_error: null,
}

// 0.21.4 `diagnostics --json`: per-task rows, then one home-scope row with `task_id: null`.
const CORE_0214_DIAGNOSTICS = [
  { task_id: 't_b2e2f1f2', title: 'Task A', status: 'ready', assignee: 'bob', diagnostics: [] },
  { task_id: null, dispatch_profiles: 'any', diagnostics: [] },
]

// 0.21.3 (v2026.9.14) has no `complete --force`; argparse exits 2 with this last stderr line.
const CORE_0213_NO_FORCE_STDERR = 'hermes: error: unrecognized arguments: --force'

function cliFailure(stderr: string, code: number) {
  return Object.assign(new Error('Command failed: hermes kanban complete'), { code, stderr, stdout: '' })
}

describe('kanban alignment with hermes-agent core 0.21.4', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExecFileAsync.mockReset()
  })

  it('keeps the 0.21.4 max_runtime_seconds task field', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: JSON.stringify([CORE_0214_TASK]) })

    const [task] = await service.listTasks({ board: 'default' })

    expect(task).toHaveProperty('max_runtime_seconds', null)
  })

  it('drops the home-scope diagnostics row so only task rows reach the API', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: JSON.stringify(CORE_0214_DIAGNOSTICS) })

    const rows = await service.getDiagnostics({ board: 'default', task: 't_b2e2f1f2' })

    expect(rows).toEqual([CORE_0214_DIAGNOSTICS[0]])
  })

  it('passes --force on an operator completion so a live worker claim does not refuse the human', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'Completed t_b2e2f1f2', stderr: '' })

    await service.completeTasks(['t_b2e2f1f2'], 'operator done', { board: 'default', operatorOverride: true })

    expect(mockExecFileAsync).toHaveBeenCalledTimes(1)
    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(
      ['kanban', '--board', 'default', 'complete', 't_b2e2f1f2', '--summary', 'operator done', '--force'],
    )
  })

  it('retries without --force on a 0.21.3 core that does not know the flag', async () => {
    mockExecFileAsync
      .mockRejectedValueOnce(cliFailure(CORE_0213_NO_FORCE_STDERR, 2))
      .mockResolvedValueOnce({ stdout: 'Completed t_b2e2f1f2', stderr: '' })

    await service.completeTasks(['t_b2e2f1f2'], 'operator done', { board: 'default', operatorOverride: true })

    expect(mockExecFileAsync).toHaveBeenCalledTimes(2)
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(
      ['kanban', '--board', 'default', 'complete', 't_b2e2f1f2', '--summary', 'operator done'],
    )
    const env = (mockExecFileAsync.mock.calls[1][2] as { env: Record<string, string> }).env
    expect(env.HERMES_HOME).toMatch(/hermes-kanban-operator-/)
  })

  it('surfaces the 0.21.4 empty-completion refusal instead of retrying it', async () => {
    const refusal = 'cannot complete t_428090cd: completion blocked: t_428090cd has no result or summary evidence. '
      + 'Pass --result/--summary describing what was done (an empty completion is not evidence).'
    mockExecFileAsync.mockRejectedValueOnce(cliFailure(refusal, 1))

    await expect(service.completeTasks(['t_428090cd'], undefined, { board: 'default', operatorOverride: true }))
      .rejects.toThrow(`Failed to complete kanban tasks: ${refusal}`)
    expect(mockExecFileAsync).toHaveBeenCalledTimes(1)
  })

  it('does not add --force to a non-operator completion', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await service.completeTasks(['t_b2e2f1f2'], 'done', { board: 'default' })

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', '--board', 'default', 'complete', 't_b2e2f1f2', '--summary', 'done'])
  })
})
