import { beforeEach, describe, expect, it, vi } from 'vitest'

const provider = {
  readFile: vi.fn(),
}

const createFileProviderMock = vi.fn(async () => provider)
const isInUploadDirMock = vi.fn(() => false)
const isSensitivePathMock = vi.fn((relativePath: string) => relativePath === '.env')
const validatePathMock = vi.fn((filePath: string) => filePath)
const resolveHermesPathMock = vi.fn((relativePath: string, profile?: string) => {
  const normalized = relativePath.replace(/^\/+/, '')
  const base = profile ? `/profiles/${profile}` : '/profiles/default'
  return normalized ? `${base}/${normalized}` : base
})
const isChatPlaneRequestMock = vi.fn(() => false)
const getRequestProfileDirMock = vi.fn(() => '/tmp/hermes-preview-profile')

vi.mock('../../packages/server/src/services/hermes/file-provider', () => ({
  createFileProvider: createFileProviderMock,
  localProvider: provider,
  isInUploadDir: isInUploadDirMock,
  isSensitivePath: isSensitivePathMock,
  validatePath: validatePathMock,
  resolveHermesPath: resolveHermesPathMock,
}))

vi.mock('../../packages/server/src/services/request-context', () => ({
  isChatPlaneRequest: isChatPlaneRequestMock,
  getRequestProfileDir: getRequestProfileDirMock,
}))

async function runPreviewRoute(ctx: any) {
  const { downloadRoutes } = await import('../../packages/server/src/routes/hermes/download')
  const layer = downloadRoutes.stack.find((entry: any) => entry.path === '/api/hermes/preview')
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

function createCtx(query: Record<string, string | undefined>) {
  const headers: Record<string, string> = {}
  return {
    query,
    state: { profile: { name: 'research' } },
    body: null,
    status: 200,
    set(name: string, value: string) {
      headers[name] = value
    },
    headers,
  }
}

describe('preview route', () => {
  beforeEach(() => {
    vi.resetModules()
    provider.readFile.mockReset()
    createFileProviderMock.mockClear()
    isInUploadDirMock.mockReset()
    isInUploadDirMock.mockReturnValue(false)
    isSensitivePathMock.mockClear()
    validatePathMock.mockClear()
    resolveHermesPathMock.mockClear()
    isChatPlaneRequestMock.mockReset()
    isChatPlaneRequestMock.mockReturnValue(false)
    getRequestProfileDirMock.mockClear()
    getRequestProfileDirMock.mockReturnValue('/tmp/hermes-preview-profile')
  })

  it('serves preview responses inline without attachment disposition', async () => {
    provider.readFile.mockResolvedValue(Buffer.from('<html><body>preview</body></html>'))
    const ctx = createCtx({ path: 'workspace/report.html', name: 'report.html' })

    await runPreviewRoute(ctx)

    expect(createFileProviderMock).toHaveBeenCalledWith('research')
    expect(resolveHermesPathMock).toHaveBeenCalledWith('workspace/report.html', 'research')
    expect(provider.readFile).toHaveBeenCalledWith('/profiles/research/workspace/report.html')
    expect(ctx.status).toBe(200)
    expect(ctx.headers['Content-Type']).toBe('text/html')
    expect(ctx.headers['Content-Disposition']).toBe('inline')
    expect(ctx.headers['Content-Disposition']).not.toContain('attachment')
    expect(ctx.headers['X-Frame-Options']).toBe('SAMEORIGIN')
    expect(ctx.headers['Content-Security-Policy']).toBe("frame-ancestors 'self'")
    expect(ctx.headers['Cache-Control']).toBe('no-cache')
    expect(ctx.body).toEqual(Buffer.from('<html><body>preview</body></html>'))
  })

  it('rejects chat-plane sensitive relative paths', async () => {
    isChatPlaneRequestMock.mockReturnValue(true)
    const ctx = createCtx({ path: 'config.yaml' })

    await runPreviewRoute(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Cannot download sensitive file', code: 'permission_denied' })
    expect(provider.readFile).not.toHaveBeenCalled()
    expect(Buffer.isBuffer(ctx.body)).toBe(false)
  })

  it('rejects chat-plane traversal paths', async () => {
    isChatPlaneRequestMock.mockReturnValue(true)
    const ctx = createCtx({ path: '../secrets/report.html' })

    await runPreviewRoute(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Invalid file path', code: 'invalid_path' })
    expect(provider.readFile).not.toHaveBeenCalled()
    expect(Buffer.isBuffer(ctx.body)).toBe(false)
  })
})
