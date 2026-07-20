import { getActiveProfileName, getApiKey, getBaseUrlValue } from '../client'

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function hasConventionalExtension(value: string): boolean {
  return /\.[A-Za-z0-9]{1,12}$/.test(value.trim())
}

function extractDownloadPath(filePath: string): string {
  if (filePath.startsWith('/api/hermes/download?')) {
    try {
      const parsed = new URL(filePath, 'http://localhost')
      return parsed.searchParams.get('path') || filePath
    } catch {
      return filePath
    }
  }

  return filePath.split('?')[0].split('#')[0]
}

function getPathBasename(filePath: string): string {
  const decodedPath = safeDecodeURIComponent(extractDownloadPath(filePath))
  return decodedPath.split(/[\\/]/).pop()?.trim() || ''
}

/**
 * Pick the filename to save as. Markdown file cards pass the link *text* as the
 * name (`[分析报告](x.md)` → "分析报告"), which carries no extension, so the file
 * lands on disk unopenable. Prefer the caller's name when it already looks like a
 * filename, otherwise fall back to the basename of the path.
 */
export function inferDownloadFileName(filePath: string, fileName?: string): string {
  const decodedName = fileName ? safeDecodeURIComponent(fileName).trim() : ''
  if (decodedName && hasConventionalExtension(decodedName)) return decodedName

  const basename = getPathBasename(filePath)
  if (basename && hasConventionalExtension(basename)) return basename

  return decodedName || basename || 'download'
}

/**
 * Construct a download URL with auth token as query parameter.
 * Token is passed via query param because <a> tags cannot set headers.
 */
export function getDownloadUrl(filePath: string, fileName?: string): string {
  const base = getBaseUrlValue()

  // Remote-URL passthrough: AIGC image generation returns remote Tencent VOD/CDN
  // URLs (http/https). Wrapping them in the local /api/hermes/download proxy makes
  // the server treat the URL as a local file path → 404 → broken image
  // (chenggaowei 2026-06-08). Return them untouched. Must run BEFORE the
  // double-wrap guard and URLSearchParams logic below.
  if (/^https?:\/\//i.test(filePath)) {
    return filePath
  }

  // Guard: if filePath is already a full download URL, extract the real path
  // to prevent double-wrapping (/api/hermes/download?path=/api/hermes/download?path=...)
  if (filePath.startsWith('/api/hermes/download?')) {
    try {
      const parsed = new URL(filePath, 'http://localhost')
      const realPath = parsed.searchParams.get('path')
      if (realPath) filePath = realPath
    } catch {
      // fall through with original filePath
    }
  }

  // Decode the path first in case it's already encoded (e.g., from AI responses)
  // URLSearchParams will encode it again, so we need to start with decoded text
  const decodedPath = safeDecodeURIComponent(filePath)
  const params = new URLSearchParams({ path: decodedPath })
  if (fileName) {
    params.set('name', inferDownloadFileName(decodedPath, fileName))
  }
  const profileName = getActiveProfileName()
  if (profileName) params.set('profile', profileName)
  const token = getApiKey()
  if (token) params.set('token', token)
  return `${base}/api/hermes/download?${params.toString()}`
}

/**
 * Download a file. Uses fetch to detect errors, then creates a blob URL
 * for the browser download. Throws with error message on failure.
 */
export async function downloadFile(filePath: string, fileName?: string): Promise<void> {
  const url = getDownloadUrl(filePath, fileName)
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(body.error || `Download failed: ${res.status}`)
  }
  const blob = await res.blob()
  const blobUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = blobUrl
  a.download = inferDownloadFileName(filePath, fileName)
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(blobUrl)
}

/**
 * Get preview file content.
 * Throws with error message on failure.
 */
export async function fetchFileText(filePath: string, fileName?: string): Promise<string> {
  const url = getDownloadUrl(filePath, fileName)
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(body.error || `Preview failed: ${res.status}`)
  }
  return res.text()
}
