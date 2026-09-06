import { copyFileSync, existsSync, mkdirSync, statSync } from 'fs'
import { basename, dirname, relative, resolve, sep } from 'path'
import { withArtifactPublication } from './artifact-publication'

const MEDIA_LINE_RE = /(^|\n)(MEDIA:)([^\r\n]+)/g

export function rewriteAssistantMediaDirectives(options: {
  content: string
  profileDir: string
}): string {
  const content = options.content || ''
  if (!content.includes('MEDIA:')) return content

  const profileDir = resolve(options.profileDir)
  return content.replace(MEDIA_LINE_RE, (match, leading: string, _marker: string, rawTarget: string) => {
    const rewritten = rewriteMediaTarget(rawTarget.trim(), profileDir)
    if (!rewritten) return match
    const name = mediaLinkText(rewritten)
    return `${leading}[${name}](${rewritten})`
  })
}

export function publishRunAssistantMedia(options: {
  messages: Array<{
    role?: string
    runMarker?: string
    content?: string
    tool_calls?: unknown[] | null
  }>
  runMarker?: string
  profileDir: string
  fallbackContent: string
}): string {
  let latestAssistant: (typeof options.messages)[number] | undefined
  for (let i = options.messages.length - 1; i >= 0; i -= 1) {
    const message = options.messages[i]
    if (message.runMarker !== options.runMarker || message.role !== 'assistant' || message.tool_calls?.length) continue
    latestAssistant = message
    break
  }
  const content = rewriteAssistantMediaDirectives({
    content: latestAssistant?.content || options.fallbackContent,
    profileDir: options.profileDir,
  })
  if (latestAssistant) latestAssistant.content = content
  return content
}

function rewriteMediaTarget(target: string, profileDir: string): string | null {
  if (!target) return null
  const workspaceDir = resolve(profileDir, 'workspace')
  if (target.startsWith('/workspace/')) {
    const displayPath = target.split(/[?#]/, 1)[0]
    const rel = safeDecode(displayPath.slice('/workspace/'.length))
    const resolvedTarget = resolve(workspaceDir, rel)
    if (!isInside(resolvedTarget, workspaceDir)) return null
    // Preserve the existing friendly workspace card even if an MT alias is
    // stale. It remains unverified and fails through the authenticated download
    // route instead of leaking the raw MEDIA directive into the transcript.
    if (!existsSync(resolvedTarget) || !statSync(resolvedTarget).isFile()) return displayPath
    return withArtifactPublication(displayPath, resolvedTarget)
  }
  if (!target.startsWith('/')) return null

  const resolvedTarget = resolve(target)
  if (!existsSync(resolvedTarget) || !statSync(resolvedTarget).isFile()) {
    const name = basename(resolvedTarget)
    if (!name || name.startsWith('.')) return null
    return `/workspace/Downloads/${encodePathSegment(name)}`
  }

  if (isInside(resolvedTarget, workspaceDir)) {
    const displayPath = `/workspace/${toPosix(relative(workspaceDir, resolvedTarget))}`
    return withArtifactPublication(displayPath, resolvedTarget)
  }

  const homeDir = resolve(profileDir, 'home')
  if (dirname(resolvedTarget) !== homeDir) return null

  const name = basename(resolvedTarget)
  if (!name || name.startsWith('.')) return null

  const downloadsDir = resolve(workspaceDir, 'Downloads')
  mkdirSync(downloadsDir, { recursive: true })
  const publishedPath = resolve(downloadsDir, name)
  copyFileSync(resolvedTarget, publishedPath)
  return withArtifactPublication(`/workspace/Downloads/${encodePathSegment(name)}`, publishedPath)
}

function isInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.startsWith(sep))
}

function toPosix(pathValue: string): string {
  return pathValue.split(sep).map(encodePathSegment).join('/')
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%2F/g, '/')
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function mediaLinkText(rewritten: string): string {
  const segment = rewritten.split(/[?#]/, 1)[0].split('/').filter(Boolean).pop() || rewritten
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
