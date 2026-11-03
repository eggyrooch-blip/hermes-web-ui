import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  publishRunAssistantMedia,
  rewriteAssistantMediaDirectives,
} from '../../packages/server/src/services/hermes/media-directives'

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
      '[report.html](/workspace/report.html?hermes_mime=text%2Fhtml&hermes_bytes=13)',
    )
  })

  it('adds the same publication record to the MT /workspace/ alias without parsing MT output', () => {
    expect(rewriteAssistantMediaDirectives({ content: 'MEDIA:/workspace/report.html', profileDir })).toBe(
      '[report.html](/workspace/report.html?hermes_mime=text%2Fhtml&hermes_bytes=13)',
    )
  })

  it('publishes the live run assistant before run.completed reaches the client', () => {
    const messages = [{
      role: 'assistant',
      runMarker: 'run-1',
      content: '已生成\n\nMEDIA:/workspace/report.html',
    }]

    expect(publishRunAssistantMedia({
      messages,
      runMarker: 'run-1',
      profileDir,
      fallbackContent: '',
    })).toBe('已生成\n\n[report.html](/workspace/report.html?hermes_mime=text%2Fhtml&hermes_bytes=13)')
    expect(messages[0].content).toContain('hermes_mime=text%2Fhtml&hermes_bytes=13')
  })

  it('keeps an unreachable workspace alias as a friendly card instead of raw MEDIA text', () => {
    expect(rewriteAssistantMediaDirectives({
      content: 'MEDIA:/workspace/missing.html',
      profileDir,
    })).toBe('[missing.html](/workspace/missing.html)')
  })

  it('keeps an unreachable non-workspace MEDIA target as a friendly failed card', () => {
    const rendered = rewriteAssistantMediaDirectives({
      content: 'MEDIA:/missing/private/path/report.html',
      profileDir,
    })

    expect(rendered).toBe('[report.html](/workspace/Downloads/report.html)')
    expect(rendered).not.toContain('MEDIA:')
    expect(rendered).not.toContain('/missing/private/path')
  })
})
