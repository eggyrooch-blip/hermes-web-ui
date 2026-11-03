import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

// Control where uploader/agent workspaces live, and who the uploader is.
let tmpRoot = ''
vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: (profile: string) => join(tmpRoot, 'profiles', profile),
}))
vi.mock('../../packages/server/src/services/request-context', () => ({
  resolveProfileForOpenId: () => 'uploader',
}))

import { enrichInputWithAttachments } from '../../packages/server/src/services/hermes/group-chat/attachment-enrichment'

const BASE = '群聊系统：...\n\n原始消息：@助手 看看这个'

function stageUpload(name: string, body: string) {
  const dir = join(tmpRoot, 'profiles', 'uploader', 'workspace', 'uploads')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), body)
}

describe('group-chat attachment enrichment', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'hwui-gc-attach-'))
  })
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('leaves a plain-string message untouched', async () => {
    const out = await enrichInputWithAttachments('agentX', 'open_sender', 'hello world', BASE)
    expect(out).toBe(BASE)
  })

  it('leaves a block array with no file blocks untouched', async () => {
    const out = await enrichInputWithAttachments('agentX', 'open_sender', [{ type: 'text', text: 'hi' }], BASE)
    expect(out).toBe(BASE)
  })

  it('copies a text file into the agent workspace and inlines its content', async () => {
    stageUpload('notes.txt', 'SECRET-PAYLOAD-123')
    const out = await enrichInputWithAttachments(
      'agentX', 'open_sender',
      [{ type: 'text', text: '@助手' }, { type: 'file', name: 'notes.txt', path: 'uploads/notes.txt', media_type: 'text/plain' }],
      BASE,
    )
    expect(out).toContain('[File: notes.txt]')
    expect(out).toContain('SECRET-PAYLOAD-123')
    // physically copied into the AGENT's own workspace (isolation)
    expect(existsSync(join(tmpRoot, 'profiles', 'agentX', 'workspace', 'uploads', 'notes.txt'))).toBe(true)
  })

  it('copies a binary file and references its path without inlining bytes', async () => {
    stageUpload('bundle.zip', 'PKbinary')
    const out = await enrichInputWithAttachments(
      'agentX', 'open_sender',
      [{ type: 'text', text: '@助手' }, { type: 'file', name: 'bundle.zip', path: 'uploads/bundle.zip', media_type: 'application/zip' }],
      BASE,
    )
    expect(out).toContain('workspace/uploads/bundle.zip')
    expect(out).not.toContain('PKbinary')
    expect(existsSync(join(tmpRoot, 'profiles', 'agentX', 'workspace', 'uploads', 'bundle.zip'))).toBe(true)
  })

  it('refuses a path that escapes the uploader workspace (no copy, marker only)', async () => {
    const out = await enrichInputWithAttachments(
      'agentX', 'open_sender',
      [{ type: 'file', name: 'passwd', path: '../../../../etc/passwd', media_type: 'text/plain' }],
      BASE,
    )
    expect(out).toContain('未能定位到文件')
    expect(out).not.toContain('root:')
  })
})
