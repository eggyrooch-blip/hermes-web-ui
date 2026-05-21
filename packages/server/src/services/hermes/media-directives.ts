import { copyFileSync, existsSync, mkdirSync, statSync } from 'fs'
import { basename, dirname, relative, resolve, sep } from 'path'

const MEDIA_LINE_RE = /(^|\n)(MEDIA:)([^\r\n]+)/g

export function rewriteAssistantMediaDirectives(options: {
  content: string
  profileDir: string
}): string {
  const content = options.content || ''
  if (!content.includes('MEDIA:')) return content

  const profileDir = resolve(options.profileDir)
  return content.replace(MEDIA_LINE_RE, (match, leading: string, marker: string, rawTarget: string) => {
    const rewritten = rewriteMediaTarget(rawTarget.trim(), profileDir)
    return rewritten ? `${leading}${marker}${rewritten}` : match
  })
}

function rewriteMediaTarget(target: string, profileDir: string): string | null {
  if (!target) return null
  if (target.startsWith('/workspace/')) return target
  if (!target.startsWith('/')) return null

  const resolvedTarget = resolve(target)
  if (!existsSync(resolvedTarget) || !statSync(resolvedTarget).isFile()) return null

  const workspaceDir = resolve(profileDir, 'workspace')
  if (isInside(resolvedTarget, workspaceDir)) {
    return `/workspace/${toPosix(relative(workspaceDir, resolvedTarget))}`
  }

  const homeDir = resolve(profileDir, 'home')
  if (dirname(resolvedTarget) !== homeDir) return null

  const name = basename(resolvedTarget)
  if (!name || name.startsWith('.')) return null

  const downloadsDir = resolve(workspaceDir, 'Downloads')
  mkdirSync(downloadsDir, { recursive: true })
  const publishedPath = resolve(downloadsDir, name)
  copyFileSync(resolvedTarget, publishedPath)
  return `/workspace/Downloads/${encodePathSegment(name)}`
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
