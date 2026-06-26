import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rewriteAssistantMediaDirectives } from '../../packages/server/src/services/hermes/media-directives'

const profileDir = mkdtempSync(join(tmpdir(), 'media-dir-'))
const workspaceDir = join(profileDir, 'workspace')

mkdirSync(workspaceDir, { recursive: true })
writeFileSync(join(workspaceDir, 'report.html'), '<html></html>')

afterAll(() => {
  rmSync(profileDir, { recursive: true, force: true })
})

describe('rewriteAssistantMediaDirectives', () => {
  it('rewrites resolvable workspace media directives into markdown file links', () => {
    const content = `MEDIA:${join(workspaceDir, 'report.html')}`
    expect(rewriteAssistantMediaDirectives({ content, profileDir })).toBe(
      '[report.html](/workspace/report.html)',
    )
  })

  it('keeps non-resolvable media directives unchanged', () => {
    const content = 'MEDIA:/no/such/path/missing.html'
    expect(rewriteAssistantMediaDirectives({ content, profileDir })).toBe(content)
  })
})
