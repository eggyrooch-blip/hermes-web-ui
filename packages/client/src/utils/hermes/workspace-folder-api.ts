import { getWebPlane, request } from '@/api/client'

export interface FolderEntry {
  name: string
  path: string
  fullPath: string
}

export interface FolderListResponse {
  base: string
  current: string
  folders: FolderEntry[]
}

/**
 * Where the workspace picker gets its folders, per plane.
 *
 * The chat plane deliberately does NOT use `/api/hermes/workspace/folders`: that
 * endpoint is not on the chat-plane allow list, so it answers 403 and the picker
 * renders an empty tree with a permission toast (shipped that way; sunke hit it in
 * prod). Rather than opening a second permission surface, the chat plane reuses
 * `/api/hermes/files/*`, which is already allowed, already confined to
 * `<profileDir>/workspace` — the very root a workspace binding resolves against —
 * and already carries the traversal + realpath checks the Files page relies on.
 * A chat-plane user therefore browses exactly the tree they see under /hermes/files.
 *
 * The admin plane keeps the original endpoint on purpose: there, the Files API
 * roots at the upstream profile-home instead, so switching it would silently change
 * which directories a super-admin is choosing from.
 */
function isChatPlane(): boolean {
  return getWebPlane() === 'chat'
}

/** Relative path join that keeps the root-level case ("" + name) clean. */
function joinRelative(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

const HIDDEN_WORKSPACE_PICKER_FOLDERS = new Set(['uploads', 'runs'])

/**
 * A folder NAME is one path segment — never a path.
 *
 * The workspace endpoint enforced this server-side (invalidWorkspaceFolderName in
 * controllers/hermes/sessions.ts). The Files API does not: it normalizes whatever it
 * is given, so `../moved` would rename a folder OUT of the parent the user picked and
 * `a/b` would silently create a nested tree (files/mkdir is recursive). Both stay
 * inside the workspace, so this is about honoring what the picker means, not
 * containment — but the picker must mean the same thing on both planes.
 */
function assertFolderName(name: string): void {
  const invalid = !name
    || name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\\')
    || name.includes('\0')
  if (invalid) throw new Error('Invalid folder name')
}

export async function listWorkspacePickerFolders(subPath = ''): Promise<FolderListResponse> {
  const query = subPath ? `?path=${encodeURIComponent(subPath)}` : ''
  if (!isChatPlane()) {
    return await request<FolderListResponse>(`/api/hermes/workspace/folders${query}`)
  }
  const listing = await request<{ entries?: Array<{ name: string; isDir?: boolean }>; path?: string }>(
    `/api/hermes/files/list${query}`,
  )
  const folders = (listing.entries || [])
    .filter(entry => entry.isDir && !entry.name.startsWith('.') && !HIDDEN_WORKSPACE_PICKER_FOLDERS.has(entry.name))
    .map(entry => {
      const relative = joinRelative(subPath, entry.name)
      // Chat plane speaks relative paths end to end — the same shape the workspace
      // endpoint returns there, and the shape session.workspace is persisted in.
      return { name: entry.name, path: relative, fullPath: relative }
    })
  return { base: '', current: subPath, folders }
}

export async function createWorkspaceFolder(parentPath: string, name: string): Promise<void> {
  assertFolderName(name)
  if (!isChatPlane()) {
    await request('/api/hermes/workspace/folders', {
      method: 'POST',
      body: JSON.stringify({ parentPath, name }),
    })
    return
  }
  await request('/api/hermes/files/mkdir', {
    method: 'POST',
    body: JSON.stringify({ path: joinRelative(parentPath, name) }),
  })
}

export async function renameWorkspaceFolder(path: string, name: string): Promise<void> {
  assertFolderName(name)
  if (!isChatPlane()) {
    await request('/api/hermes/workspace/folders/rename', {
      method: 'POST',
      body: JSON.stringify({ path, name }),
    })
    return
  }
  const parent = path.split('/').filter(Boolean).slice(0, -1).join('/')
  await request('/api/hermes/files/rename', {
    method: 'POST',
    body: JSON.stringify({ oldPath: path, newPath: joinRelative(parent, name) }),
  })
}

export async function deleteWorkspaceFolder(path: string): Promise<void> {
  if (!isChatPlane()) {
    await request('/api/hermes/workspace/folders', {
      method: 'DELETE',
      body: JSON.stringify({ path }),
    })
    return
  }
  // recursive: the picker only ever deletes directories, and the non-recursive
  // branch of files/delete calls deleteFile, which fails on one.
  await request('/api/hermes/files/delete', {
    method: 'DELETE',
    body: JSON.stringify({ path, recursive: true }),
  })
}
