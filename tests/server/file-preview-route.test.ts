import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// A real directory on disk, because the guard under test is about what the
// FILESYSTEM resolves a path to. A mocked provider would follow whatever the
// mock decided, which is exactly the thing that cannot be trusted here.
const root = mkdtempSync(join(tmpdir(), 'hermes-preview-route-'))
const profileDir = join(root, 'profile')
const workspace = join(profileDir, 'workspace')

const isChatPlaneRequestMock = vi.fn(() => true)
const getRequestProfileDirMock = vi.fn(() => profileDir)

vi.mock('../../packages/server/src/services/request-context', () => ({
  isChatPlaneRequest: isChatPlaneRequestMock,
  getRequestProfileDir: getRequestProfileDirMock,
}))

vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  requireSuperAdminOrChatPlane: vi.fn(async (_ctx: any, next: any) => { await next() }),
}))

function createCtx(path: string) {
  const headers: Record<string, string> = {}
  const req = new EventEmitter() as any
  return {
    query: { path },
    state: { profile: { name: 'tenant-a' } },
    body: null as any,
    status: 200,
    req,
    set(name: string, value: string) { headers[name] = value },
    headers,
  }
}

async function runPreviewRoute(ctx: any) {
  const { fileRoutes } = await import('../../packages/server/src/routes/hermes/files')
  const layer = fileRoutes.stack.find((entry: any) => entry.path === '/api/hermes/files/preview')
  if (!layer) throw new Error('Missing preview route')
  let index = -1
  async function dispatch(nextIndex: number): Promise<void> {
    if (nextIndex <= index) throw new Error('next() called multiple times')
    index = nextIndex
    const fn = layer.stack[nextIndex]
    if (!fn) return
    await fn(ctx, () => dispatch(nextIndex + 1))
  }
  await dispatch(0)
}

async function readStream(body: any): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body
  const chunks: Buffer[] = []
  for await (const chunk of body) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

const PDF_FIXTURE = 'tests/fixtures/file-preview/sample.pdf'

