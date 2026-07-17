import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { lstat, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, extname, join, relative, resolve, sep } from 'path'
import { promisify } from 'util'
import { logger } from '../../logger'
import { saveWorkspaceRunChange, type WorkspaceRunChangeSummary } from '../../../db/hermes/workspace-run-changes-store'

const MAX_TRACKED_STATUS_PATHS = 20_000
const MAX_CHANGED_FILES = 80
const MAX_SNAPSHOT_BYTES = 512 * 1024
const MAX_TOTAL_SNAPSHOT_BYTES = 64 * 1024 * 1024
const MAX_PATCH_BYTES_PER_FILE = 256 * 1024
const MAX_TOTAL_PATCH_BYTES = 1024 * 1024
const MAX_SCAN_DIRS = 5_000
const MAX_SCAN_DEPTH = 16
const MAX_SCAN_MS = 1_000
const MAX_GIT_MS = 5_000
const DEADLINE_EXCEEDED = Symbol('deadline-exceeded')

const execFileAsync = promisify(execFile)

async function waitUntilDeadline<T>(operation: Promise<T>, deadline: number): Promise<T | typeof DEADLINE_EXCEEDED> {
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) return DEADLINE_EXCEEDED
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<typeof DEADLINE_EXCEEDED>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(DEADLINE_EXCEEDED), remainingMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const WORKSPACE_DIFF_LIMITS = {
  maxChangedFiles: MAX_CHANGED_FILES,
  maxPatchBytesPerFile: MAX_PATCH_BYTES_PER_FILE,
  maxTotalPatchBytes: MAX_TOTAL_PATCH_BYTES,
}

const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  '.pnpm-store',
  '.yarn',
  'dist',
  'build',
  'out',
  'target',
  '.gradle',
  '.mvn',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  'htmlcov',
  'site-packages',
  '.cache',
  'coverage',
  '.nyc_output',
  '.next',
  '.nuxt',
  '.turbo',
  '.parcel-cache',
  '.svelte-kit',
  '.angular',
  'vendor',
  '.bundle',
  'bin',
  'obj',
  'TestResults',
  '.build',
  'DerivedData',
  'CMakeFiles',
  '.terraform',
  '.dart_tool',
  '_build',
  'deps',
  'tmp',
  'log',
])

const IGNORED_DIR_PATHS = new Set([
  '.yarn/cache',
  'vendor/bundle',
])

const IGNORED_DIR_PREFIXES = ['cmake-build-']
const IGNORED_DIR_SUFFIXES = ['.egg-info', '.dist-info', '.dSYM']

const SKIPPED_FILE_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'npm-debug.log',
  'yarn-error.log',
  'pnpm-debug.log',
  '.eslintcache',
  '.stylelintcache',
  '.coverage',
  'coverage.xml',
])

const SKIPPED_FILE_EXTENSIONS = new Set([
  '.pyc',
  '.pyo',
  '.class',
  '.o',
  '.obj',
  '.a',
  '.lib',
  '.lo',
  '.la',
  '.so',
  '.dylib',
  '.dll',
  '.exe',
  '.wasm',
  '.rlib',
  '.beam',
  '.jar',
  '.war',
  '.ear',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.tiff',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.wav',
  '.flac',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.sqlite',
  '.db',
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.tsbuildinfo',
  '.map',
  '.log',
  '.tmp',
  '.swp',
])

const SECRET_FILE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'credentials',
  'credentials.json',
  'token',
  'tokens.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
])

const SECRET_DIRS = new Set([
  '.hermes',
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.secrets',
  'secrets',
  'profiles',
])

const SECRET_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx'])

interface SnapshotFile {
  exists: boolean
  size: number | null
  mtimeMs: number | null
  binary: boolean
  content: Buffer | null
}

interface WorkspaceRunCheckpoint {
  sessionId: string
  runId: string
  changeId: string
  workspace: string
  root: string
  kind: 'git' | 'filesystem'
  startedAt: number
  files: Map<string, SnapshotFile>
  truncated: boolean
}

export interface WorkspaceRunCheckpointHandle {
  key: string
}

