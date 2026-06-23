import type { ContentBlock, SessionMessage } from './types'

type ResponseContentPart = { type: string; text?: string; image_url?: string }
type AgentContentPart = { type: string; text?: string; image_url?: { url: string } }

/**
 * Convert ContentBlock[] to string for display/storage
 */
export function contentBlocksToString(input: string | ContentBlock[]): string {
  if (typeof input === 'string') return input
  return JSON.stringify(input)
}

export function contentBlocksToBrokerText(input: string | ContentBlock[]): string {
  if (typeof input === 'string') return input
  const parts: string[] = []
  for (const block of input) {
    if (block.type === 'text') {
      parts.push(block.text || '')
    } else if (block.type === 'image') {
      const name = block.name || block.path
      parts.push(`[Attached image: ${name}]\nLocal image path for tools: ${workspaceToolPath(block.path)}`)
    } else if (block.type === 'file') {
      const name = block.name || block.path
      parts.push(`[Attached file: ${name}]\nLocal file path for tools: ${workspaceToolPath(block.path)}`)
    }
  }
  return parts.filter(Boolean).join('\n')
}

function workspaceToolPath(filePath: string): string {
  const normalized = String(filePath || '').replace(/\\/g, '/')
  if (!normalized) return normalized
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)) return normalized
  if (normalized === '/workspace' || normalized.startsWith('/workspace/')) return normalized
  if (normalized.startsWith('workspace/')) return `/${normalized}`
  const workspaceIndex = normalized.indexOf('/workspace/')
  if (workspaceIndex >= 0) return normalized.slice(workspaceIndex)
  if (!normalized.startsWith('/')) return `/workspace/${normalized.replace(/^\.?\//, '')}`
  return normalized
}

/**
 * Extract text content from ContentBlock[] for title preview
 */
export function extractTextForPreview(input: string | ContentBlock[]): string {
  if (typeof input === 'string') return input
  return input
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * Check if input is ContentBlock array
 */
export function isContentBlockArray(input: any): input is ContentBlock[] {
  return Array.isArray(input) && input.length > 0 && ('type' in input[0])
}

function brokerContentForStoredMessage(content: unknown): string {
  if (isContentBlockArray(content)) return contentBlocksToBrokerText(content)
  const text = typeof content === 'string' ? content : String(content || '')
  if (!text.trim().startsWith('[')) return text
  try {
    const parsed = JSON.parse(text)
    return isContentBlockArray(parsed) ? contentBlocksToBrokerText(parsed) : text
  } catch {
    return text
  }
}

/**
 * Convert ContentBlock[] to multimodal format for /v1/responses API.
 */
export async function convertContentBlocks(blocks: ContentBlock[]): Promise<ResponseContentPart[]> {
  const parts: ResponseContentPart[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'input_text', text: block.text })
    } else if (block.type === 'image') {
      const dataUri = await imageBlockToDataUri(block)
      if (dataUri) {
        parts.push({ type: 'input_image', image_url: dataUri })
      } else {
        parts.push({ type: 'input_text', text: `[Image: ${block.path}]` })
      }
    } else if (block.type === 'file') {
      parts.push({ type: 'input_text', text: `[File: ${block.name || block.path}]` })
    }
  }

  return parts
}

/**
 * Convert ContentBlock[] to the normalized multimodal shape Hermes agent
 * receives after /v1/responses input normalization.
 */
export async function convertContentBlocksForAgent(blocks: ContentBlock[]): Promise<AgentContentPart[]> {
  const parts: AgentContentPart[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text || '' })
    } else if (block.type === 'image') {
      parts.push({
        type: 'text',
        text: `[Attached image: ${block.name || block.path}]\nLocal image path for tools: ${block.path}`,
      })
      const dataUri = await imageBlockToDataUri(block)
      if (dataUri) {
        parts.push({ type: 'image_url', image_url: { url: dataUri } })
      }
    } else if (block.type === 'file') {
      parts.push({
        type: 'text',
        text: `[Attached file: ${block.name || block.path}]\nLocal file path for tools: ${block.path}`,
      })
    }
  }
  return parts
}

async function imageBlockToDataUri(block: Extract<ContentBlock, { type: 'image' }>): Promise<string | null> {
  try {
    const fs = await import('fs/promises')
    const path = await import('path')
    const buf = await fs.readFile(block.path)
    const ext = path.extname(block.path).toLowerCase().replace('.', '')
    const mimeFromExt = ext === 'jpg' ? 'jpeg' : ext || 'png'
    const mime = block.media_type?.startsWith('image/')
      ? block.media_type.slice('image/'.length)
      : mimeFromExt
    return `data:image/${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

/**
 * Flatten a stored session's message history into the OpenAI-style message array
 * the run-broker (:8766 multitenancy gateway) expects. Fork-only: the broker run
 * path (handle-broker-run.ts) replays history to the external broker rather than
 * the local agent-bridge. Ported from origin/main during the upstream re-baseline.
 */
export function buildBrokerMessagesForSession(messages: SessionMessage[]): Array<Record<string, any>> {
  const brokerMessages: Array<Record<string, any>> = []
  for (const message of messages) {
    const role = message.role
    const content = brokerContentForStoredMessage(message.content)
    if (role === 'user') {
      if (content.trim()) brokerMessages.push({ role: 'user', content })
      continue
    }
    if (role === 'assistant') {
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      if (content.trim()) {
        brokerMessages.push({ role: 'assistant', content })
      } else if (toolCalls.length) {
        brokerMessages.push({ role: 'assistant', content: '', tool_calls: toolCalls })
      }
      continue
    }
    if (role === 'tool' && content.trim()) {
      brokerMessages.push({
        role: 'user',
        content: `[Tool result: ${content}]`,
      })
    }
  }
  return brokerMessages
}
