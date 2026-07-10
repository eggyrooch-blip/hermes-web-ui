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
