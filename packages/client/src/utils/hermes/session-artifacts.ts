export interface ArtifactMessage {
  role: string
  content: string
}

export function collectSessionArtifacts(messages: readonly ArtifactMessage[]): { name: string, path: string }[] {
  const artifacts: { name: string, path: string }[] = []
  const seen = new Set<string>()
  const marker = '/workspace/'
  const mediaLine = /(^|\n)[ \t]*MEDIA:([^\r\n]+)/g

  for (const message of messages) {
    if (message.role !== 'assistant' || !message.content?.includes('MEDIA:')) continue
    mediaLine.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = mediaLine.exec(message.content)) !== null) {
      const target = match[2].trim()
      const index = target.indexOf(marker)
      if (index === -1) continue
      const relativePath = target.slice(index + marker.length).replace(/^\/+/, '')
      if (!relativePath) continue
      const path = marker + relativePath.split('/').map(encodeURIComponent).join('/')
      if (seen.has(path)) continue
      seen.add(path)
      artifacts.push({ name: relativePath.split('/').filter(Boolean).pop() || relativePath, path })
    }
  }

  return artifacts
}