interface WorkspacePathScan {
  paths: string[]
  truncated: boolean
}

interface SnapshotComparison {
  changed: boolean
  changeType: 'added' | 'modified' | 'deleted'
  binary: boolean
  sizeBefore: number | null
  sizeAfter: number | null
  patch: string | null
  additions: number
  deletions: number
  truncated: boolean
  patchBytes: number
}

const checkpoints = new Map<string, Promise<WorkspaceRunCheckpoint | null>>()

function createRunChangeId(runId: string): string {
  return `run:${runId || 'unknown'}:${Date.now().toString(36)}:${randomUUID()}`
}

function checkpointKey(sessionId: string, runId: string): string {
  return `${sessionId}\u0000${runId || 'unknown'}`
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function isPathInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel === '' || (!!rel && !rel.startsWith('..') && rel !== '..' && !rel.split(sep).includes('..'))
}

async function runGit(cwd: string, args: string[], maxBuffer = 1024 * 1024): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer,
    timeout: MAX_GIT_MS,
  })
  return stdout
}

async function resolveGitRoot(workspace: string): Promise<string | null> {
  try {
    const root = (await runGit(workspace, ['rev-parse', '--show-toplevel'])).trim()
    if (!root) return null
    const resolvedWorkspace = await realpath(resolve(workspace))
    const resolvedRoot = await realpath(resolve(root))
    return isPathInside(resolvedRoot, resolvedWorkspace) ? resolvedRoot : null
  } catch {
    return null
  }
}

async function resolveFilesystemRoot(workspace: string): Promise<string | null> {
  try {
    const root = await realpath(resolve(workspace))
    return (await stat(root)).isDirectory() ? root : null
  } catch {
    return null
  }
}

function normalizeRelPath(value: string): string | null {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../')) return null
  return normalized
}

function isSecretOrProfilePath(relPath: string): boolean {
  const normalized = relPath.toLowerCase()
  const parts = normalized.split('/').filter(Boolean)
  const name = parts[parts.length - 1] || ''
  return parts.some(part => SECRET_DIRS.has(part)) ||
    SECRET_FILE_NAMES.has(name) ||
    name.startsWith('.env.') ||
    SECRET_EXTENSIONS.has(extname(name))
}

function shouldSkipRelativePath(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath)
  if (!normalized) return true
  const parts = normalized.split('/')
  const name = parts[parts.length - 1] || ''
  if (isSecretOrProfilePath(normalized)) return true
  if (SKIPPED_FILE_NAMES.has(name) || SKIPPED_FILE_EXTENSIONS.has(extname(name).toLowerCase())) return true
  return parts.some((part, index) => {
    const subPath = parts.slice(0, index + 1).join('/')
    return IGNORED_DIRS.has(part) ||
      IGNORED_DIR_PATHS.has(subPath) ||
      IGNORED_DIR_PREFIXES.some(prefix => part.startsWith(prefix)) ||
      IGNORED_DIR_SUFFIXES.some(suffix => part.endsWith(suffix))
  })
}

function parseGitStatusPaths(output: string): string[] {
  const parts = output.split('\0').filter(Boolean)
  const paths = new Set<string>()
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const status = entry.slice(0, 2)
    if (status.includes('R') || status.includes('C')) {
      const path = normalizeRelPath(entry.slice(3))
      const pairedPath = normalizeRelPath(parts[i + 1] || '')
      i += 1
      if (!path || !pairedPath || shouldSkipRelativePath(path) || shouldSkipRelativePath(pairedPath)) continue
      paths.add(path)
      paths.add(pairedPath)
      continue
    }
    const path = normalizeRelPath(entry.slice(3))
    if (!path || shouldSkipRelativePath(path)) continue
    paths.add(path)
  }
  return [...paths]
}