beforeAll(() => {
  mkdirSync(workspace, { recursive: true })
  copyFileSync(PDF_FIXTURE, join(workspace, 'quarterly.pdf'))
  writeFileSync(join(workspace, 'config.yaml'), 'api_key: super-secret\n')
  writeFileSync(join(workspace, 'plain.txt'), 'not a pdf\n')
  mkdirSync(join(workspace, 'reports'), { recursive: true })
  copyFileSync(PDF_FIXTURE, join(workspace, 'reports', 'real.pdf'))
  writeFileSync(join(root, 'outside-secret.pdf'), '%PDF-1.4 outside the workspace\n')

  // Hostile aliases: each one is named so that every string-level check passes.
  symlinkSync(join(workspace, 'config.yaml'), join(workspace, 'alias-to-config.pdf'))
  symlinkSync(join(workspace, 'plain.txt'), join(workspace, 'alias-to-text.pdf'))
  symlinkSync(join(root, 'outside-secret.pdf'), join(workspace, 'alias-escaping.pdf'))
  symlinkSync(join(workspace, 'reports'), join(workspace, 'reports-link'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  vi.resetModules()
  isChatPlaneRequestMock.mockReturnValue(true)
  getRequestProfileDirMock.mockReturnValue(profileDir)
})

describe('GET /api/hermes/files/preview — chat-plane path scope', () => {
  it('serves a real workspace pdf inline as a stream', async () => {
    const ctx = createCtx('quarterly.pdf')
    await runPreviewRoute(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.headers['Content-Type']).toBe('application/pdf')
    expect(ctx.headers['Content-Disposition']).toContain('inline;')
    expect(ctx.headers['X-Content-Type-Options']).toBe('nosniff')
    expect(Buffer.isBuffer(ctx.body)).toBe(false)
    const bytes = await readStream(ctx.body)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(String(bytes.length)).toBe(ctx.headers['Content-Length'])
  })

  it('serves a pdf reached through a symlinked directory inside the workspace', async () => {
    const ctx = createCtx('reports-link/real.pdf')
    await runPreviewRoute(ctx)

    expect(ctx.status).toBe(200)
    const bytes = await readStream(ctx.body)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('refuses a symlink whose canonical target is a blocklisted file', async () => {
    const ctx = createCtx('alias-to-config.pdf')
    await runPreviewRoute(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toMatchObject({ code: 'permission_denied' })
    expect(JSON.stringify(ctx.body)).not.toContain('super-secret')
  })

  it('refuses a symlink whose canonical target escapes the workspace', async () => {
    const ctx = createCtx('alias-escaping.pdf')
    await runPreviewRoute(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toMatchObject({ code: 'permission_denied' })
  })

  it('refuses a symlink whose canonical target is not a previewable format', async () => {
    const ctx = createCtx('alias-to-text.pdf')
    await runPreviewRoute(ctx)

    // The extension the caller sent says pdf; the bytes are text. Serving them
    // as application/pdf would be type confusion, so the canonical name decides.
    expect(ctx.status).toBe(415)
    expect(ctx.body).toMatchObject({ code: 'unsupported_preview' })
  })

  it('refuses blocklisted names regardless of case', async () => {
    for (const path of ['CONFIG.YAML', 'Config.Yaml', 'credentials/token.pdf', 'CREDENTIALS/token.pdf']) {
      const ctx = createCtx(path)
      await runPreviewRoute(ctx)
      expect([403, 404], path).toContain(ctx.status)
      expect(ctx.body?.code, path).not.toBe('unsupported_preview')
    }
  })

  it('refuses a blocklisted name reached through dot segments', async () => {
    const ctx = createCtx('reports/../config.yaml')
    await runPreviewRoute(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toMatchObject({ code: 'permission_denied' })
  })

  it('refuses a traversal outside the workspace', async () => {
    const ctx = createCtx('../../outside-secret.pdf')
    await runPreviewRoute(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toMatchObject({ code: 'invalid_path' })
  })

  it('refuses formats outside the preview allowlist before touching the filesystem', async () => {
    const ctx = createCtx('plain.txt')
    await runPreviewRoute(ctx)

    expect(ctx.status).toBe(415)
    expect(ctx.body).toMatchObject({ code: 'unsupported_preview' })
  })
})

describe('GET /api/hermes/files/preview — resource bounds', () => {
  it('refuses a file larger than the per-format limit without reading it', async () => {
    const big = join(workspace, 'huge.pdf')
    writeFileSync(big, Buffer.alloc(1024))
    vi.stubEnv('MAX_PDF_PREVIEW_SIZE', '512')
    try {
      const ctx = createCtx('huge.pdf')
      await runPreviewRoute(ctx)
      expect(ctx.status).toBe(413)
      expect(ctx.body).toMatchObject({ code: 'file_too_large' })
    } finally {
      vi.unstubAllEnvs()
      rmSync(big, { force: true })
    }
  })

  it('stops reading when the browser disconnects instead of buffering the whole file', async () => {
    const ctx = createCtx('quarterly.pdf')
    await runPreviewRoute(ctx)

    expect(ctx.status).toBe(200)
    const stream = ctx.body
    expect(typeof stream.destroy).toBe('function')
    expect(stream.destroyed).toBe(false)
    ctx.req.emit('close')
    expect(stream.destroyed).toBe(true)
  })

  it('serves the target it resolved, not whatever the alias points at later', async () => {
    // The request is checked against the canonical target and then read through
    // it. Re-pointing the alias afterwards must not change what goes out, which
    // is why the handle is opened on the resolved path and never on the alias.
    const alias = join(workspace, 'swappable.pdf')
    symlinkSync(join(workspace, 'quarterly.pdf'), alias)
    try {
      const ctx = createCtx('swappable.pdf')
      await runPreviewRoute(ctx)
      expect(ctx.status).toBe(200)

      rmSync(alias, { force: true })
      symlinkSync(join(workspace, 'config.yaml'), alias)

      const bytes = await readStream(ctx.body)
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
      expect(bytes.toString('latin1')).not.toContain('super-secret')
    } finally {
      rmSync(alias, { force: true })
    }
  })

  it('sends exactly Content-Length bytes even if the file grows after the size check', async () => {
    const growing = join(workspace, 'growing.pdf')
    writeFileSync(growing, Buffer.from('%PDF-1.4 initial\n'))
    try {
      const ctx = createCtx('growing.pdf')
      await runPreviewRoute(ctx)
      const promised = Number(ctx.headers['Content-Length'])

      writeFileSync(growing, Buffer.concat([
        Buffer.from('%PDF-1.4 initial\n'),
        Buffer.alloc(4096, 0x41),
      ]))
      const bytes = await readStream(ctx.body)
      expect(bytes.length).toBe(promised)
    } finally {
      rmSync(growing, { force: true })
    }
  })
})
