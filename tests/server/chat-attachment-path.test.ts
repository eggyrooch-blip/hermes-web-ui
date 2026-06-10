import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

// Point the uploaded-file resolver at a tmp workspace.
let tmpRoot = ''
vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: () => tmpRoot,
}))

import { buildResponsesInput } from '../../packages/server/src/services/hermes/chat-run-socket'

function stageUpload(name: string, body: string) {
  const dir = join(tmpRoot, 'workspace', 'uploads')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), body)
}

describe('DM attachment path passthrough (readInlineFileBlock via buildResponsesInput)', () => {
  beforeEach(() => { tmpRoot = mkdtempSync(join(tmpdir(), 'hwui-dm-attach-')) })
  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  it('hands the agent a real path for a non-inlineable file (zip)', async () => {
    stageUpload('bundle.zip', 'PKbinary')
    const out = await buildResponsesInput(
      [{ type: 'text', text: '看看这个' }, { type: 'file', name: 'bundle.zip', path: 'uploads/bundle.zip', media_type: 'application/zip' }],
      'p1',
    )
    const text = typeof out === 'string' ? out : JSON.stringify(out)
    expect(text).toContain('workspace/uploads/bundle.zip')   // absolute resolvedPath
    expect(text).toContain('uploads/bundle.zip')             // relative hint
    expect(text).not.toContain('PKbinary')                   // bytes NOT dumped
  })

  it('still inlines the content of a text file', async () => {
    stageUpload('notes.txt', 'INLINE-ME-123')
    const out = await buildResponsesInput(
      [{ type: 'file', name: 'notes.txt', path: 'uploads/notes.txt', media_type: 'text/plain' }],
      'p1',
    )
    const text = typeof out === 'string' ? out : JSON.stringify(out)
    expect(text).toContain('INLINE-ME-123')
  })

  it('falls back to a bare marker when the file is missing', async () => {
    const out = await buildResponsesInput(
      [{ type: 'file', name: 'gone.zip', path: 'uploads/gone.zip', media_type: 'application/zip' }],
      'p1',
    )
    const text = typeof out === 'string' ? out : JSON.stringify(out)
    expect(text).toContain('[File: gone.zip]')
  })
})
