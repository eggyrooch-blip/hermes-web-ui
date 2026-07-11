import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as filesApi from '@/api/hermes/files'
import type { FileEntry } from '@/api/hermes/files'

const EXT_LANG_MAP: Record<string, string> = {
  '.js': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.json': 'json', '.jsonc': 'json',
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.md': 'markdown', '.markdown': 'markdown',
  '.py': 'python',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.xml': 'xml',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.sql': 'sql',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp',
  '.toml': 'ini',
  '.ini': 'ini',
  '.env': 'ini',
  '.vue': 'html',
  '.dockerfile': 'dockerfile',
  '.graphql': 'graphql',
  '.lua': 'lua',
  '.r': 'r',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
}

const SPECIAL_FILE_LANG_MAP: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  'CMakeLists.txt': 'cmake',
  '.gitignore': 'gitignore',
  '.dockerignore': 'gitignore',
}

const TEXT_BASENAMES = new Set([
  ...Object.keys(SPECIAL_FILE_LANG_MAP),
  'README',
  'LICENSE',
  'NOTICE',
  'CHANGELOG',
  'CONTRIBUTING',
])

const TEXT_EXTS = new Set([
  '.txt', '.text', '.log', '.csv', '.tsv',
  '.js', '.jsx', '.mjs', '.cjs',
  '.ts', '.tsx', '.mts', '.cts',
  '.json', '.jsonc',
  '.html', '.htm', '.css', '.scss', '.less',
  '.md', '.markdown',
  '.py', '.pyw',
  '.yaml', '.yml', '.xml',
  '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hh', '.hxx',
  '.toml', '.ini', '.env', '.conf', '.cfg', '.properties',
  '.vue', '.svelte', '.astro',
  '.dockerfile', '.graphql', '.gql',
  '.lua', '.r', '.rb', '.php', '.swift', '.kt', '.kts',
  '.diff', '.patch', '.lock',
])