async function getGitStatusPaths(gitRoot: string): Promise<WorkspacePathScan> {
  try {
    const output = await runGit(gitRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], 4 * 1024 * 1024)
    const paths = parseGitStatusPaths(output)
    return {
      paths: paths.slice(0, MAX_TRACKED_STATUS_PATHS),
      truncated: paths.length > MAX_TRACKED_STATUS_PATHS,
    }
  } catch (err) {
    logger.warn({ err, gitRoot }, '[workspace-diff] failed to inspect git status')
    return { paths: [], truncated: true }
  }
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8000)
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true
  }
  return false
}

function shouldSkipFilesystemDir(name: string, relPath: string): boolean {
  return shouldSkipRelativePath(relPath) ||
    IGNORED_DIRS.has(name) ||
    IGNORED_DIR_PATHS.has(relPath) ||
    IGNORED_DIR_PREFIXES.some(prefix => name.startsWith(prefix)) ||
    IGNORED_DIR_SUFFIXES.some(suffix => name.endsWith(suffix))
}

async function scanFilesystemPaths(root: string): Promise<WorkspacePathScan> {
  const startedAt = Date.now()
  const deadline = startedAt + MAX_SCAN_MS
  const paths: string[] = []
  const queue: Array<{ absPath: string; relPath: string; depth: number }> = [{ absPath: root, relPath: '', depth: 0 }]
  let dirsScanned = 0
  let truncated = false

  while (queue.length > 0) {
    if (Date.now() - startedAt > MAX_SCAN_MS || dirsScanned >= MAX_SCAN_DIRS) {
      truncated = true
      break
    }

    const current = queue.shift()!
    if (current.depth > MAX_SCAN_DEPTH) {
      truncated = true
      continue
    }
    dirsScanned += 1

    let entries
    try {
      const result = await waitUntilDeadline(readdir(current.absPath, { withFileTypes: true }), deadline)
      if (result === DEADLINE_EXCEEDED) {
        truncated = true
        break
      }
      entries = result
    } catch {
      truncated = true
      continue
    }

    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (Date.now() - startedAt > MAX_SCAN_MS) {
        truncated = true
        break
      }
      if (entry.isSymbolicLink()) continue

      const childRelPath = current.relPath ? `${current.relPath}/${entry.name}` : entry.name
      const childAbsPath = join(current.absPath, entry.name)
      if (entry.isDirectory()) {
        if (shouldSkipFilesystemDir(entry.name, childRelPath)) continue
        if (current.depth + 1 > MAX_SCAN_DEPTH) {
          truncated = true
          continue
        }
        queue.push({ absPath: childAbsPath, relPath: childRelPath, depth: current.depth + 1 })
        continue
      }

      if (!entry.isFile() || shouldSkipRelativePath(childRelPath)) continue
      paths.push(childRelPath)
      if (paths.length >= MAX_TRACKED_STATUS_PATHS) {
        truncated = true
        break
      }
    }
  }

  return { paths, truncated }
}

async function snapshotPath(root: string, relPath: string, maxContentBytes = MAX_SNAPSHOT_BYTES): Promise<SnapshotFile> {
  if (shouldSkipRelativePath(relPath)) {
    return { exists: false, size: null, mtimeMs: null, binary: false, content: null }
  }
  const absPath = resolve(root, relPath)
  if (!isPathInside(root, absPath)) {
    return { exists: false, size: null, mtimeMs: null, binary: false, content: null }
  }
  try {
    const linkStat = await lstat(absPath)
    if (linkStat.isSymbolicLink()) {
      return { exists: false, size: null, mtimeMs: null, binary: false, content: null }
    }
    const realPath = await realpath(absPath)
    if (!isPathInside(root, realPath)) {
      return { exists: false, size: null, mtimeMs: null, binary: false, content: null }
    }
    const fileStat = await stat(realPath)
    if (!fileStat.isFile()) {
      return { exists: true, size: fileStat.size, mtimeMs: fileStat.mtimeMs, binary: false, content: null }
    }
    const contentLimit = Math.min(MAX_SNAPSHOT_BYTES, Math.max(0, maxContentBytes))
    if (contentLimit <= 0 || fileStat.size > contentLimit) {
      return { exists: true, size: fileStat.size, mtimeMs: fileStat.mtimeMs, binary: false, content: null }
    }
    const content = await readFile(realPath)
    return {
      exists: true,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      binary: isBinaryBuffer(content),
      content,
    }
  } catch {
    return { exists: false, size: null, mtimeMs: null, binary: false, content: null }
  }
}

