import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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

async function createTrackedSession(id: string): Promise<void> {
  const { createSession, getSession } = await import('../../packages/server/src/db/hermes/session-store')
  if (!getSession(id)) createSession({ id })
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

    await createTrackedSession('session-noworkspace')
    await startWorkspaceRunCheckpoint({ sessionId: 'session-noworkspace', runId: 'run-noworkspace' })
    writeFileSync(join(repo, 'changed.txt'), 'new\n')

    await expect(completeWorkspaceRunCheckpoint({ sessionId: 'session-noworkspace', runId: 'run-noworkspace' })).resolves.toBeNull()
    expect(listWorkspaceRunChangesForSession('session-noworkspace')).toEqual([])
  })

  it.runIf(process.platform !== 'win32')('yields to a pending callback while the initial git probe is pending', async () => {
    const {
      discardWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')
    const fakeBin = join(root, 'fake-bin')
    const fakeGit = join(fakeBin, 'git')
    const releaseGitProbe = join(root, 'release-git-probe')
    mkdirSync(fakeBin)
    writeFileSync(fakeGit, '#!/bin/sh\nwhile [ ! -f "$HERMES_WORKSPACE_DIFF_TEST_RELEASE" ]; do sleep 0.01; done\nexit 1\n')
    chmodSync(fakeGit, 0o755)
    const originalPath = process.env.PATH
    const originalRelease = process.env.HERMES_WORKSPACE_DIFF_TEST_RELEASE
    process.env.PATH = `${fakeBin}:${originalPath || ''}`
    process.env.HERMES_WORKSPACE_DIFF_TEST_RELEASE = releaseGitProbe

    try {
      await createTrackedSession('session-nonblocking')
      let checkpointResolved = false
      let releaseCallbackRan = false
      const releaseCallback = new Promise<void>(resolveRelease => queueMicrotask(() => {
        releaseCallbackRan = true
        writeFileSync(releaseGitProbe, 'continue\n')
        resolveRelease()
      }))
      const checkpointPromise = startWorkspaceRunCheckpoint({
        sessionId: 'session-nonblocking',
        runId: 'run-nonblocking',
        workspace: repo,
      }).then((checkpoint) => {
        checkpointResolved = true
        return checkpoint
      })

      expect(releaseCallbackRan).toBe(false)
      await releaseCallback
      expect(checkpointResolved).toBe(false)

      const checkpoint = await checkpointPromise
      discardWorkspaceRunCheckpoint({
        sessionId: 'session-nonblocking',
        runId: 'run-nonblocking',
        checkpoint,
      })
      expect(checkpointResolved).toBe(true)
    } finally {
      writeFileSync(releaseGitProbe, 'continue\n')
      process.env.PATH = originalPath
      if (originalRelease == null) delete process.env.HERMES_WORKSPACE_DIFF_TEST_RELEASE
      else process.env.HERMES_WORKSPACE_DIFF_TEST_RELEASE = originalRelease
    }
  })

  it.runIf(process.platform !== 'win32')('bounds terminal checkpoint completion across delayed Git work on multiple changed paths', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')
    const fakeBin = join(root, 'deadline-fake-bin')
    const fakeGit = join(fakeBin, 'git')
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    const originalPath = process.env.PATH
    const originalRealGit = process.env.HERMES_WORKSPACE_DIFF_TEST_REAL_GIT
    const originalLog = process.env.HERMES_WORKSPACE_DIFF_TEST_LOG
    mkdirSync(fakeBin)

    try {
      process.env.HERMES_WORKSPACE_DIFF_TEST_REAL_GIT = realGit
      for (const phase of ['head', 'patch'] as const) {
        const slowPath = `a-${phase}-slow.txt`
        const fastPaths = Array.from({ length: 6 }, (_, index) => `z-${phase}-${index}.txt`)
        const logPath = join(root, `${phase}.log`)
        // Under full-suite load the shared deadline can expire before the
        // delayed Git probe is scheduled. Keep the observable contract about
        // bounded completion, while still waiting for an already-started
        // child to settle before the next phase changes PATH.
        writeFileSync(logPath, '')
        for (const fastPath of fastPaths) writeFileSync(join(repo, fastPath), 'before\n')
        writeFileSync(join(repo, slowPath), 'before\n')
        git(repo, ['add', '.'])
        git(repo, ['commit', '-m', `${phase} deadline`])

        const sessionId = `session-${phase}-deadline`
        const runId = `run-${phase}-deadline`
        await createTrackedSession(sessionId)
        const checkpoint = await startWorkspaceRunCheckpoint({ sessionId, runId, workspace: repo })
        for (const fastPath of fastPaths) writeFileSync(join(repo, fastPath), 'fast after\n')
        writeFileSync(join(repo, slowPath), 'slow after\n')

        const delayCondition = phase === 'head'
          ? 'if [ "$1" = "cat-file" ] && [ "$2" = "-e" ]; then delay_git; fi\n'
          : 'if [ "$1" = "diff" ] && [ "$2" = "--no-index" ]; then delay_git; fi\n'
        writeFileSync(fakeGit, `#!/bin/sh\ndelay_git() {\n  printf "start\\n" >> "$HERMES_WORKSPACE_DIFF_TEST_LOG"\n  sleep 4\n  printf "end\\n" >> "$HERMES_WORKSPACE_DIFF_TEST_LOG"\n}\n${delayCondition}exec "$HERMES_WORKSPACE_DIFF_TEST_REAL_GIT" "$@"\n`)
        chmodSync(fakeGit, 0o755)
        process.env.PATH = `${fakeBin}:${originalPath || ''}`
        process.env.HERMES_WORKSPACE_DIFF_TEST_LOG = logPath

        const startedAt = Date.now()
        const change = await completeWorkspaceRunCheckpoint({ sessionId, runId, workspace: repo, checkpoint })
        const elapsed = Date.now() - startedAt

        expect(elapsed).toBeLessThan(3_500)
        expect(change).toBeNull()
        await new Promise(resolve => setTimeout(resolve, 5_500))
        expect(['', 'start\nend\n']).toContain(readFileSync(logPath, 'utf8'))
        process.env.PATH = originalPath
      }
    } finally {
      process.env.PATH = originalPath
      if (originalRealGit === undefined) delete process.env.HERMES_WORKSPACE_DIFF_TEST_REAL_GIT
      else process.env.HERMES_WORKSPACE_DIFF_TEST_REAL_GIT = originalRealGit
      if (originalLog === undefined) delete process.env.HERMES_WORKSPACE_DIFF_TEST_LOG
      else process.env.HERMES_WORKSPACE_DIFF_TEST_LOG = originalLog
    }
  }, 25_000)

  it.runIf(process.platform !== 'win32')('bounds delayed git status during checkpoint start and completion', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      discardWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')
    const fakeBin = join(root, 'status-deadline-fake-bin')
    const fakeGit = join(fakeBin, 'git')
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    const originalPath = process.env.PATH
    const originalRealGit = process.env.HERMES_WORKSPACE_DIFF_TEST_REAL_GIT
    const originalLog = process.env.HERMES_WORKSPACE_DIFF_TEST_LOG
    mkdirSync(fakeBin)
    writeFileSync(fakeGit, '#!/bin/sh\nif [ "$1" = "status" ]; then\n  printf "start\\n" >> "$HERMES_WORKSPACE_DIFF_TEST_LOG"\n  sleep 4\n  printf "end\\n" >> "$HERMES_WORKSPACE_DIFF_TEST_LOG"\nfi\nexec "$HERMES_WORKSPACE_DIFF_TEST_REAL_GIT" "$@"\n')
    chmodSync(fakeGit, 0o755)

    try {
      process.env.HERMES_WORKSPACE_DIFF_TEST_REAL_GIT = realGit
      await createTrackedSession('session-status-start-deadline')
      const startLog = join(root, 'status-start.log')
      process.env.HERMES_WORKSPACE_DIFF_TEST_LOG = startLog
      process.env.PATH = `${fakeBin}:${originalPath || ''}`
      const startBeganAt = Date.now()
      const delayedStart = await startWorkspaceRunCheckpoint({
        sessionId: 'session-status-start-deadline',
        runId: 'run-status-start-deadline',
        workspace: repo,
      })
      expect(Date.now() - startBeganAt).toBeLessThan(3_500)
      expect(delayedStart).not.toBeNull()
      discardWorkspaceRunCheckpoint({
        sessionId: 'session-status-start-deadline',
        runId: 'run-status-start-deadline',
        checkpoint: delayedStart,
      })
      expect(readFileSync(startLog, 'utf8')).toBe('start\n')
      await vi.waitFor(() => expect(readFileSync(startLog, 'utf8')).toContain('end\n'), { timeout: 5_500 })

      process.env.PATH = originalPath
      await createTrackedSession('session-status-complete-deadline')
      const checkpoint = await startWorkspaceRunCheckpoint({
        sessionId: 'session-status-complete-deadline',
        runId: 'run-status-complete-deadline',
        workspace: repo,
      })
      expect(checkpoint).not.toBeNull()
      writeFileSync(join(repo, 'changed.txt'), 'after delayed status\n')

      const completeLog = join(root, 'status-complete.log')
      process.env.HERMES_WORKSPACE_DIFF_TEST_LOG = completeLog
      process.env.PATH = `${fakeBin}:${originalPath || ''}`
      const completeBeganAt = Date.now()
      const change = await completeWorkspaceRunCheckpoint({
        sessionId: 'session-status-complete-deadline',
        runId: 'run-status-complete-deadline',
        workspace: repo,
        checkpoint,
      })
      expect(Date.now() - completeBeganAt).toBeLessThan(3_500)
      expect(change).toBeNull()
      expect(readFileSync(completeLog, 'utf8')).toBe('start\n')
      await vi.waitFor(() => expect(readFileSync(completeLog, 'utf8')).toContain('end\n'), { timeout: 5_500 })
    } finally {
      process.env.PATH = originalPath
      if (originalRealGit === undefined) delete process.env.HERMES_WORKSPACE_DIFF_TEST_REAL_GIT
      else process.env.HERMES_WORKSPACE_DIFF_TEST_REAL_GIT = originalRealGit
      if (originalLog === undefined) delete process.env.HERMES_WORKSPACE_DIFF_TEST_LOG
      else process.env.HERMES_WORKSPACE_DIFF_TEST_LOG = originalLog
    }
  }, 20_000)

  it.runIf(process.platform !== 'win32')('yields while parsing a large git status response', async () => {
    const { startWorkspaceRunCheckpoint } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')
    const fakeBin = join(root, 'status-parse-fake-bin')
    const fakeGit = join(fakeBin, 'git')
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    const statusPayload = join(root, 'large-status.bin')
    const statusStarted = join(root, 'large-status-started')
    const releaseStatus = join(root, 'large-status-release')
    const originalPath = process.env.PATH
    const originalRealGit = process.env.HERMES_WORKSPACE_DIFF_TEST_REAL_GIT
    const originalPayload = process.env.HERMES_WORKSPACE_DIFF_TEST_STATUS_PAYLOAD
    const originalStarted = process.env.HERMES_WORKSPACE_DIFF_TEST_STATUS_STARTED
    const originalRelease = process.env.HERMES_WORKSPACE_DIFF_TEST_STATUS_RELEASE
    mkdirSync(fakeBin)
    writeFileSync(statusPayload, `${Array.from({ length: 100_000 }, (_, index) => `?? profiles/ignored-${index}.txt`).join('\0')}\0`)
    writeFileSync(fakeGit, '#!/bin/sh\nif [ "$1" = "status" ]; then\n  : > "$HERMES_WORKSPACE_DIFF_TEST_STATUS_STARTED"\n  while [ ! -f "$HERMES_WORKSPACE_DIFF_TEST_STATUS_RELEASE" ]; do sleep 0.01; done\n  cat "$HERMES_WORKSPACE_DIFF_TEST_STATUS_PAYLOAD"\n  exit 0\nfi\nexec "$HERMES_WORKSPACE_DIFF_TEST_REAL_GIT" "$@"\n')
    chmodSync(fakeGit, 0o755)

    try {
      process.env.HERMES_WORKSPACE_DIFF_TEST_REAL_GIT = realGit
      process.env.HERMES_WORKSPACE_DIFF_TEST_STATUS_PAYLOAD = statusPayload
      process.env.HERMES_WORKSPACE_DIFF_TEST_STATUS_STARTED = statusStarted
      process.env.HERMES_WORKSPACE_DIFF_TEST_STATUS_RELEASE = releaseStatus
      process.env.PATH = `${fakeBin}:${originalPath || ''}`
      await createTrackedSession('session-status-parse-yield')
      let yielded = false
      const checkpointPromise = startWorkspaceRunCheckpoint({
        sessionId: 'session-status-parse-yield',
        runId: 'run-status-parse-yield',
        workspace: repo,
      })
      await vi.waitFor(() => expect(existsSync(statusStarted)).toBe(true))
      setImmediate(() => { yielded = true })
      writeFileSync(releaseStatus, 'continue\n')

      await checkpointPromise
      expect(yielded).toBe(true)
    } finally {
      process.env.PATH = originalPath
      if (originalRealGit === undefined) delete process.env.HERMES_WORKSPACE_DIFF_TEST_REAL_GIT
      else process.env.HERMES_WORKSPACE_DIFF_TEST_REAL_GIT = originalRealGit
      if (originalPayload === undefined) delete process.env.HERMES_WORKSPACE_DIFF_TEST_STATUS_PAYLOAD
      else process.env.HERMES_WORKSPACE_DIFF_TEST_STATUS_PAYLOAD = originalPayload
      if (originalStarted === undefined) delete process.env.HERMES_WORKSPACE_DIFF_TEST_STATUS_STARTED
      else process.env.HERMES_WORKSPACE_DIFF_TEST_STATUS_STARTED = originalStarted
      if (originalRelease === undefined) delete process.env.HERMES_WORKSPACE_DIFF_TEST_STATUS_RELEASE
      else process.env.HERMES_WORKSPACE_DIFF_TEST_STATUS_RELEASE = originalRelease
    }
  }, 10_000)

  it.runIf(process.platform !== 'win32')('retains a completed path when a later patch misses the shared deadline', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')
    const fastPath = 'a-fast-before-timeout.txt'
    const slowPath = 'z-slow-timeout.txt'
    writeFileSync(join(repo, fastPath), 'committed\n')
    writeFileSync(join(repo, slowPath), 'committed\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'retain completed path fixture'])
    writeFileSync(join(repo, fastPath), 'run start\n')

    const sessionId = 'session-retain-before-timeout'
    const runId = 'run-retain-before-timeout'
    await createTrackedSession(sessionId)
    const checkpoint = await startWorkspaceRunCheckpoint({ sessionId, runId, workspace: repo })
    writeFileSync(join(repo, fastPath), 'fast after\n')
    writeFileSync(join(repo, slowPath), 'slow after\n')

    const fakeBin = join(root, 'retain-deadline-fake-bin')
    const fakeGit = join(fakeBin, 'git')
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    const logPath = join(root, 'retain-deadline.log')
    const originalPath = process.env.PATH
    const originalRealGit = process.env.HERMES_WORKSPACE_DIFF_TEST_REAL_GIT
    const originalLog = process.env.HERMES_WORKSPACE_DIFF_TEST_LOG
    mkdirSync(fakeBin)
    writeFileSync(fakeGit, '#!/bin/sh\nif [ "$1" = "diff" ] && [ "$2" = "--no-index" ] && grep -q "^slow after$" "$6"; then\n  printf "start\\n" >> "$HERMES_WORKSPACE_DIFF_TEST_LOG"\n  sleep 4\n  printf "end\\n" >> "$HERMES_WORKSPACE_DIFF_TEST_LOG"\nfi\nexec "$HERMES_WORKSPACE_DIFF_TEST_REAL_GIT" "$@"\n')
    chmodSync(fakeGit, 0o755)
    process.env.PATH = `${fakeBin}:${originalPath || ''}`
    process.env.HERMES_WORKSPACE_DIFF_TEST_REAL_GIT = realGit
    process.env.HERMES_WORKSPACE_DIFF_TEST_LOG = logPath

    try {
      const startedAt = Date.now()
      const change = await completeWorkspaceRunCheckpoint({ sessionId, runId, workspace: repo, checkpoint })
      expect(Date.now() - startedAt).toBeLessThan(3_500)
      expect(change?.truncated).toBe(true)
      expect(change?.files.map(file => file.path)).toEqual([fastPath])
      if (existsSync(logPath)) {
        await vi.waitFor(() => expect(readFileSync(logPath, 'utf8')).toContain('end\n'), { timeout: 5_500 })
      }
    } finally {
      process.env.PATH = originalPath
      if (originalRealGit === undefined) delete process.env.HERMES_WORKSPACE_DIFF_TEST_REAL_GIT
      else process.env.HERMES_WORKSPACE_DIFF_TEST_REAL_GIT = originalRealGit
      if (originalLog === undefined) delete process.env.HERMES_WORKSPACE_DIFF_TEST_LOG
      else process.env.HERMES_WORKSPACE_DIFF_TEST_LOG = originalLog
    }
  }, 10_000)

  it.runIf(process.platform !== 'win32')('bounds concurrent workspace checkpoint builds', async () => {
    const {
      discardWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')
    const fakeBin = join(root, 'bounded-fake-bin')
    const fakeGit = join(fakeBin, 'git')
    const logPath = join(root, 'git-concurrency.log')
    mkdirSync(fakeBin)
    writeFileSync(fakeGit, '#!/bin/sh\nprintf "start\\n" >> "$HERMES_WORKSPACE_DIFF_TEST_LOG"\nsleep 0.1\nprintf "end\\n" >> "$HERMES_WORKSPACE_DIFF_TEST_LOG"\nexit 1\n')
    chmodSync(fakeGit, 0o755)
    const originalPath = process.env.PATH
    const originalLog = process.env.HERMES_WORKSPACE_DIFF_TEST_LOG
    process.env.PATH = `${fakeBin}:${originalPath || ''}`
    process.env.HERMES_WORKSPACE_DIFF_TEST_LOG = logPath

    try {
      const handles = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
        const sessionId = `session-bounded-${index}`
        const runId = `run-bounded-${index}`
        await createTrackedSession(sessionId)
        const checkpoint = await startWorkspaceRunCheckpoint({ sessionId, runId, workspace: repo })
        return { sessionId, runId, checkpoint }
      }))
      for (const handle of handles) discardWorkspaceRunCheckpoint(handle)

      let active = 0
      let maximum = 0
      for (const line of readFileSync(logPath, 'utf8').trim().split('\n')) {
        active += line === 'start' ? 1 : -1
        maximum = Math.max(maximum, active)
      }
      expect(active).toBe(0)
      expect(maximum).toBe(2)
    } finally {
      process.env.PATH = originalPath
      if (originalLog === undefined) delete process.env.HERMES_WORKSPACE_DIFF_TEST_LOG
      else process.env.HERMES_WORKSPACE_DIFF_TEST_LOG = originalLog
    }
  })

  it.each(['realpath', 'stat'] as const)('bounds delayed workspace root %s and retains its lease until settlement', async (operationName) => {
    const workspaces = operationName === 'realpath'
      ? [repo, repo, repo]
      : Array.from({ length: 3 }, (_, index) => join(root, `slow-root-stat-${index}`))
    if (operationName === 'stat') {
      for (const workspace of workspaces) mkdirSync(workspace)
    }
    for (let index = 0; index < workspaces.length; index += 1) {
      await createTrackedSession(`session-slow-root-${operationName}-${index}`)
    }

    const realFs = await vi.importActual<typeof import('fs/promises')>('fs/promises')
    const pendingRoots: Array<{ path: string; resolve: (value: any) => void }> = []
    const delayedRootOperation = vi.fn((path: string) => new Promise<any>((resolveRoot) => {
      pendingRoots.push({ path, resolve: resolveRoot })
    }))
    vi.doMock('fs/promises', () => ({
      ...realFs,
      [operationName]: delayedRootOperation,
    }))

    try {
      const {
        discardWorkspaceRunCheckpoint,
        startWorkspaceRunCheckpoint,
      } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')
      const startedAt = Date.now()
      const firstHandles = await Promise.all(workspaces.slice(0, 2).map((workspace, index) => startWorkspaceRunCheckpoint({
        sessionId: `session-slow-root-${operationName}-${index}`,
        runId: `run-slow-root-${operationName}-${index}`,
        workspace,
      })))
      expect(Date.now() - startedAt).toBeLessThan(2_500)
      expect(firstHandles).toEqual([null, null])
      expect(delayedRootOperation).toHaveBeenCalledTimes(2)

      const third = startWorkspaceRunCheckpoint({
        sessionId: `session-slow-root-${operationName}-2`,
        runId: `run-slow-root-${operationName}-2`,
        workspace: workspaces[2],
      })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(delayedRootOperation).toHaveBeenCalledTimes(2)

      const settle = async (index: number): Promise<void> => {
        const pending = pendingRoots[index]
        pending.resolve(operationName === 'realpath'
          ? await realFs.realpath(pending.path)
          : await realFs.stat(pending.path))
      }
      await settle(0)
      await vi.waitFor(() => expect(delayedRootOperation).toHaveBeenCalledTimes(3))
      await settle(1)
      await settle(2)
      if (operationName === 'realpath') {
        await vi.waitFor(() => expect(delayedRootOperation).toHaveBeenCalledTimes(4))
        await settle(3)
      }

      const thirdHandle = await third
      expect(thirdHandle).not.toBeNull()
      discardWorkspaceRunCheckpoint({
        sessionId: `session-slow-root-${operationName}-2`,
        runId: `run-slow-root-${operationName}-2`,
        checkpoint: thirdHandle,
      })
    } finally {
      vi.doUnmock('fs/promises')
    }
  }, 10_000)

  it('times out a queued checkpoint while earlier leases remain unsettled', async () => {
    for (let index = 0; index < 3; index += 1) {
      await createTrackedSession(`session-never-settles-${index}`)
    }
    const realFs = await vi.importActual<typeof import('fs/promises')>('fs/promises')
    const pendingRealpaths: Array<{ path: string; resolve: (value: string) => void }> = []
    const realpathMock = vi.fn((path: string) => new Promise<string>((resolvePath) => {
      pendingRealpaths.push({ path, resolve: resolvePath })
    }))
    vi.doMock('fs/promises', () => ({ ...realFs, realpath: realpathMock }))

    try {
      const { startWorkspaceRunCheckpoint } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')
      await expect(Promise.all([0, 1].map(index => startWorkspaceRunCheckpoint({
        sessionId: `session-never-settles-${index}`,
        runId: `run-never-settles-${index}`,
        workspace: repo,
      })))).resolves.toEqual([null, null])
      expect(realpathMock).toHaveBeenCalledTimes(2)

      const startedAt = Date.now()
      await expect(startWorkspaceRunCheckpoint({
        sessionId: 'session-never-settles-2',
        runId: 'run-never-settles-2',
        workspace: repo,
      })).resolves.toBeNull()
      expect(Date.now() - startedAt).toBeLessThan(2_500)
      expect(realpathMock).toHaveBeenCalledTimes(2)

      for (const pending of pendingRealpaths) pending.resolve(await realFs.realpath(pending.path))
      await new Promise(resolve => setTimeout(resolve, 0))
    } finally {
      vi.doUnmock('fs/promises')
    }
  }, 10_000)

  it('bounds a delayed directory close and retains the lease until cleanup', async () => {
    const workspace = join(root, 'slow-close-workspace')
    mkdirSync(workspace)
    await createTrackedSession('session-slow-close')
    const realFs = await vi.importActual<typeof import('fs/promises')>('fs/promises')
    let resolveClose: () => void = () => {}
    const close = vi.fn(() => new Promise<void>((resolve) => {
      resolveClose = resolve
    }))
    const opendirMock = vi.fn(async () => ({
      read: vi.fn(async () => null),
      close,
    }))
    vi.doMock('fs/promises', () => ({ ...realFs, opendir: opendirMock }))

    try {
      const {
        discardWorkspaceRunCheckpoint,
        startWorkspaceRunCheckpoint,
      } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')
      const startedAt = Date.now()
      const checkpoint = await startWorkspaceRunCheckpoint({
        sessionId: 'session-slow-close',
        runId: 'run-slow-close',
        workspace,
      })

      expect(Date.now() - startedAt).toBeLessThan(2_500)
      expect(checkpoint).not.toBeNull()
      expect(close).toHaveBeenCalledOnce()
      discardWorkspaceRunCheckpoint({
        sessionId: 'session-slow-close',
        runId: 'run-slow-close',
        checkpoint,
      })
      resolveClose()
      await new Promise(resolve => setTimeout(resolve, 0))
    } finally {
      vi.doUnmock('fs/promises')
    }
  }, 5_000)

  it('closes late opendir handles and keeps their concurrency slots until cleanup', async () => {
    const workspaces = Array.from({ length: 3 }, (_, index) => join(root, `slow-workspace-${index}`))
    for (let index = 0; index < workspaces.length; index += 1) {
      mkdirSync(workspaces[index])
      await createTrackedSession(`session-slow-open-${index}`)
    }
    const realFs = await vi.importActual<typeof import('fs/promises')>('fs/promises')
    const pendingOpens: Array<{ resolve: (dir: any) => void; close: ReturnType<typeof vi.fn> }> = []
    const opendirMock = vi.fn(() => new Promise<any>((resolveOpen) => {
      pendingOpens.push({ resolve: resolveOpen, close: vi.fn(async () => {}) })
    }))
    vi.doMock('fs/promises', () => ({ ...realFs, opendir: opendirMock }))

    try {
      const {
        discardWorkspaceRunCheckpoint,
        startWorkspaceRunCheckpoint,
      } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')
      const firstTwo = workspaces.slice(0, 2).map((workspace, index) => startWorkspaceRunCheckpoint({
        sessionId: `session-slow-open-${index}`,
        runId: `run-slow-open-${index}`,
        workspace,
      }))
      await vi.waitFor(() => expect(opendirMock).toHaveBeenCalledTimes(2))
      const firstHandles = await Promise.all(firstTwo)

      const third = startWorkspaceRunCheckpoint({
        sessionId: 'session-slow-open-2',
        runId: 'run-slow-open-2',
        workspace: workspaces[2],
      })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(opendirMock).toHaveBeenCalledTimes(2)

      pendingOpens[0].resolve({ close: pendingOpens[0].close })
      await vi.waitFor(() => expect(pendingOpens[0].close).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(opendirMock).toHaveBeenCalledTimes(3))
      pendingOpens[1].resolve({ close: pendingOpens[1].close })
      pendingOpens[2].resolve({
        read: vi.fn(async () => null),
        close: pendingOpens[2].close,
      })
      const thirdHandle = await third

      firstHandles.forEach((checkpoint, index) => discardWorkspaceRunCheckpoint({
        sessionId: `session-slow-open-${index}`,
        runId: `run-slow-open-${index}`,
        checkpoint,
      }))
      discardWorkspaceRunCheckpoint({
        sessionId: 'session-slow-open-2',
        runId: 'run-slow-open-2',
        checkpoint: thirdHandle,
      })
      await vi.waitFor(() => expect(pendingOpens[1].close).toHaveBeenCalledTimes(1))
      expect(pendingOpens[2].close).toHaveBeenCalledTimes(1)
    } finally {
      vi.doUnmock('fs/promises')
    }
  })

  it('keeps timed-out snapshot I/O inside the global concurrency bound', async () => {
    const workspaces = Array.from({ length: 3 }, (_, index) => join(root, `slow-snapshot-${index}`))
    for (let index = 0; index < workspaces.length; index += 1) {
      mkdirSync(workspaces[index])
      writeFileSync(join(workspaces[index], 'tracked.txt'), 'before\n')
      await createTrackedSession(`session-slow-snapshot-${index}`)
    }
    const realFs = await vi.importActual<typeof import('fs/promises')>('fs/promises')
    const pendingStats: Array<{ path: string; resolve: (value: any) => void }> = []
    const lstatMock = vi.fn((path: string) => new Promise<any>((resolveStat) => {
      pendingStats.push({ path, resolve: resolveStat })
    }))
    vi.doMock('fs/promises', () => ({ ...realFs, lstat: lstatMock }))

    try {
      const {
        discardWorkspaceRunCheckpoint,
        startWorkspaceRunCheckpoint,
      } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')
      const firstTwo = workspaces.slice(0, 2).map((workspace, index) => startWorkspaceRunCheckpoint({
        sessionId: `session-slow-snapshot-${index}`,
        runId: `run-slow-snapshot-${index}`,
        workspace,
      }))
      await vi.waitFor(() => expect(lstatMock).toHaveBeenCalledTimes(2))
      const firstHandles = await Promise.all(firstTwo)

      const third = startWorkspaceRunCheckpoint({
        sessionId: 'session-slow-snapshot-2',
        runId: 'run-slow-snapshot-2',
        workspace: workspaces[2],
      })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(lstatMock).toHaveBeenCalledTimes(2)

      pendingStats[0].resolve(await realFs.lstat(pendingStats[0].path))
      await vi.waitFor(() => expect(lstatMock).toHaveBeenCalledTimes(3))
      pendingStats[1].resolve(await realFs.lstat(pendingStats[1].path))
      pendingStats[2].resolve(await realFs.lstat(pendingStats[2].path))
      const thirdHandle = await third

      firstHandles.forEach((checkpoint, index) => discardWorkspaceRunCheckpoint({
        sessionId: `session-slow-snapshot-${index}`,
        runId: `run-slow-snapshot-${index}`,
        checkpoint,
      }))
      discardWorkspaceRunCheckpoint({
        sessionId: 'session-slow-snapshot-2',
        runId: 'run-slow-snapshot-2',
        checkpoint: thirdHandle,
      })
    } finally {
      vi.doUnmock('fs/promises')
    }
  })

  it('tracks a valid file after more than 5,000 skipped directory entries', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')
    const workspace = join(root, 'huge-plain-workspace')
    mkdirSync(workspace)
    for (let index = 0; index < 5_200; index += 1) {
      writeFileSync(join(workspace, `.env.${String(index).padStart(5, '0')}`), '')
    }
    writeFileSync(join(workspace, 'zzzz-tracked.txt'), 'before\n')
    await createTrackedSession('session-huge-scan')

    let timerFired = false
    const checkpointPromise = startWorkspaceRunCheckpoint({
      sessionId: 'session-huge-scan',
      runId: 'run-huge-scan',
      workspace,
    })
    setTimeout(() => { timerFired = true }, 0)
    await vi.waitFor(() => expect(timerFired).toBe(true))
    const checkpoint = await checkpointPromise
    expect(checkpoint).not.toBeNull()
    writeFileSync(join(workspace, 'zzzz-tracked.txt'), 'after\n')
    const change = await completeWorkspaceRunCheckpoint({
      sessionId: 'session-huge-scan',
      runId: 'run-huge-scan',
      workspace,
      checkpoint,
    })
    expect(change?.files.map(file => file.path)).toContain('zzzz-tracked.txt')
  })

  it('completes a pending workspace checkpoint with the final bridge run id', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')

    await createTrackedSession('session-pending')
    const checkpoint = await startWorkspaceRunCheckpoint({ sessionId: 'session-pending', workspace: repo })
    writeFileSync(join(repo, 'changed.txt'), 'new\n')

    const change = await completeWorkspaceRunCheckpoint({
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
    await createTrackedSession('session-git')
    await startWorkspaceRunCheckpoint({ sessionId: 'session-git', runId: 'run-git', workspace: repo })

    writeFileSync(join(repo, 'changed.txt'), 'new\n')
    const change = await completeWorkspaceRunCheckpoint({ sessionId: 'session-git', runId: 'run-git', workspace: repo })

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

    await createTrackedSession('session-plain')
    await startWorkspaceRunCheckpoint({ sessionId: 'session-plain', runId: 'run-plain', workspace })

    rmSync(join(workspace, 'deleted.txt'))
    writeFileSync(join(workspace, 'added.txt'), 'added\n')
    writeFileSync(join(workspace, 'old.txt'), 'new\n')
    const change = await completeWorkspaceRunCheckpoint({ sessionId: 'session-plain', runId: 'run-plain', workspace })

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

    await createTrackedSession('session-empty')
    await startWorkspaceRunCheckpoint({ sessionId: 'session-empty', runId: 'run-empty', workspace: repo })

    await expect(completeWorkspaceRunCheckpoint({ sessionId: 'session-empty', runId: 'run-empty', workspace: repo })).resolves.toBeNull()
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

    await createTrackedSession('session-ignore')
    await startWorkspaceRunCheckpoint({ sessionId: 'session-ignore', runId: 'run-ignore', workspace })

    writeFileSync(join(workspace, 'src', 'app.ts'), 'new\n')
    writeFileSync(join(workspace, 'image.png'), Buffer.from([0, 1, 2, 3, 4]))
    writeFileSync(join(workspace, '.env'), 'TOKEN=after\n')
    writeFileSync(join(workspace, '.hermes', 'profiles', 'sunke', 'config.yaml'), 'secret: after\n')
    writeFileSync(join(workspace, 'node_modules', 'ignored.js'), 'after\n')
    writeFileSync(join(workspace, '.git', 'ignored'), 'after\n')
    const change = await completeWorkspaceRunCheckpoint({ sessionId: 'session-ignore', runId: 'run-ignore', workspace })

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

    await createTrackedSession('session-secret-rename')
    await startWorkspaceRunCheckpoint({ sessionId: 'session-secret-rename', runId: 'run-secret-rename', workspace: repo })

    git(repo, ['mv', '.env', 'public-token.txt'])
    const change = await completeWorkspaceRunCheckpoint({ sessionId: 'session-secret-rename', runId: 'run-secret-rename', workspace: repo })

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
    await createTrackedSession('session-many-dirty')
    await startWorkspaceRunCheckpoint({ sessionId: 'session-many-dirty', runId: 'run-many-dirty', workspace: repo })

    writeFileSync(join(repo, 'zz-runtime.txt'), 'after\n')
    const change = await completeWorkspaceRunCheckpoint({ sessionId: 'session-many-dirty', runId: 'run-many-dirty', workspace: repo })

    expect(change).not.toBeNull()
    expect(change?.truncated).toBe(true)
    expect(change?.files.map(file => file.path)).toContain('zz-runtime.txt')
  })

  it('truncates CJK and emoji patch bodies by UTF-8 bytes without malformed code points', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')
    const { getWorkspaceRunChangeFile } = await import('../../packages/server/src/db/hermes/workspace-run-changes-store')

    const before = Array.from({ length: 12_000 }, (_, index) => `old-${index}`).join('\n') + '\n'
    const after = Array.from({ length: 12_000 }, (_, index) => `新🙂-${index}`).join('\n') + '\n'
    writeFileSync(join(repo, 'large.txt'), before)
    git(repo, ['add', 'large.txt'])
    git(repo, ['commit', '-m', 'large'])

    await createTrackedSession('session-large')
    await startWorkspaceRunCheckpoint({ sessionId: 'session-large', runId: 'run-large', workspace: repo })
    writeFileSync(join(repo, 'large.txt'), after)
    const change = await completeWorkspaceRunCheckpoint({ sessionId: 'session-large', runId: 'run-large', workspace: repo })

    expect(change).not.toBeNull()
    expect(change?.truncated).toBe(true)
    expect(change?.total_patch_bytes).toBeLessThanOrEqual(256 * 1024)
    const detail = getWorkspaceRunChangeFile('session-large', change!.change_id, change!.files[0].id)
    expect(detail?.truncated).toBe(true)
    expect(Buffer.byteLength(detail?.patch || '', 'utf8')).toBeLessThanOrEqual(256 * 1024)
    expect(detail?.patch).toContain('新🙂-')
    expect(Buffer.from(detail?.patch || '', 'utf8').toString('utf8')).toBe(detail?.patch)
  })

  it('deletes session messages and workspace changes atomically', async () => {
    const { saveWorkspaceRunChange, listWorkspaceRunChangesForSession } =
      await import('../../packages/server/src/db/hermes/workspace-run-changes-store')
    const { addMessage, createSession, deleteSession, getSession, getSessionIncarnation, getSessionRowId } =
      await import('../../packages/server/src/db/hermes/session-store')
    const { MESSAGES_TABLE, WORKSPACE_RUN_CHANGES_TABLE, WORKSPACE_RUN_CHANGE_FILES_TABLE } =
      await import('../../packages/server/src/db/hermes/schemas')

    createSession({ id: 'session-delete' })
    addMessage({ session_id: 'session-delete', role: 'user', content: 'hello' })

    saveWorkspaceRunChange({
      change_id: 'change-1',
      session_id: 'session-delete',
      session_rowid: getSessionRowId('session-delete')!,
      session_incarnation: getSessionIncarnation('session-delete')!,
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
    state.db!.exec(`
      CREATE TRIGGER fail_session_message_delete
      BEFORE DELETE ON ${MESSAGES_TABLE}
      WHEN OLD.session_id = 'session-delete'
      BEGIN
        SELECT RAISE(ABORT, 'forced delete failure');
      END
    `)

    expect(() => deleteSession('session-delete')).toThrow('forced delete failure')
    expect(getSession('session-delete')).not.toBeNull()
    expect(state.db!.prepare(`SELECT COUNT(*) AS count FROM ${MESSAGES_TABLE} WHERE session_id = ?`).get('session-delete')).toEqual({ count: 1 })
    expect(state.db!.prepare(`SELECT COUNT(*) AS count FROM ${WORKSPACE_RUN_CHANGES_TABLE} WHERE session_id = ?`).get('session-delete')).toEqual({ count: 1 })
    expect(state.db!.prepare(`SELECT COUNT(*) AS count FROM ${WORKSPACE_RUN_CHANGE_FILES_TABLE} WHERE session_id = ?`).get('session-delete')).toEqual({ count: 1 })

    state.db!.exec('DROP TRIGGER fail_session_message_delete')
    expect(deleteSession('session-delete')).toBe(true)
    expect(getSession('session-delete')).toBeNull()
    expect(listWorkspaceRunChangesForSession('session-delete')).toEqual([])
    expect(state.db!.prepare(`SELECT COUNT(*) AS count FROM ${MESSAGES_TABLE} WHERE session_id = ?`).get('session-delete')).toEqual({ count: 0 })
    expect(state.db!.prepare(`SELECT COUNT(*) AS count FROM ${WORKSPACE_RUN_CHANGES_TABLE} WHERE session_id = ?`).get('session-delete')).toEqual({ count: 0 })
    expect(state.db!.prepare(`SELECT COUNT(*) AS count FROM ${WORKSPACE_RUN_CHANGE_FILES_TABLE} WHERE session_id = ?`).get('session-delete')).toEqual({ count: 0 })
  })

  it('does not attach an old run diff after its session id is deleted and recreated', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')
    const { createSession, deleteSession } = await import('../../packages/server/src/db/hermes/session-store')
    const { listWorkspaceRunChangesForSession } = await import('../../packages/server/src/db/hermes/workspace-run-changes-store')

    createSession({ id: 'session-delete-race' })
    await startWorkspaceRunCheckpoint({ sessionId: 'session-delete-race', runId: 'run-delete-race', workspace: repo })
    writeFileSync(join(repo, 'changed.txt'), 'changed after start\n')
    expect(deleteSession('session-delete-race')).toBe(true)
    createSession({ id: 'session-delete-race', title: 'replacement session' })

    await expect(completeWorkspaceRunCheckpoint({
      sessionId: 'session-delete-race',
      runId: 'run-delete-race',
      workspace: repo,
    })).resolves.toBeNull()
    expect((await import('../../packages/server/src/db/hermes/session-store')).getSession('session-delete-race')?.title).toBe('replacement session')
    expect(listWorkspaceRunChangesForSession('session-delete-race')).toEqual([])
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
        session_rowid: 0,
        session_incarnation: 0,
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
      session_rowid: 0,
      session_incarnation: 0,
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