export function getLanguageFromPath(filePath: string): string {
  const name = filePath.split('/').pop() || ''
  const specialLanguage = SPECIAL_FILE_LANG_MAP[name]
  if (specialLanguage) return specialLanguage
  const ext = getFileExt(name)
  return EXT_LANG_MAP[ext] || 'plaintext'
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'])

function getFileExt(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx >= 0 ? name.slice(idx).toLowerCase() : ''
}

export function isImageFile(name: string): boolean {
  return IMAGE_EXTS.has(getFileExt(name))
}

export function isMarkdownFile(name: string): boolean {
  const ext = getFileExt(name)
  return ext === '.md' || ext === '.markdown'
}

export function isHtmlFile(name: string): boolean {
  const ext = getFileExt(name)
  return ext === '.html' || ext === '.htm'
}

export function isTextFile(name: string): boolean {
  const basename = name.split('/').pop() || ''
  if (TEXT_BASENAMES.has(basename) || basename.startsWith('.env.')) return true
  return TEXT_EXTS.has(getFileExt(basename))
}

export function isPreviewableFile(name: string): boolean {
  return isImageFile(name) || isMarkdownFile(name) || isTextFile(name)
}

export const DEFAULT_EDITOR_SCOPE = 'files-view:__default__'

export function decodeDisplayPathSegments(p: string): string {
  return p
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    .join('/')
}

// Returns true if `targetPath` is the same as `changedPath` or lives inside it
// when `changedIsDir` is true. Used to invalidate preview/editor state when
// the underlying file is deleted or renamed.
function isAffected(targetPath: string, changedPath: string, changedIsDir: boolean): boolean {
  if (targetPath === changedPath) return true
  if (changedIsDir && targetPath.startsWith(changedPath + '/')) return true
  return false
}

type PreviewFile = {
  path: string
  type: 'image' | 'markdown' | 'text' | 'html'
  content?: string
  language?: string
  contentError?: boolean
  diff?: {
    changeId: string
    fileId: number
    sessionId: string
    profile?: string | null
  }
}

export const useFilesStore = defineStore('files', () => {
  const currentPath = ref('')
  const entries = ref<FileEntry[]>([])
  const loading = ref(false)
  const sortBy = ref<'name' | 'size' | 'modTime'>('name')
  const sortOrder = ref<'asc' | 'desc'>('asc')

  const editingFile = ref<{
    path: string
    content: string
    originalContent: string
    language: string
    ownerScope: string
  } | null>(null)

  const previewFile = ref<PreviewFile | null>(null)
  const previewPanelRequestedAt = ref(0)
  let editorRequestId = 0
  let previewRequestId = 0
  const browserArtifactRequest = ref<{ name: string, path: string } | null>(null)
  const browserArtifactRequestedAt = ref(0)
  let entriesRequestId = 0

  const pathSegments = computed(() => {
    if (!currentPath.value) return []
    return currentPath.value.split('/').filter(Boolean)
  })

  const sortedEntries = computed(() => {
    const copy = [...entries.value]
    copy.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      let cmp = 0
      switch (sortBy.value) {
        case 'name': cmp = a.name.localeCompare(b.name); break
        case 'size': cmp = a.size - b.size; break
        case 'modTime': cmp = a.modTime.localeCompare(b.modTime); break
      }
      return sortOrder.value === 'asc' ? cmp : -cmp
    })
    return copy
  })

  async function fetchEntries(path?: string) {
    const requestId = ++entriesRequestId
    if (path !== undefined && path !== currentPath.value) {
      // Switching directory invalidates the current preview; close it so the
      // file list becomes visible again. The editor has its own dirty-check
      // (see hasUnsavedChanges), so we leave editingFile alone here.
      previewFile.value = null
      previewRequestId += 1
    }
    if (path !== undefined) currentPath.value = path
    loading.value = true
    try {
      const result = await filesApi.listFiles(currentPath.value)
      if (requestId !== entriesRequestId) return
      entries.value = result.entries
    } catch (err) {
      if (requestId !== entriesRequestId) return
      console.error('Failed to fetch files:', err)
      throw err
    } finally {
      if (requestId === entriesRequestId) loading.value = false
    }
  }

  function resetBrowser() {
    entriesRequestId += 1
    currentPath.value = ''
    entries.value = []
    loading.value = false
  }

  function navigateTo(path: string) { return fetchEntries(path) }
  function navigateUp() {
    const parts = currentPath.value.split('/').filter(Boolean)
    parts.pop()
    return fetchEntries(parts.join('/'))
  }

  async function openEditor(filePath: string, ownerScope = DEFAULT_EDITOR_SCOPE): Promise<boolean> {
    const requestId = ++editorRequestId
    const result = await filesApi.readFile(filePath)
    if (requestId !== editorRequestId) return false
    editingFile.value = {
      path: filePath,
      content: result.content,
      originalContent: result.content,
      language: getLanguageFromPath(filePath),
      ownerScope,
    }
    return true
  }

  function cancelPendingEditor() { editorRequestId += 1 }

  function canAccessEditor(ownerScope = DEFAULT_EDITOR_SCOPE): boolean {
    return !editingFile.value || editingFile.value.ownerScope === ownerScope
  }

  async function saveEditor(ownerScope = DEFAULT_EDITOR_SCOPE): Promise<boolean> {
    if (!editingFile.value || !canAccessEditor(ownerScope)) return false
    await filesApi.writeFile(editingFile.value.path, editingFile.value.content)
    editingFile.value.originalContent = editingFile.value.content
    return true
  }

  function closeEditor(ownerScope = DEFAULT_EDITOR_SCOPE): boolean {
    if (!canAccessEditor(ownerScope)) return false
    cancelPendingEditor()
    editingFile.value = null
    return true
  }

  async function openPreview(entry: FileEntry) {
    const requestId = ++previewRequestId
    if (isImageFile(entry.name)) {
      previewFile.value = { path: entry.path, type: 'image' }
    } else if (isMarkdownFile(entry.name)) {
      const result = await filesApi.readFile(entry.path)
      if (requestId !== previewRequestId) return
      previewFile.value = { path: entry.path, type: 'markdown', content: result.content }
    } else if (isHtmlFile(entry.name)) {
      // HTML artifacts (e.g. difflib reports) render in a sandboxed iframe via
      // the profile-scoped /api/hermes/download URL. content is kept so the
      // "源码/渲染" toggle in FilePreview can show the raw source on demand.
      const result = await filesApi.readFile(entry.path)
      if (requestId !== previewRequestId) return
      previewFile.value = {
        path: entry.path,
        type: 'html',
        content: result.content,
        language: getLanguageFromPath(entry.path),
      }
    } else if (isTextFile(entry.name)) {
      const result = await filesApi.readFile(entry.path)
      if (requestId !== previewRequestId) return
      previewFile.value = {
        path: entry.path,
        type: 'text',
        content: result.content,
        language: getLanguageFromPath(entry.path),
      }
    }
  }

  // Chat-plane roots file reads at workspace/, while admin-plane reads from
  // profile home and expects paths that still include workspace/ — try the
  // workspace-relative path first, then fall back to the ws-prefixed one.
  async function readFileWithWorkspaceFallback(
    displayPath: string,
    rel: string,
    relWithWs: string,
  ): Promise<{ path: string, content: string } | null> {
    try {
      return { path: rel, content: (await filesApi.readFile(rel)).content }
    } catch (firstError) {
      try {
        return { path: relWithWs, content: (await filesApi.readFile(relWithWs)).content }
      } catch (secondError) {
        console.error('Failed to preview file from display path:', displayPath, firstError, secondError)
        return null
      }
    }
  }

  async function previewByDisplayPath(displayPath: string, fileName?: string): Promise<void> {
    const requestId = ++previewRequestId
    const rel = decodeDisplayPathSegments(displayPath.replace(/^\/workspace\//, ''))
    const relWithWs = decodeDisplayPathSegments(displayPath.replace(/^\//, ''))
    const inferredFileName = fileName || rel.split('/').filter(Boolean).pop() || ''

    let type: 'image' | 'markdown' | 'html' | 'text' | null = null
    if (isImageFile(inferredFileName)) {
      type = 'image'
    } else if (isMarkdownFile(inferredFileName)) {
      type = 'markdown'
    } else if (isHtmlFile(inferredFileName)) {
      type = 'html'
    } else if (isTextFile(inferredFileName)) {
      type = 'text'
    }

    if (!type) {
      console.error('Unsupported preview file type for display path:', displayPath)
      return
    }

    previewPanelRequestedAt.value += 1

    if (type === 'image') {
      previewFile.value = { path: rel, type: 'image' }
      return
    }

    const loaded = await readFileWithWorkspaceFallback(displayPath, rel, relWithWs)
    if (!loaded || requestId !== previewRequestId) return

    previewFile.value = {
      path: loaded.path,
      type,
      content: loaded.content,
      language: getLanguageFromPath(loaded.path),
    }
  }

  async function previewWorkspaceDiffFile(opts: {
    displayPath: string
    fileName?: string
    changeId: string
    fileId: number
    sessionId: string
    profile?: string | null
  }): Promise<void> {
    const requestId = ++previewRequestId
    previewFile.value = null
    previewPanelRequestedAt.value += 1
    const rel = decodeDisplayPathSegments(opts.displayPath.replace(/^\/workspace\//, ''))
    const relWithWs = decodeDisplayPathSegments(opts.displayPath.replace(/^\//, ''))
    const inferredFileName = opts.fileName || rel.split('/').filter(Boolean).pop() || ''
    const diff = {
      changeId: opts.changeId,
      fileId: opts.fileId,
      sessionId: opts.sessionId,
      profile: opts.profile,
    }

    let type: PreviewFile['type'] = 'text'
    if (isImageFile(inferredFileName)) type = 'image'
    else if (isMarkdownFile(inferredFileName)) type = 'markdown'
    else if (isHtmlFile(inferredFileName)) type = 'html'

    // Unlike previewByDisplayPath, a failed content read must NOT abort: the
    // file may be gone (deleted/renamed after the run) while its diff is still
    // viewable from the recorded change — surface the failure in the File pane.
    let loaded: { path: string, content: string } | null = null
    if (type !== 'image') {
      loaded = await readFileWithWorkspaceFallback(opts.displayPath, rel, relWithWs)
    }
    if (requestId !== previewRequestId) return

    const workingPath = loaded?.path || rel
    previewFile.value = {
      path: workingPath,
      type,
      ...(type === 'image'
        ? {}
        : {
            content: loaded?.content ?? '',
            language: getLanguageFromPath(workingPath),
            ...(loaded ? {} : { contentError: true }),
          }),
      diff,
    }
  }

  function requestBrowserArtifact(name: string, path: string) {
    browserArtifactRequest.value = { name, path }
    browserArtifactRequestedAt.value = browserArtifactRequestedAt.value + 1
  }

  function closePreview() {
    previewRequestId += 1
    previewFile.value = null
  }

  async function createDir(name: string, targetPath = currentPath.value) {
    const path = targetPath ? `${targetPath}/${name}` : name
    await filesApi.mkDir(path)
    await fetchEntries()
  }

  async function createFile(name: string) {
    const path = currentPath.value ? `${currentPath.value}/${name}` : name
    await filesApi.writeFile(path, '')
    await fetchEntries()
  }

  async function deleteEntry(entry: FileEntry, ownerScope = DEFAULT_EDITOR_SCOPE) {
    await filesApi.deleteFile(entry.path, entry.isDir)
    if (previewFile.value && isAffected(previewFile.value.path, entry.path, entry.isDir)) {
      previewFile.value = null
    }
    if (editingFile.value && canAccessEditor(ownerScope) && isAffected(editingFile.value.path, entry.path, entry.isDir)) {
      editingFile.value = null
    }
    await fetchEntries()
  }

  async function renameEntry(entry: FileEntry, newName: string, ownerScope = DEFAULT_EDITOR_SCOPE) {
    const parentPath = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
    const newPath = parentPath ? `${parentPath}/${newName}` : newName
    await filesApi.renameFile(entry.path, newPath)
    if (previewFile.value && isAffected(previewFile.value.path, entry.path, entry.isDir)) {
      previewFile.value = null
    }
    if (editingFile.value && canAccessEditor(ownerScope) && isAffected(editingFile.value.path, entry.path, entry.isDir)) {
      editingFile.value = null
    }
    await fetchEntries()
  }

  async function copyEntry(entry: FileEntry, destPath: string) {
    await filesApi.copyFile(entry.path, destPath)
    await fetchEntries()
  }

  async function uploadFiles(files: File[]) {
    await filesApi.uploadFiles(currentPath.value, files)
    await fetchEntries()
  }

  function setSort(by: 'name' | 'size' | 'modTime') {
    if (sortBy.value === by) {
      sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc'
    } else {
      sortBy.value = by
      sortOrder.value = 'asc'
    }
  }

  const hasUnsavedChanges = computed(() => {
    if (!editingFile.value) return false
    return editingFile.value.content !== editingFile.value.originalContent
  })

  return {
    currentPath, entries, loading, sortBy, sortOrder,
    editingFile, previewFile,
    previewPanelRequestedAt,
    browserArtifactRequest, browserArtifactRequestedAt,
    pathSegments, sortedEntries, hasUnsavedChanges,
    fetchEntries, resetBrowser, navigateTo, navigateUp,
    openEditor, cancelPendingEditor, canAccessEditor, saveEditor, closeEditor,
    openPreview, previewByDisplayPath, previewWorkspaceDiffFile, requestBrowserArtifact, closePreview,
    createDir, createFile, deleteEntry, renameEntry, copyEntry,
    uploadFiles, setSort,
  }
})
