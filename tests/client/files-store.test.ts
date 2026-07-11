// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockFilesApi = vi.hoisted(() => ({
  listFiles: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  renameFile: vi.fn(),
  mkDir: vi.fn(),
  copyFile: vi.fn(),
  uploadFiles: vi.fn(),
}))

vi.mock('@/api/hermes/files', () => mockFilesApi)

import { getLanguageFromPath, isPreviewableFile, isTextFile, useFilesStore } from '@/stores/hermes/files'
import type { FileEntry } from '@/api/hermes/files'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('files store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('detects special workspace filenames and extensionless text files', () => {
    expect(getLanguageFromPath('Dockerfile')).toBe('dockerfile')
    expect(getLanguageFromPath('Makefile')).toBe('makefile')
    expect(getLanguageFromPath('CMakeLists.txt')).toBe('cmake')
    expect(getLanguageFromPath('.gitignore')).toBe('gitignore')
    expect(getLanguageFromPath('.dockerignore')).toBe('gitignore')
    expect(getLanguageFromPath('README')).toBe('plaintext')

    expect(isTextFile('README')).toBe(true)
    expect(isTextFile('LICENSE')).toBe(true)
    expect(isTextFile('.env.local')).toBe(true)
    expect(isTextFile('script.ts')).toBe(true)
    expect(isTextFile('unknown-extensionless-binary')).toBe(false)
    expect(isPreviewableFile('README')).toBe(true)
    expect(isPreviewableFile('archive.zip')).toBe(false)
    expect(isPreviewableFile('font.woff2')).toBe(false)
    expect(isPreviewableFile('module.wasm')).toBe(false)
  })

  it('opens text previews with detected syntax language', async () => {
    mockFilesApi.readFile.mockResolvedValue({
      content: 'FROM node:20\nRUN npm test\n',
      path: 'Dockerfile',
      size: 27,
    })

    const store = useFilesStore()
    const entry: FileEntry = {
      name: 'Dockerfile',
      path: 'Dockerfile',
      isDir: false,
      size: 27,
      modTime: '2026-06-02T00:00:00.000Z',
    }

    await store.openPreview(entry)

    expect(mockFilesApi.readFile).toHaveBeenCalledWith('Dockerfile')
    expect(store.previewFile).toEqual({
      path: 'Dockerfile',
      type: 'text',
      content: 'FROM node:20\nRUN npm test\n',
      language: 'dockerfile',
    })
  })

  it('opens image previews without reading file contents', async () => {
    const store = useFilesStore()
    const entry: FileEntry = {
      name: 'diagram.png',
      path: 'diagram.png',
      isDir: false,
      size: 128,
      modTime: '2026-06-02T00:00:00.000Z',
    }

    await store.openPreview(entry)

    expect(mockFilesApi.readFile).not.toHaveBeenCalled()
    expect(store.previewFile).toEqual({
      path: 'diagram.png',
      type: 'image',
    })
  })

  it('keeps only the latest asynchronous editor request', async () => {
    const slowA = deferred<{ content: string }>()
    mockFilesApi.readFile.mockImplementation((path: string) => (
      path === 'a.txt' ? slowA.promise : Promise.resolve({ content: 'B' })
    ))
    const store = useFilesStore()

    const stale = store.openEditor('a.txt')
    const current = store.openEditor('b.txt')
    await expect(current).resolves.toBe(true)
    slowA.resolve({ content: 'A' })
    await expect(stale).resolves.toBe(false)

    expect(store.editingFile).toMatchObject({ path: 'b.txt', content: 'B' })
  })

  it('invalidates a pending editor request without discarding the dirty buffer', async () => {
    const pending = deferred<{ content: string }>()
    mockFilesApi.readFile.mockReturnValue(pending.promise)
    const store = useFilesStore()
    store.editingFile = {
      path: 'dirty.txt',
      content: 'dirty',
      originalContent: 'clean',
      language: 'plaintext',
      ownerScope: 'files-view:__default__',
    }

    const request = store.openEditor('later.txt')
    store.cancelPendingEditor()
    pending.resolve({ content: 'later' })

    await expect(request).resolves.toBe(false)
    expect(store.editingFile).toMatchObject({ path: 'dirty.txt', content: 'dirty' })
  })

  it('guards editor visibility and saves by owner scope', async () => {
    mockFilesApi.readFile.mockResolvedValue({ content: 'A' })
    mockFilesApi.writeFile.mockResolvedValue(undefined)
    const store = useFilesStore()
    await store.openEditor('a.txt', 'chat:session-a')
    store.editingFile!.content = 'dirty A'

    expect(store.canAccessEditor('files-view:profile-b')).toBe(false)
    await expect(store.saveEditor('files-view:profile-b')).resolves.toBe(false)
    expect(mockFilesApi.writeFile).not.toHaveBeenCalled()

    expect(store.canAccessEditor('chat:session-a')).toBe(true)
    await expect(store.saveEditor('chat:session-a')).resolves.toBe(true)
    expect(mockFilesApi.writeFile).toHaveBeenCalledWith('a.txt', 'dirty A')
  })

  it('does not clear another scope editor for same-path delete or rename', async () => {
    mockFilesApi.deleteFile.mockResolvedValue(undefined)
    mockFilesApi.renameFile.mockResolvedValue(undefined)
    mockFilesApi.listFiles.mockResolvedValue({ entries: [] })
    const store = useFilesStore()
    const entry: FileEntry = { name: 'README.md', path: 'README.md', isDir: false, size: 1, modTime: '' }
    store.editingFile = {
      path: 'README.md', content: 'dirty A', originalContent: 'clean A', language: 'markdown', ownerScope: 'session-a',
    }

    await store.deleteEntry(entry, 'session-b')
    expect(store.editingFile?.content).toBe('dirty A')
    await store.renameEntry(entry, 'renamed.md', 'session-b')
    expect(store.editingFile?.content).toBe('dirty A')
  })

  it('clears the owned editor for same-path delete and rename', async () => {
    mockFilesApi.deleteFile.mockResolvedValue(undefined)
    mockFilesApi.renameFile.mockResolvedValue(undefined)
    mockFilesApi.listFiles.mockResolvedValue({ entries: [] })
    const store = useFilesStore()
    const entry: FileEntry = { name: 'README.md', path: 'README.md', isDir: false, size: 1, modTime: '' }
    store.editingFile = {
      path: 'README.md', content: 'dirty A', originalContent: 'clean A', language: 'markdown', ownerScope: 'session-a',
    }

    await store.deleteEntry(entry, 'session-a')
    expect(store.editingFile).toBeNull()
    store.editingFile = {
      path: 'README.md', content: 'dirty A', originalContent: 'clean A', language: 'markdown', ownerScope: 'session-a',
    }
    await store.renameEntry(entry, 'renamed.md', 'session-a')
    expect(store.editingFile).toBeNull()
  })

  it('does not let a slow directory request overwrite the latest path', async () => {
    const slowA = deferred<{ entries: FileEntry[] }>()
    const fastB = deferred<{ entries: FileEntry[] }>()
    mockFilesApi.listFiles.mockImplementation((path: string) => (
      path === 'a' ? slowA.promise : fastB.promise
    ))
    const store = useFilesStore()

    const stale = store.fetchEntries('a')
    const current = store.fetchEntries('b')
    fastB.resolve({ entries: [{ name: 'b.txt', path: 'b/b.txt', isDir: false, size: 1, modTime: '' }] })
    await current
    slowA.resolve({ entries: [{ name: 'a.txt', path: 'a/a.txt', isDir: false, size: 1, modTime: '' }] })
    await stale

    expect(store.currentPath).toBe('b')
    expect(store.entries.map(entry => entry.name)).toEqual(['b.txt'])
    expect(store.loading).toBe(false)
  })

  it('silently ignores a stale rejected directory request', async () => {
    const slowA = deferred<{ entries: FileEntry[] }>()
    mockFilesApi.listFiles.mockImplementation((path: string) => (
      path === 'a' ? slowA.promise : Promise.resolve({ entries: [] })
    ))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = useFilesStore()

    const stale = store.fetchEntries('a')
    await store.fetchEntries('b')
    slowA.reject(new Error('stale A failed'))

    await expect(stale).resolves.toBeUndefined()
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('reports the current rejected directory request', async () => {
    mockFilesApi.listFiles.mockRejectedValue(new Error('current failed'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = useFilesStore()

    await expect(store.fetchEntries('current')).rejects.toThrow('current failed')
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('signals a display-path preview at request start exactly once', async () => {
    const pending = deferred<{ content: string }>()
    mockFilesApi.readFile.mockReturnValue(pending.promise)
    const store = useFilesStore()

    const request = store.previewByDisplayPath('/workspace/a.txt', 'a.txt')
    expect(store.previewPanelRequestedAt).toBe(1)
    pending.resolve({ content: 'A' })
    await request

    expect(store.previewPanelRequestedAt).toBe(1)
    expect(store.previewFile?.path).toBe('a.txt')
  })

  it('opens an unreadable changed file with diff context', async () => {
    mockFilesApi.readFile.mockRejectedValue(new Error('deleted'))
    const store = useFilesStore()

    await store.previewWorkspaceDiffFile({
      displayPath: '/workspace/src/deleted.ts',
      fileName: 'deleted.ts',
      changeId: 'change-1',
      fileId: 7,
      sessionId: 'session-1',
      profile: 'travel',
    })

    expect(mockFilesApi.readFile).toHaveBeenNthCalledWith(1, 'src/deleted.ts')
    expect(mockFilesApi.readFile).toHaveBeenNthCalledWith(2, 'workspace/src/deleted.ts')
    expect(store.previewFile).toEqual({
      path: 'src/deleted.ts',
      type: 'text',
      content: '',
      language: 'typescript',
      contentError: true,
      diff: {
        changeId: 'change-1',
        fileId: 7,
        sessionId: 'session-1',
        profile: 'travel',
      },
    })
    expect(store.previewPanelRequestedAt).toBe(1)
  })

  it('does not let a stale failed preview bind its diff to a newer file', async () => {
    let rejectFirstRead: (error: Error) => void = () => undefined
    const firstRead = new Promise<never>((_resolve, reject) => {
      rejectFirstRead = reject
    })
    mockFilesApi.readFile.mockImplementation((path: string) => {
      if (path === 'src/a.ts') return firstRead
      if (path === 'workspace/src/a.ts') return Promise.reject(new Error('deleted'))
      if (path === 'src/b.ts') return Promise.resolve({ content: 'const file = "b"' })
      return Promise.reject(new Error(`unexpected path: ${path}`))
    })
    const store = useFilesStore()

    const stale = store.previewWorkspaceDiffFile({
      displayPath: '/workspace/src/a.ts',
      fileName: 'a.ts',
      changeId: 'change-a',
      fileId: 1,
      sessionId: 'session-1',
    })
    const current = store.previewWorkspaceDiffFile({
      displayPath: '/workspace/src/b.ts',
      fileName: 'b.ts',
      changeId: 'change-b',
      fileId: 2,
      sessionId: 'session-1',
    })
    await current
    rejectFirstRead(new Error('deleted'))
    await stale

    expect(store.previewFile).toMatchObject({
      path: 'src/b.ts',
      content: 'const file = "b"',
      diff: { changeId: 'change-b', fileId: 2 },
    })
  })
})
