import { existsSync } from 'fs'
import { mkdir, copyFile, readFile } from 'fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'path'
import { config } from '../../../config'
import { logger } from '../../../services/logger'
import { getProfileDir } from '../hermes-profile'
import { resolveProfileForOpenId } from '../../request-context'
import type { ContentBlock } from '../run-chat/types'

// Mirror of chat-run-socket's inline predicate. Group chat only inlines plain
// text files; binary/spreadsheet/image attachments are copied into the agent's
// workspace and referenced by path (the agent opens them with its own tools).
// NOTE: spreadsheet (.xlsx) inlining and image base64 multimodal are
// intentionally OUT OF SCOPE here — those are handled by the single-chat path.
const TEXT_FILE_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml',
  '.xml', '.html', '.css', '.js', '.ts', '.tsx', '.jsx', '.py', '.sh', '.log',
])
const MAX_INLINE_FILE_CHARS = 200_000

/**
 * Resolve the absolute source path of an uploaded attachment.
 *
 * Group-chat uploads land in the UPLOADER's profile workspace
 * (`{uploaderProfileDir}/workspace/uploads/<hex>.ext`) and the block carries a
 * relative `uploads/<hex>.ext`. We resolve the uploader profile from the sender
 * openid. The candidate must stay inside the uploader's workspace (or the global
 * upload dir for absolute paths) — never escape it.
 */
function resolveSourcePath(uploaderProfile: string | null, filePath: string): string | null {
  if (!filePath) return null

  if (isAbsolute(filePath)) {
    const absolutePath = resolve(filePath)
    const allowedRoots = [resolve(config.uploadDir)]
    if (uploaderProfile) allowedRoots.push(resolve(getProfileDir(uploaderProfile), 'workspace'))
    return allowedRoots.some(root => absolutePath === root || absolutePath.startsWith(`${root}/`))
      ? absolutePath
      : null
  }

  if (!uploaderProfile) return null
  const workspaceRoot = resolve(getProfileDir(uploaderProfile), 'workspace')
  const candidate = resolve(workspaceRoot, filePath)
  if (candidate !== workspaceRoot && !candidate.startsWith(`${workspaceRoot}/`)) return null
  return candidate
}

function isInlineableText(block: Extract<ContentBlock, { type: 'file' }>): boolean {
  const media = (block.media_type || '').toLowerCase()
  if (media.startsWith('text/')) return true
  const extension = extname(block.name || block.path).toLowerCase()
  return TEXT_FILE_EXTENSIONS.has(extension)
}

/**
 * Copy each uploaded attachment in `content` into the target agent's own
 * workspace and append a usable reference (inlined text, or an explicit path
 * for binaries) to `baseInput`. Returns the enriched input string.
 *
 * Pure string in → string out; on any per-file failure it degrades to a bare
 * marker for that file and never throws (one bad attachment must not kill the
 * whole reply).
 */
export async function enrichInputWithAttachments(
  targetProfile: string,
  senderId: string,
  content: string | ContentBlock[],
  baseInput: string,
): Promise<string> {
  if (typeof content === 'string' || !Array.isArray(content)) return baseInput

  const fileBlocks = content.filter(
    (block): block is Extract<ContentBlock, { type: 'file' | 'image' }> =>
      block.type === 'file' || block.type === 'image',
  )
  if (fileBlocks.length === 0) return baseInput

  const uploaderProfile = senderId ? resolveProfileForOpenId(senderId) : null
  const targetUploadDir = resolve(getProfileDir(targetProfile), 'workspace', 'uploads')

  const sections: string[] = []
  for (const block of fileBlocks) {
    const name = block.name || basename(block.path)
    try {
      const source = resolveSourcePath(uploaderProfile, block.path)
      if (!source || !existsSync(source)) {
        sections.push(`\n\n[附件「${name}」未能定位到文件，请告知用户重新上传。]`)
        continue
      }

      await mkdir(targetUploadDir, { recursive: true })
      const savedName = basename(source)
      const dest = join(targetUploadDir, savedName)
      await copyFile(source, dest)

      if (block.type === 'file' && isInlineableText(block)) {
        const raw = await readFile(dest, 'utf-8')
        const body = raw.length > MAX_INLINE_FILE_CHARS
          ? `${raw.slice(0, MAX_INLINE_FILE_CHARS)}\n\n[File truncated at ${MAX_INLINE_FILE_CHARS} characters]`
          : raw
        sections.push(`\n\n[File: ${name}]\n${body}`)
      } else {
        sections.push(
          `\n\n[附件「${name}」已放入你的工作目录：workspace/uploads/${savedName}` +
          `（绝对路径：${dest}）。请直接用工具读取/解压它，不要去飞书查找。]`,
        )
      }
    } catch (err: any) {
      logger.warn(`[GroupChat] attachment enrichment failed for "${name}": ${err?.message || err}`)
      sections.push(`\n\n[附件「${name}」处理失败，请告知用户重新上传。]`)
    }
  }

  return baseInput + sections.join('')
}