async function snapshotPaths(root: string, paths: string[], totalContentBytes = Number.POSITIVE_INFINITY): Promise<{
  files: Map<string, SnapshotFile>
  truncated: boolean
}> {
  const files = new Map<string, SnapshotFile>()
  let remainingContentBytes = totalContentBytes
  let truncated = false
  for (const relPath of paths) {
    const snapshot = await snapshotPath(root, relPath, remainingContentBytes)
    if (snapshot.content) {
      remainingContentBytes -= snapshot.content.length
    } else if (remainingContentBytes <= 0 && snapshot.exists) {
      truncated = true
    }
    files.set(relPath, snapshot)
  }
  return { files, truncated }
}

async function snapshotGitHeadPath(gitRoot: string, relPath: string): Promise<SnapshotFile> {
  if (shouldSkipRelativePath(relPath)) {
    return { exists: false, size: null, mtimeMs: null, binary: false, content: null }
  }
  try {
    await runGit(gitRoot, ['cat-file', '-e', `HEAD:${relPath}`], 1024)
  } catch {
    return { exists: false, size: null, mtimeMs: null, binary: false, content: null }
  }

  try {
    const sizeText = (await runGit(gitRoot, ['cat-file', '-s', `HEAD:${relPath}`])).trim()
    const size = Number.parseInt(sizeText, 10)
    if (!Number.isFinite(size) || size > MAX_SNAPSHOT_BYTES) {
      return { exists: true, size: Number.isFinite(size) ? size : null, mtimeMs: null, binary: false, content: null }
    }
    const { stdout } = await execFileAsync('git', ['show', `HEAD:${relPath}`], {
      cwd: gitRoot,
      encoding: 'buffer',
      maxBuffer: MAX_SNAPSHOT_BYTES + 1024,
      timeout: MAX_GIT_MS,
    })
    const content = stdout as Buffer
    return {
      exists: true,
      size: content.length,
      mtimeMs: null,
      binary: isBinaryBuffer(content),
      content,
    }
  } catch {
    return { exists: true, size: null, mtimeMs: null, binary: false, content: null }
  }
}

function normalizePatchHeader(patch: string, relPath: string): string {
  return patch
    .replace(/^diff --git .*\n/m, `diff --git a/${relPath} b/${relPath}\n`)
    .replace(/^--- .*/m, `--- a/${relPath}`)
    .replace(/^\+\+\+ .*/m, `+++ b/${relPath}`)
}

function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return { additions, deletions }
}

