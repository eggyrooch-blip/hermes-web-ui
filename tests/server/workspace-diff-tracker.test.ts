import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const state = vi.hoisted(() => ({
  db: null as DatabaseSync | null,
  appHome: '',
}))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => state.db,
  getStoragePath: () => state.appHome,
  isSqliteAvailable: () => Boolean(state.db),
  jsonDelete: vi.fn(),
  jsonGet: vi.fn(),
  jsonGetAll: vi.fn(() => ({})),
  jsonSet: vi.fn(),
}))

vi.mock('../../packages/server/src/config', () => ({
  config: {
    appHome: state.appHome,
  },
}))

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

describe('workspace diff tracker', () => {
  let root: string
  let repo: string

  beforeEach(async () => {
    vi.resetModules()
    root = mkdtempSync(join(tmpdir(), 'hermes-workspace-diff-'))
    state.appHome = join(root, 'home')
    state.db = new DatabaseSync(join(root, 'diffs.db'))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()

    repo = join(root, 'repo')
    mkdirSync(repo)
    git(repo, ['init'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'Test User'])
    writeFileSync(join(repo, 'dirty.txt'), 'committed\n')
    writeFileSync(join(repo, 'changed.txt'), 'old\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'initial'])
  })

  afterEach(() => {
    state.db?.close()
    state.db = null
    rmSync(root, { recursive: true, force: true })
  })

  it('does nothing without an explicit workspace path', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')
    const { listWorkspaceRunChangesForSession } = await import('../../packages/server/src/db/hermes/workspace-run-changes-store')

    startWorkspaceRunCheckpoint({ sessionId: 'session-noworkspace', runId: 'run-noworkspace' })
    writeFileSync(join(repo, 'changed.txt'), 'new\n')

    expect(completeWorkspaceRunCheckpoint({ sessionId: 'session-noworkspace', runId: 'run-noworkspace' })).toBeNull()
    expect(listWorkspaceRunChangesForSession('session-noworkspace')).toEqual([])
  })

  it('completes a pending workspace checkpoint with the final bridge run id', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')

    const checkpoint = startWorkspaceRunCheckpoint({ sessionId: 'session-pending', workspace: repo })
    writeFileSync(join(repo, 'changed.txt'), 'new\n')

    const change = completeWorkspaceRunCheckpoint({
      sessionId: 'session-pending',
      runId: 'run-pending',
      workspace: repo,
      checkpoint,
    })

    expect(change).not.toBeNull()
    expect(change?.run_id).toBe('run-pending')
    expect(change?.change_id).toMatch(/^run:run-pending:/)
    expect(change?.files).toEqual([
      expect.objectContaining({
        path: 'changed.txt',
        change_type: 'modified',
      }),
    ])
    expect((change?.files[0] as any).patch).toBeUndefined()
  })

  it('records only git files changed during the run and stores relative paths', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')
    const {
      getWorkspaceRunChangeFile,
      listWorkspaceRunChangesForSession,
    } = await import('../../packages/server/src/db/hermes/workspace-run-changes-store')

    writeFileSync(join(repo, 'dirty.txt'), 'preexisting dirty change\n')
    startWorkspaceRunCheckpoint({ sessionId: 'session-git', runId: 'run-git', workspace: repo })

    writeFileSync(join(repo, 'changed.txt'), 'new\n')
    const change = completeWorkspaceRunCheckpoint({ sessionId: 'session-git', runId: 'run-git', workspace: repo })

    expect(change).not.toBeNull()
    expect(change?.change_id).toMatch(/^run:run-git:/)
    expect(change?.workspace_kind).toBe('git')
    expect(change?.workspace).toBe('repo')
    expect(change?.files.map(file => file.path)).toEqual(['changed.txt'])
    expect(change?.files[0]).toMatchObject({
      change_type: 'modified',
      additions: 1,
      deletions: 1,
      binary: false,
    })
    expect(change?.files[0].path).not.toContain(root)
    expect((change?.files[0] as any).patch).toBeUndefined()

    const detail = getWorkspaceRunChangeFile('session-git', change!.change_id, change!.files[0].id)
    expect(detail?.patch).toContain('-old')
    expect(detail?.patch).toContain('+new')

    expect(listWorkspaceRunChangesForSession('session-git')).toHaveLength(1)
  })

  it('records added, modified, and deleted files in non-git workspaces', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')

    const workspace = join(root, 'plain-workspace')
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'deleted.txt'), 'remove me\n')
    writeFileSync(join(workspace, 'old.txt'), 'old\n')
    writeFileSync(join(workspace, 'unchanged.txt'), 'same\n')

    startWorkspaceRunCheckpoint({ sessionId: 'session-plain', runId: 'run-plain', workspace })

    rmSync(join(workspace, 'deleted.txt'))
    writeFileSync(join(workspace, 'added.txt'), 'added\n')
    writeFileSync(join(workspace, 'old.txt'), 'new\n')
    const change = completeWorkspaceRunCheckpoint({ sessionId: 'session-plain', runId: 'run-plain', workspace })

    expect(change).not.toBeNull()
    expect(change?.workspace_kind).toBe('filesystem')
    expect(change?.workspace).toBe('plain-workspace')
    expect(change?.files.map(file => [file.path, file.change_type])).toEqual([
      ['added.txt', 'added'],
      ['deleted.txt', 'deleted'],
      ['old.txt', 'modified'],
    ])
  })

  it('skips empty diffs and creates no database rows', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')
    const { listWorkspaceRunChangesForSession } = await import('../../packages/server/src/db/hermes/workspace-run-changes-store')

    startWorkspaceRunCheckpoint({ sessionId: 'session-empty', runId: 'run-empty', workspace: repo })

    expect(completeWorkspaceRunCheckpoint({ sessionId: 'session-empty', runId: 'run-empty', workspace: repo })).toBeNull()
    expect(listWorkspaceRunChangesForSession('session-empty')).toEqual([])
  })

  it('skips ignored directories, secret/profile paths, and binary files', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')

    const workspace = join(root, 'plain-with-ignored-files')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    mkdirSync(join(workspace, 'node_modules'), { recursive: true })
    mkdirSync(join(workspace, '.git'), { recursive: true })
    mkdirSync(join(workspace, '.hermes', 'profiles', 'sunke'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'app.ts'), 'old\n')
    writeFileSync(join(workspace, 'image.png'), Buffer.from([0, 1, 2, 3]))
    writeFileSync(join(workspace, '.env'), 'TOKEN=before\n')
    writeFileSync(join(workspace, '.hermes', 'profiles', 'sunke', 'config.yaml'), 'secret: before\n')
    writeFileSync(join(workspace, 'node_modules', 'ignored.js'), 'before\n')
    writeFileSync(join(workspace, '.git', 'ignored'), 'before\n')

    startWorkspaceRunCheckpoint({ sessionId: 'session-ignore', runId: 'run-ignore', workspace })

    writeFileSync(join(workspace, 'src', 'app.ts'), 'new\n')
    writeFileSync(join(workspace, 'image.png'), Buffer.from([0, 1, 2, 3, 4]))
    writeFileSync(join(workspace, '.env'), 'TOKEN=after\n')
    writeFileSync(join(workspace, '.hermes', 'profiles', 'sunke', 'config.yaml'), 'secret: after\n')
    writeFileSync(join(workspace, 'node_modules', 'ignored.js'), 'after\n')
    writeFileSync(join(workspace, '.git', 'ignored'), 'after\n')
    const change = completeWorkspaceRunCheckpoint({ sessionId: 'session-ignore', runId: 'run-ignore', workspace })

    expect(change).not.toBeNull()
    expect(change?.files.map(file => file.path)).toEqual(['src/app.ts'])
  })

  it('skips a git rename pair when either side is secret/profile data', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')
    const { listWorkspaceRunChangesForSession } = await import('../../packages/server/src/db/hermes/workspace-run-changes-store')

    writeFileSync(join(repo, '.env'), 'TOKEN=before\n')
    git(repo, ['add', '.env'])
    git(repo, ['commit', '-m', 'tracked secret for parser regression'])

    startWorkspaceRunCheckpoint({ sessionId: 'session-secret-rename', runId: 'run-secret-rename', workspace: repo })

    git(repo, ['mv', '.env', 'public-token.txt'])
    const change = completeWorkspaceRunCheckpoint({ sessionId: 'session-secret-rename', runId: 'run-secret-rename', workspace: repo })

    expect(change).toBeNull()
    expect(listWorkspaceRunChangesForSession('session-secret-rename')).toEqual([])
  })

  it('keeps scanning git candidates until it finds runtime changes after more than eighty preexisting dirty files', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')

    for (let index = 0; index < 81; index += 1) {
      writeFileSync(join(repo, `preexisting-${String(index).padStart(3, '0')}.txt`), 'clean\n')
    }
    writeFileSync(join(repo, 'zz-runtime.txt'), 'before\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'many tracked files'])

    for (let index = 0; index < 81; index += 1) {
      writeFileSync(join(repo, `preexisting-${String(index).padStart(3, '0')}.txt`), 'dirty before run\n')
    }
    startWorkspaceRunCheckpoint({ sessionId: 'session-many-dirty', runId: 'run-many-dirty', workspace: repo })

    writeFileSync(join(repo, 'zz-runtime.txt'), 'after\n')
    const change = completeWorkspaceRunCheckpoint({ sessionId: 'session-many-dirty', runId: 'run-many-dirty', workspace: repo })

    expect(change).not.toBeNull()
    expect(change?.truncated).toBe(true)
    expect(change?.files.map(file => file.path)).toContain('zz-runtime.txt')
  })

  it('truncates large patch bodies', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')
    const { getWorkspaceRunChangeFile } = await import('../../packages/server/src/db/hermes/workspace-run-changes-store')

    const before = Array.from({ length: 20_000 }, (_, index) => `old-${index}`).join('\n') + '\n'
    const after = Array.from({ length: 20_000 }, (_, index) => `new-${index}`).join('\n') + '\n'
    writeFileSync(join(repo, 'large.txt'), before)
    git(repo, ['add', 'large.txt'])
    git(repo, ['commit', '-m', 'large'])

    startWorkspaceRunCheckpoint({ sessionId: 'session-large', runId: 'run-large', workspace: repo })
    writeFileSync(join(repo, 'large.txt'), after)
    const change = completeWorkspaceRunCheckpoint({ sessionId: 'session-large', runId: 'run-large', workspace: repo })

    expect(change).not.toBeNull()
    expect(change?.truncated).toBe(true)
    expect(change?.total_patch_bytes).toBeLessThanOrEqual(256 * 1024)
    const detail = getWorkspaceRunChangeFile('session-large', change!.change_id, change!.files[0].id)
    expect(detail?.truncated).toBe(true)
    expect(Buffer.byteLength(detail?.patch || '', 'utf8')).toBeLessThanOrEqual(256 * 1024)
  })

  it('deletes workspace run changes by session', async () => {
    const { saveWorkspaceRunChange, deleteWorkspaceRunChangesForSession, listWorkspaceRunChangesForSession } =
      await import('../../packages/server/src/db/hermes/workspace-run-changes-store')

    saveWorkspaceRunChange({
      change_id: 'change-1',
      session_id: 'session-delete',
      run_id: 'run-delete',
      source: 'run',
      workspace: 'repo',
      workspace_kind: 'git',
      started_at: 1,
      finished_at: 2,
      files_changed: 1,
      additions: 1,
      deletions: 0,
      truncated: false,
      total_patch_bytes: 12,
      files: [{
        path: 'file.txt',
        change_type: 'added',
        additions: 1,
        deletions: 0,
        size_before: null,
        size_after: 4,
        patch: '+new',
        patch_bytes: 4,
        truncated: false,
        binary: false,
      }],
    })

    expect(listWorkspaceRunChangesForSession('session-delete')).toHaveLength(1)
    deleteWorkspaceRunChangesForSession('session-delete')
    expect(listWorkspaceRunChangesForSession('session-delete')).toEqual([])
  })

  it('rejects absolute file paths before saving workspace run changes', async () => {
    const { listWorkspaceRunChangesForSession, saveWorkspaceRunChange } =
      await import('../../packages/server/src/db/hermes/workspace-run-changes-store')

    const invalidPaths = [
      '/abs/file.txt',
      'C:\\abs\\file.txt',
      'C:/abs/file.txt',
      '\\\\server\\share\\file.txt',
    ]

    for (const path of invalidPaths) {
      const change = saveWorkspaceRunChange({
        change_id: `change-${path.replace(/[^a-z0-9]/gi, '-')}`,
        session_id: 'session-absolute-paths',
        run_id: 'run-absolute-paths',
        source: 'run',
        workspace: 'repo',
        workspace_kind: 'git',
        started_at: 1,
        finished_at: 2,
        files: [{
          path,
          change_type: 'added',
          additions: 1,
          deletions: 0,
          size_before: null,
          size_after: 4,
          patch: '+new',
          patch_bytes: 4,
          truncated: false,
          binary: false,
        }],
      })

      expect(change).toBeNull()
    }

    expect(listWorkspaceRunChangesForSession('session-absolute-paths')).toEqual([])
  })

  it('rejects absolute old paths before saving renamed workspace run changes', async () => {
    const { listWorkspaceRunChangesForSession, saveWorkspaceRunChange } =
      await import('../../packages/server/src/db/hermes/workspace-run-changes-store')

    const change = saveWorkspaceRunChange({
      change_id: 'change-invalid-old-path',
      session_id: 'session-invalid-old-path',
      run_id: 'run-invalid-old-path',
      source: 'run',
      workspace: 'repo',
      workspace_kind: 'git',
      started_at: 1,
      finished_at: 2,
      files: [{
        path: 'new-file.txt',
        old_path: 'C:\\abs\\old-file.txt',
        change_type: 'renamed',
        additions: 1,
        deletions: 1,
        size_before: 3,
        size_after: 4,
        patch: '-old\n+new',
        patch_bytes: 9,
        truncated: false,
        binary: false,
      }],
    })

    expect(change).toBeNull()
    expect(listWorkspaceRunChangesForSession('session-invalid-old-path')).toEqual([])
  })
})
