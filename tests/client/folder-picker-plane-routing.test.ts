// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.hoisted(() => vi.fn())
const getWebPlaneMock = vi.hoisted(() => vi.fn(() => 'both'))

vi.mock('@/api/client', () => ({
  request: requestMock,
  getWebPlane: getWebPlaneMock,
}))

import {
  createWorkspaceFolder,
  deleteWorkspaceFolder,
  listWorkspacePickerFolders,
  renameWorkspaceFolder,
} from '@/utils/hermes/workspace-folder-api'

describe('workspace folder api plane routing', () => {
  beforeEach(() => {
    requestMock.mockReset()
    getWebPlaneMock.mockReturnValue('both')
  })

  describe('chat plane', () => {
    beforeEach(() => getWebPlaneMock.mockReturnValue('chat'))

    it('lists folders through the already-permitted files API, not workspace/folders', async () => {
      // workspace/folders is NOT on the chat-plane allow list — calling it is the
      // 403 that shipped to prod. The whole point of this module is to avoid it.
      requestMock.mockResolvedValue({
        entries: [
          { name: 'media-probe', isDir: true },
          { name: 'notes.md', isDir: false },
          { name: 'clients', isDir: true },
        ],
      })

      const result = await listWorkspacePickerFolders()

      expect(requestMock).toHaveBeenCalledWith('/api/hermes/files/list')
      expect(requestMock.mock.calls[0][0]).not.toContain('workspace/folders')
      expect(result.folders.map(f => f.name)).toEqual(['media-probe', 'clients'])
      expect(result.folders[0]).toEqual({ name: 'media-probe', path: 'media-probe', fullPath: 'media-probe' })
    })

    it('keeps runtime-owned directories out of workspace choices', async () => {
      requestMock.mockResolvedValue({
        entries: [
          { name: '.ai-docs', isDir: true },
          { name: 'uploads', isDir: true },
          { name: 'runs', isDir: true },
          { name: 'Downloads', isDir: true },
          { name: 'client-a', isDir: true },
        ],
      })

      const result = await listWorkspacePickerFolders()

      expect(result.folders.map(folder => folder.name)).toEqual(['Downloads', 'client-a'])
    })

    it('keeps relative paths when drilling into a subdirectory', async () => {
      requestMock.mockResolvedValue({ entries: [{ name: 'acme', isDir: true }] })

      const result = await listWorkspacePickerFolders('clients')

      expect(requestMock).toHaveBeenCalledWith('/api/hermes/files/list?path=clients')
      expect(result.folders[0]).toEqual({ name: 'acme', path: 'clients/acme', fullPath: 'clients/acme' })
      expect(result.current).toBe('clients')
    })

    it('creates, renames and deletes through the files API', async () => {
      requestMock.mockResolvedValue({ ok: true })

      await createWorkspaceFolder('clients', 'acme')
      expect(requestMock).toHaveBeenLastCalledWith('/api/hermes/files/mkdir', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: 'clients/acme' }),
      }))

      await renameWorkspaceFolder('clients/acme', 'acme-2')
      expect(requestMock).toHaveBeenLastCalledWith('/api/hermes/files/rename', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ oldPath: 'clients/acme', newPath: 'clients/acme-2' }),
      }))

      // recursive: the non-recursive branch calls deleteFile, which fails on a dir.
      await deleteWorkspaceFolder('clients/acme-2')
      expect(requestMock).toHaveBeenLastCalledWith('/api/hermes/files/delete', expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ path: 'clients/acme-2', recursive: true }),
      }))
    })

    it('renames a root-level folder without inventing a parent segment', async () => {
      requestMock.mockResolvedValue({ ok: true })

      await renameWorkspaceFolder('media-probe', 'media-probe-2')

      expect(requestMock).toHaveBeenLastCalledWith('/api/hermes/files/rename', expect.objectContaining({
        body: JSON.stringify({ oldPath: 'media-probe', newPath: 'media-probe-2' }),
      }))
    })
  })

  describe('folder name validation (both planes)', () => {
    // The workspace endpoint validated names server-side; the Files API does not —
    // it just normalizes. Without this guard, renaming to '../moved' walks the folder
    // out of the parent the user picked, and 'a/b' creates a nested tree silently.
    const badNames = ['..', '.', '', 'a/b', 'a\\b', '../moved']

    it('rejects path-shaped names on the chat plane before any request', async () => {
      getWebPlaneMock.mockReturnValue('chat')
      for (const name of badNames) {
        await expect(createWorkspaceFolder('clients', name)).rejects.toThrow()
        await expect(renameWorkspaceFolder('clients/acme', name)).rejects.toThrow()
      }
      expect(requestMock).not.toHaveBeenCalled()
    })

    it('rejects path-shaped names on the admin plane too', async () => {
      getWebPlaneMock.mockReturnValue('both')
      for (const name of badNames) {
        await expect(createWorkspaceFolder('', name)).rejects.toThrow()
      }
      expect(requestMock).not.toHaveBeenCalled()
    })

    it('still accepts ordinary names including unicode and dots inside', async () => {
      getWebPlaneMock.mockReturnValue('chat')
      requestMock.mockResolvedValue({ ok: true })

      await createWorkspaceFolder('clients', '客户-2026.v2')

      expect(requestMock).toHaveBeenLastCalledWith('/api/hermes/files/mkdir', expect.objectContaining({
        body: JSON.stringify({ path: 'clients/客户-2026.v2' }),
      }))
    })
  })

  describe('admin plane', () => {
    it('keeps using workspace/folders so super-admins still browse the host base', async () => {
      // files/list roots at the upstream profile-home off the chat plane, so routing
      // admins there would silently change which directories they are choosing from.
      requestMock.mockResolvedValue({ base: '/home/user', current: '', folders: [] })

      await listWorkspacePickerFolders('sub')
      expect(requestMock).toHaveBeenLastCalledWith('/api/hermes/workspace/folders?path=sub')

      requestMock.mockResolvedValue({ ok: true })
      await createWorkspaceFolder('', 'proj')
      expect(requestMock).toHaveBeenLastCalledWith('/api/hermes/workspace/folders', expect.objectContaining({
        body: JSON.stringify({ parentPath: '', name: 'proj' }),
      }))

      await renameWorkspaceFolder('proj', 'proj2')
      expect(requestMock).toHaveBeenLastCalledWith('/api/hermes/workspace/folders/rename', expect.objectContaining({
        body: JSON.stringify({ path: 'proj', name: 'proj2' }),
      }))

      await deleteWorkspaceFolder('proj2')
      expect(requestMock).toHaveBeenLastCalledWith('/api/hermes/workspace/folders', expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ path: 'proj2' }),
      }))
    })
  })
})
