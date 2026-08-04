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

/** `<action>被拦截` — one message shape for download / preview / export. */
export function foreignResponseError(action: string): Error {
  return new Error(`${action}被拦截：响应不是来自 Hermes，请确认已连接飞连后重试`)
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value, window.location.href)
  } catch {
    return null
  }
}

function expectedOrigin(): string {
  return safeUrl(getBaseUrlValue() || window.location.href)?.origin ?? window.location.origin
}

function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, '').toLowerCase()
}

/**
 * Is this URL our own download route? Guard exactly these and nothing else.
 *
 * Not `url !== filePath`: getDownloadUrl returns any absolute http(s) input
 * untouched, so an absolute Hermes download URL (MessageItem passes ContentBlock
 * paths straight through) would look like a remote passthrough and skip the
 * guard entirely. Whether the string changed says nothing about whose URL it is.
 *
 * The endpoint is derived from the configured base rather than hardcoded, so a
 * base URL carrying a path prefix still matches its own generated URLs; case and
 * trailing slashes are normalized because the server routes accept those too.
 */
function isOwnDownloadUrl(url: string): boolean {
  const parsed = safeUrl(url)
  const endpoint = safeUrl(`${getBaseUrlValue()}/api/hermes/download`)
  if (!parsed || !endpoint) return false
  return (
    parsed.origin === endpoint.origin &&
    normalizePath(parsed.pathname) === normalizePath(endpoint.pathname)
  )
}

/**
 * Do these bytes actually come from Hermes?
 *
 * zhouyifei 2026-08-04: off-VPN, public DNS resolved hermes.gotokeep.com to the
 * public Keep WAF, which 302'd the download to www.gotokeep.com and answered with
 * `Access-Control-Allow-Origin: https://hermes.gotokeep.com`. So `res.ok` was
 * true and the client cheerfully saved 118 KB of marketing HTML under the user's
 * `.xlsx` name. `res.ok` only proves *someone* answered — never that Hermes did.
 * The incident trips all three tripwires below.
 */
export function isForeignResponse(res: Response): boolean {
  if (res.redirected) return true
  const target = res.url ? safeUrl(res.url) : null
  if (target && target.origin !== expectedOrigin()) return true
  // Unconditional, deliberately: a WAF parked on the backend origin itself can
  // answer 200 HTML with no redirect, which the two checks above cannot see.
  // Content-Disposition is not CORS-safelisted, so the server exposes it
  // explicitly (index.ts cors exposeHeaders) — treating "unreadable" as
  // acceptable would be fail-open, which is how this bug shipped in the first place.
  return !res.headers.get('Content-Disposition')
}

/** Authoritative filename from the server, '' when absent. */
export function filenameFromContentDisposition(res: Response): string {
  const match = (res.headers.get('Content-Disposition') || '').match(
    /filename\*?=(?:UTF-8'')?([^;\n]+)/i,
  )
  if (!match) return ''
  return safeDecodeURIComponent(match[1].trim().replace(/"/g, ''))
}

/**
 * Download a file. Uses fetch to detect errors, then creates a blob URL
 * for the browser download. Throws with error message on failure.
 */
export async function downloadFile(filePath: string, fileName?: string): Promise<void> {
  const url = getDownloadUrl(filePath, fileName)
  // Vet exactly what targets our own download route; genuine remote CDN/VOD
  // URLs are cross-origin by design and stay unguarded.
  const proxied = isOwnDownloadUrl(url)
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(body.error || `Download failed: ${res.status}`)
  }
  if (proxied && isForeignResponse(res)) throw foreignResponseError('下载')
  const blob = await res.blob()
  const blobUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = blobUrl
  // The server's name wins: a blob discards Content-Disposition, and naming the
  // file after what we *asked for* is exactly how HTML got saved as .xlsx.
  const serverName = proxied ? filenameFromContentDisposition(res) : ''
  a.download = serverName || inferDownloadFileName(filePath, fileName)
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
  const proxied = isOwnDownloadUrl(url)
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(body.error || `Preview failed: ${res.status}`)
  }
  if (proxied && isForeignResponse(res)) throw foreignResponseError('预览')
  return res.text()
}
