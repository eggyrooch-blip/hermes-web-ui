import { statSync } from 'node:fs'
import { extname } from 'node:path'

const MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain', '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.js': 'application/javascript', '.json': 'application/json', '.xml': 'application/xml',
  '.csv': 'text/csv', '.md': 'text/markdown', '.pdf': 'application/pdf',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.py': 'text/x-python', '.ts': 'text/typescript', '.tsx': 'text/typescript',
  '.rs': 'text/x-rust', '.go': 'text/x-go', '.java': 'text/x-java', '.c': 'text/x-c',
  '.cpp': 'text/x-c++', '.h': 'text/x-c', '.sh': 'text/x-shellscript',
  '.yaml': 'text/yaml', '.yml': 'text/yaml', '.toml': 'text/toml', '.log': 'text/plain',
}

export function getArtifactMimeType(fileName: string): string {
  return MIME_MAP[extname(fileName).toLowerCase()] || 'application/octet-stream'
}

export function withArtifactPublication(displayPath: string, filePath: string): string {
  const params = new URLSearchParams({
    hermes_mime: getArtifactMimeType(filePath),
    hermes_bytes: String(statSync(filePath).size),
  })
  return `${displayPath}?${params.toString()}`
}
