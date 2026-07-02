import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Chat-plane download of agent-produced artifacts: the client sends the
// display path `/workspace/<rel>` (from MEDIA rewrites / file cards). The
// route must treat it as workspace-relative — WITHOUT weakening the
// sensitive-path blocklist or the host-absolute-path rejection.
// Regression for: "Absolute downloads are not available in chat plane"
// (songtingting, 2026-07-02).

const tempRoot = mkdtempSync(join(tmpdir(), 'dl-chatplane-'))
const profileDir = join(tempRoot, 'profile')
const workspaceDir = join(profileDir, 'workspace')
const uploadDir = join(tempRoot, 'upload')

let chatPlane = true

vi.mock('../../packages/server/src/services/request-context', () => ({
  isChatPlaneRequest: () => chatPlane,
  getRequestProfileDir: () => profileDir,
}))

vi.mock('../../packages/server/src/services/hermes/file-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/server/src/services/hermes/file-provider')>()
  return {
    ...actual,
    // Admin-plane non-upload absolute paths route through createFileProvider;
    // pin it to the local provider so the test stays on the real filesystem.
    createFileProvider: async () => actual.localProvider,
  }
})

import { config } from '../../packages/server/src/config'
import { downloadRoutes } from '../../packages/server/src/routes/hermes/download'

const middleware = downloadRoutes.routes()

async function request(path: string): Promise<any> {
  const ctx: any = {
    method: 'GET',
    path: '/api/hermes/download',
    query: { path },
    headers: {},
    request: {},
    state: {},
    status: 404,
    body: undefined,
    set: vi.fn(),
  }
  await middleware(ctx, async () => {})
  return ctx
}

mkdirSync(join(workspaceDir, 'Downloads'), { recursive: true })
mkdirSync(join(workspaceDir, 'credentials'), { recursive: true })
mkdirSync(uploadDir, { recursive: true })
writeFileSync(join(workspaceDir, 'Downloads', 'a.pptx'), 'PPTX-BYTES')
writeFileSync(join(workspaceDir, 'Downloads', 'a b 报告.pptx'), '中文-BYTES')
writeFileSync(join(workspaceDir, 'credentials', 'token'), 'SECRET')
writeFileSync(join(workspaceDir, 'config.yaml'), 'SECRET')
writeFileSync(join(workspaceDir, '.env'), 'SECRET')
writeFileSync(join(profileDir, 'config.yaml'), 'SECRET')
writeFileSync(join(uploadDir, 'up.bin'), 'UPLOAD-BYTES')

const originalUploadDir = config.uploadDir

beforeEach(() => {
  chatPlane = true
  config.uploadDir = uploadDir
})

afterAll(() => {
  config.uploadDir = originalUploadDir
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('chat-plane /workspace/ display-path downloads', () => {
  it('downloads a produced artifact via its /workspace/ display path', async () => {
    const ctx = await request('/workspace/Downloads/a.pptx')
    expect(ctx.body?.error).toBeUndefined()
    expect(Buffer.isBuffer(ctx.body)).toBe(true)
    expect(ctx.body.toString()).toBe('PPTX-BYTES')
  })

  it('handles spaces and CJK in the file name byte-for-byte', async () => {
    const ctx = await request('/workspace/Downloads/a b 报告.pptx')
    expect(ctx.body?.error).toBeUndefined()
    expect(Buffer.isBuffer(ctx.body)).toBe(true)
    expect(ctx.body.toString()).toBe('中文-BYTES')
  })

  it('still blocks sensitive paths after prefix normalization', async () => {
    for (const p of ['/workspace/credentials/token', '/workspace/config.yaml', '/workspace/.env']) {
      const ctx = await request(p)
      expect(ctx.status, p).toBe(403)
      expect(ctx.body?.code, p).toBe('permission_denied')
    }
  })

  it('still blocks path traversal after prefix normalization', async () => {
    // Sensitive filename: the blocklist fires first (403) — either rejection
    // is acceptable, escaping the workspace is not.
    const sensitive = await request('/workspace/../config.yaml')
    expect(sensitive.status).toBe(403)
    expect(sensitive.body?.code).toBe('permission_denied')

    // Non-sensitive filename: rejected by the traversal guard itself.
    const traversal = await request('/workspace/../notes.txt')
    expect(traversal.status).toBe(400)
    expect(traversal.body?.code).toBe('invalid_path')
  })

  it('does not resolve percent-encoded traversal to a parent file', async () => {
    // A double-encoded client value reaches the route as literal %2e%2e — it
    // must resolve inside the workspace (404), never to profile config.yaml.
    const ctx = await request('/workspace/%2e%2e/config.yaml')
    expect(ctx.status).not.toBe(200)
    expect(Buffer.isBuffer(ctx.body)).toBe(false)
  })

  it('rejects host-absolute paths outside the upload dir unchanged', async () => {
    const ctx = await request('/etc/passwd')
    expect(ctx.status).toBe(400)
    expect(ctx.body?.error).toContain('Absolute downloads are not available in chat plane')
  })

  it('only strips the exact /workspace/ prefix', async () => {
    for (const p of ['/workspace', '/workspace/', '/workspace-not/foo']) {
      const ctx = await request(p)
      expect(ctx.status, p).toBe(400)
      expect(ctx.body?.error, p).toContain('Absolute downloads are not available in chat plane')
    }
  })

  it('keeps the upload-dir absolute-path allowance unchanged', async () => {
    const ctx = await request(join(uploadDir, 'up.bin'))
    expect(ctx.body?.error).toBeUndefined()
    expect(ctx.body.toString()).toBe('UPLOAD-BYTES')
  })
})

describe('admin plane stays untouched', () => {
  it('does not strip /workspace/ for admin requests', async () => {
    chatPlane = false
    const ctx = await request('/workspace/Downloads/a.pptx')
    // Admin plane treats it as a host-absolute path (no such host file) —
    // it must NOT resolve to the chat profile's workspace artifact.
    expect(ctx.status).not.toBe(200)
    expect(Buffer.isBuffer(ctx.body)).toBe(false)
  })
})
