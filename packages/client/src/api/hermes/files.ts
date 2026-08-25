import { request, getActiveProfileName, getApiKey, getBaseUrlValue } from '../client'

export interface FileEntry {
  name: string
  path: string
  absolutePath?: string
  isDir: boolean
  size: number
  modTime: string
}

export interface FileStat {
  name: string
  path: string
  absolutePath?: string
  isDir: boolean
  size: number
  modTime: string
  permissions?: string
}

export async function listFiles(path: string = '', profile?: string): Promise<{ entries: FileEntry[]; path: string; absolutePath?: string }> {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  // Same trick as fetchMemory: ?profile= lets the agent hub list another owned
  // agent's workspace without switching the active profile.
  if (profile) params.set('profile', profile)
  const query = params.toString()
  return request<{ entries: FileEntry[]; path: string }>(`/api/hermes/files/list${query ? `?${query}` : ''}`)
}

/**
 * Name search across the workspace, for the global palette.
 *
 * The walk, its depth/visit caps and the sensitive-path filtering all live on
 * the server (`/files/search`) — doing it here would mean one request per
 * directory on every keystroke. `truncated` means a cap was hit, so the caller
 * can say "showing the first N" instead of implying this is everything.
 */
export async function searchFiles(
  query: string,
  limit?: number,
): Promise<{ entries: FileEntry[]; truncated: boolean }> {
  const params = new URLSearchParams({ q: query })
  if (limit) params.set('limit', String(limit))
  return request<{ entries: FileEntry[]; truncated: boolean }>(
    `/api/hermes/files/search?${params.toString()}`,
  )
}

/**
 * The library's 最近 view: the most recently modified files across the whole
 * workspace, newest first. Same server-side walk (and same caps) as the name
 * search — directories are left out, since a folder is not something you
 * opened.
 */
export async function fetchRecentFiles(
  limit = 50,
): Promise<{ entries: FileEntry[]; truncated: boolean }> {
  return request<{ entries: FileEntry[]; truncated: boolean }>(
    `/api/hermes/files/search?recent=1&limit=${limit}`,
  )
}

export async function statFile(path: string): Promise<FileStat> {
  return request<FileStat>(`/api/hermes/files/stat?path=${encodeURIComponent(path)}`)
}

/**
 * `profile` reads another agent's workspace without switching the active one —
 * the same selector `listFiles` takes. The server only honours it for a profile
 * the caller owns (getRequestProfile → ownerOwnsProfile), so passing it can
 * never widen access; omitting it keeps the active-profile behaviour.
 */
export async function readFile(path: string, profile?: string): Promise<{ content: string; path: string; size: number }> {
  const params = new URLSearchParams({ path })
  if (profile) params.set('profile', profile)
  return request<{ content: string; path: string; size: number }>(`/api/hermes/files/read?${params.toString()}`)
}

export async function writeFile(path: string, content: string): Promise<void> {
  await request<{ ok: boolean }>('/api/hermes/files/write', {
    method: 'PUT',
    body: JSON.stringify({ path, content }),
  })
}

export async function deleteFile(path: string, recursive: boolean = false): Promise<void> {
  await request<{ ok: boolean }>('/api/hermes/files/delete', {
    method: 'DELETE',
    body: JSON.stringify({ path, recursive }),
  })
}

export async function renameFile(oldPath: string, newPath: string): Promise<void> {
  await request<{ ok: boolean }>('/api/hermes/files/rename', {
    method: 'POST',
    body: JSON.stringify({ oldPath, newPath }),
  })
}

export async function mkDir(path: string): Promise<void> {
  await request<{ ok: boolean }>('/api/hermes/files/mkdir', {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
}

export async function copyFile(srcPath: string, destPath: string): Promise<void> {
  await request<{ ok: boolean }>('/api/hermes/files/copy', {
    method: 'POST',
    body: JSON.stringify({ srcPath, destPath }),
  })
}

export async function uploadFiles(targetDir: string, files: File[]): Promise<{ name: string; path: string }[]> {
  const base = getBaseUrlValue()
  const formData = new FormData()
  for (const file of files) {
    formData.append('file', file)
  }
  const params = new URLSearchParams()
  if (targetDir) params.set('path', targetDir)
  const query = params.toString()
  const url = `${base}/api/hermes/files/upload${query ? `?${query}` : ''}`

  const headers: Record<string, string> = {}
  const token = getApiKey()
  if (token) headers['Authorization'] = `Bearer ${token}`
  const profileName = getActiveProfileName()
  if (profileName) headers['X-Hermes-Profile'] = profileName

  const res = await fetch(url, { method: 'POST', headers, body: formData })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(body.error || `Upload failed: ${res.status}`)
  }
  const data = await res.json()
  return data.files
}

export function getFileDownloadUrl(relativePath: string, fileName?: string, profile?: string): string {
  const base = getBaseUrlValue()
  const params = new URLSearchParams({ path: relativePath })
  if (fileName) params.set('name', fileName)
  // Same owned-profile selector as readFile; falls back to the active profile.
  const profileName = profile || getActiveProfileName()
  if (profileName) params.set('profile', profileName)
  const token = getApiKey()
  if (token) params.set('token', token)
  return `${base}/api/hermes/download?${params.toString()}`
}

export function getFilePreviewUrl(relativePath: string, fileName?: string): string {
  const base = getBaseUrlValue()
  const params = new URLSearchParams({ path: relativePath })
  if (fileName) params.set('name', fileName)
  const profileName = getActiveProfileName()
  if (profileName) params.set('profile', profileName)
  const token = getApiKey()
  if (token) params.set('token', token)
  return `${base}/api/hermes/preview?${params.toString()}`
}