async function makeNoIndexPatch(before: Buffer, after: Buffer, relPath: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-workspace-diff-'))
  const beforePath = join(dir, 'before')
  const afterPath = join(dir, 'after')
  try {
    await Promise.all([writeFile(beforePath, before), writeFile(afterPath, after)])
    try {
      const { stdout } = await execFileAsync('git', ['diff', '--no-index', '--no-color', '--unified=3', beforePath, afterPath], {
        encoding: 'utf8',
        maxBuffer: MAX_PATCH_BYTES_PER_FILE + 64 * 1024,
        timeout: MAX_GIT_MS,
      })
      return normalizePatchHeader(stdout, relPath)
    } catch (err: any) {
      const stdout = typeof err?.stdout === 'string' ? err.stdout : err?.stdout?.toString?.('utf8') || ''
      return stdout ? normalizePatchHeader(stdout, relPath) : ''
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function compareSnapshots(before: SnapshotFile | undefined, after: SnapshotFile, relPath: string, patchBudget: number): Promise<SnapshotComparison> {
  const safeBefore = before || { exists: false, size: null, mtimeMs: null, binary: false, content: null }
  const contentChanged = safeBefore.content != null && after.content != null
    ? !safeBefore.content.equals(after.content)
    : safeBefore.mtimeMs !== after.mtimeMs
  const changed = safeBefore.exists !== after.exists ||
    safeBefore.size !== after.size ||
    contentChanged
  if (!changed) {
    return {
      changed: false,
      changeType: 'modified',
      binary: false,
      sizeBefore: safeBefore.size,
      sizeAfter: after.size,
      patch: null,
      additions: 0,
      deletions: 0,
      truncated: false,
      patchBytes: 0,
    }
  }

  const changeType = !safeBefore.exists && after.exists
    ? 'added'
    : safeBefore.exists && !after.exists
      ? 'deleted'
      : 'modified'
  const binary = safeBefore.binary || after.binary
  let patch: string | null = null
  let additions = 0
  let deletions = 0
  let truncated = false
  let patchBytes = 0

  const beforeContent = safeBefore.exists ? safeBefore.content : Buffer.alloc(0)
  const afterContent = after.exists ? after.content : Buffer.alloc(0)

  if (!binary && beforeContent != null && afterContent != null && patchBudget > 0) {
    const generated = await makeNoIndexPatch(beforeContent, afterContent, relPath)
    const limit = Math.min(MAX_PATCH_BYTES_PER_FILE, patchBudget)
    if (Buffer.byteLength(generated, 'utf8') > limit) {
      patch = generated.slice(0, limit)
      truncated = true
    } else {
      patch = generated
    }
    patchBytes = Buffer.byteLength(patch || '', 'utf8')
    const counts = countPatchLines(patch || '')
    additions = counts.additions
    deletions = counts.deletions
  } else {
    truncated = !binary
    if (changeType === 'added') additions = after.content ? after.content.toString('utf8').split('\n').length : 0
    if (changeType === 'deleted') deletions = safeBefore.content ? safeBefore.content.toString('utf8').split('\n').length : 0
  }

  return {
    changed: true,
    changeType,
    binary,
    sizeBefore: safeBefore.size,
    sizeAfter: after.size,
    patch,
    additions,
    deletions,
    truncated,
    patchBytes,
  }
}

function isEmptyContentOnlyChange(comparison: SnapshotComparison): boolean {
  return comparison.changed &&
    comparison.additions === 0 &&
    comparison.deletions === 0 &&
    !comparison.patch &&
    (comparison.sizeBefore == null || comparison.sizeBefore === 0) &&
    (comparison.sizeAfter == null || comparison.sizeAfter === 0)
}

async function buildWorkspaceRunCheckpoint(args: {
  sessionId: string
  runId: string
  workspace: string
}): Promise<WorkspaceRunCheckpoint | null> {
  const gitRoot = await resolveGitRoot(args.workspace)
  if (gitRoot) {
    const status = await getGitStatusPaths(gitRoot)
    const snapshot = await snapshotPaths(gitRoot, status.paths, MAX_TOTAL_SNAPSHOT_BYTES)
    return {
      sessionId: args.sessionId,
      runId: args.runId,
      changeId: args.runId ? createRunChangeId(args.runId) : '',
      workspace: args.workspace,
      root: gitRoot,
      kind: 'git',
      startedAt: nowSeconds(),
      files: snapshot.files,
      truncated: status.truncated || snapshot.truncated,
    }
  }

  const filesystemRoot = await resolveFilesystemRoot(args.workspace)
  if (!filesystemRoot) return null
  const scan = await scanFilesystemPaths(filesystemRoot)
  const snapshot = await snapshotPaths(filesystemRoot, scan.paths, MAX_TOTAL_SNAPSHOT_BYTES)
  return {
    sessionId: args.sessionId,
    runId: args.runId,
    changeId: args.runId ? createRunChangeId(args.runId) : '',
    workspace: args.workspace,
    root: filesystemRoot,
    kind: 'filesystem',
    startedAt: nowSeconds(),
    files: snapshot.files,
    truncated: scan.truncated || snapshot.truncated,
  }
}

export async function startWorkspaceRunCheckpoint(args: {
  sessionId: string
  runId?: string | null
  workspace?: string | null
}): Promise<WorkspaceRunCheckpointHandle | null> {
  const workspace = args.workspace ? resolve(args.workspace) : ''
  const runId = args.runId || ''
  if (!workspace) return null
  const key = checkpointKey(args.sessionId, runId || `pending:${randomUUID()}`)
  let checkpointPromise = checkpoints.get(key)
  if (!checkpointPromise) {
    checkpointPromise = buildWorkspaceRunCheckpoint({
      sessionId: args.sessionId,
      runId,
      workspace,
    }).catch((err) => {
      logger.warn({ err, workspace }, '[workspace-diff] failed to start checkpoint')
      return null
    })
    checkpoints.set(key, checkpointPromise)
  }
  if (!await checkpointPromise) {
    checkpoints.delete(key)
    return null
  }
  return { key }
}

export async function completeWorkspaceRunCheckpoint(args: {
  sessionId: string
  runId?: string | null
  workspace?: string | null
  checkpoint?: WorkspaceRunCheckpointHandle | null
}): Promise<WorkspaceRunChangeSummary | null> {
  const runId = args.runId || ''
  if (!runId && !args.checkpoint) return null
  const key = args.checkpoint?.key || checkpointKey(args.sessionId, runId)
  const checkpointPromise = checkpoints.get(key)
  checkpoints.delete(key)
  const checkpoint = await checkpointPromise
  if (!checkpoint) return null
  if (!runId) return null

  const status = checkpoint.kind === 'git'
    ? await getGitStatusPaths(checkpoint.root)
    : await scanFilesystemPaths(checkpoint.root)
  const relPaths = [...new Set([...checkpoint.files.keys(), ...status.paths].filter(path => !shouldSkipRelativePath(path)))]
  const files = []
  let totalPatchBytes = 0
  let totalAdditions = 0
  let totalDeletions = 0
  let truncated = checkpoint.truncated || status.truncated || relPaths.length > MAX_CHANGED_FILES
  let remainingSnapshotBytes = MAX_TOTAL_SNAPSHOT_BYTES

  for (const relPath of relPaths) {
    if (files.length >= MAX_CHANGED_FILES) {
      truncated = true
      break
    }
    const after = await snapshotPath(checkpoint.root, relPath, remainingSnapshotBytes)
    if (after.content) {
      remainingSnapshotBytes -= after.content.length
    } else if (remainingSnapshotBytes <= 0 && after.exists) {
      truncated = true
    }
    const before = checkpoint.files.get(relPath) ?? await (
      checkpoint.kind === 'git'
        ? snapshotGitHeadPath(checkpoint.root, relPath)
        : Promise.resolve(undefined)
    )
    const comparison = await compareSnapshots(
      before,
      after,
      relPath,
      Math.max(0, MAX_TOTAL_PATCH_BYTES - totalPatchBytes),
    )
    if (!comparison.changed || comparison.binary || isEmptyContentOnlyChange(comparison)) continue
    totalPatchBytes += comparison.patchBytes
    totalAdditions += comparison.additions
    totalDeletions += comparison.deletions
    truncated = truncated || comparison.truncated || totalPatchBytes >= MAX_TOTAL_PATCH_BYTES
    files.push({
      path: relPath,
      change_type: comparison.changeType,
      additions: comparison.additions,
      deletions: comparison.deletions,
      size_before: comparison.sizeBefore,
      size_after: comparison.sizeAfter,
      patch: comparison.patch,
      patch_bytes: comparison.patchBytes,
      truncated: comparison.truncated,
      binary: comparison.binary,
    })
  }

  if (files.length === 0) return null
  return saveWorkspaceRunChange({
    change_id: checkpoint.changeId || createRunChangeId(runId || checkpoint.runId),
    session_id: checkpoint.sessionId,
    run_id: runId || checkpoint.runId,
    source: 'run',
    workspace: basename(checkpoint.root),
    workspace_kind: checkpoint.kind,
    started_at: checkpoint.startedAt,
    finished_at: nowSeconds(),
    files_changed: files.length,
    additions: totalAdditions,
    deletions: totalDeletions,
    truncated,
    total_patch_bytes: totalPatchBytes,
    files,
  })
}
