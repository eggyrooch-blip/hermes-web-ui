import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Every files route must hand the provider the canonical path that
// resolveWorkspaceRealPath validated, never the caller-supplied alias. If the
// route checks `link.txt` and then opens `link.txt`, the link can be swapped
// between the check and the open (symlink TOCTOU).
//
// The fixture runs on a real temp tree with real symlinks. The provider is the
// real LocalFileProvider wrapped in a spy that records the path of each call.
// The temp root is deliberately NOT realpath'd: on macOS tmpdir is itself a
// symlink (/var -> /private/var), so the workspace path and its canonical form
// differ there, which is the shape a symlinked profile home has in production.

const state = vi.hoisted(() => ({
  profileDir: '',
  calls: [] as Array<{ method: string; args: string[] }>,
  roots: [] as Array<string | undefined>,
  // Runs just before the real provider method, i.e. after the route validated
  // the path: the exact window a racing tenant agent would use.
  beforeCall: null as null | ((method: string) => void),
}))

vi.mock('../../packages/server/src/services/request-context', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    isChatPlaneRequest: () => true,
    getRequestProfileDir: () => state.profileDir,
  }
})

vi.mock('../../packages/server/src/services/hermes/file-provider', async (importOriginal) => {
  const actual = await importOriginal<any>()
  class SpyLocalFileProvider extends actual.LocalFileProvider {
    constructor(...args: any[]) {
      super(...args)
      state.roots.push(args[0])
    }
  }
  for (const method of ['readFile', 'stat', 'listDir', 'writeFile', 'deleteFile', 'deleteDir', 'renameFile', 'mkDir', 'copyFile']) {
    const original = actual.LocalFileProvider.prototype[method]
    ;(SpyLocalFileProvider.prototype as any)[method] = function (this: any, ...args: any[]) {
      state.calls.push({ method, args: args.filter(arg => typeof arg === 'string') })
      state.beforeCall?.(method)
      return original.apply(this, args)
    }
  }
  return { ...actual, LocalFileProvider: SpyLocalFileProvider }
})

async function runFileRoute(path: string, ctx: any) {
  const { fileRoutes } = await import('../../packages/server/src/routes/hermes/files')
  const layer = fileRoutes.stack.find((entry: any) => entry.path === path)
  if (!layer) throw new Error(`Missing file route ${path}`)
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

function makeCtx(init: { query?: Record<string, string>; body?: Record<string, unknown>; headers?: Record<string, string>; req?: any }) {
  const headers = init.headers || {}
  return {
    query: init.query || {},
    request: { body: init.body || {} },
    state: { profile: { name: 'mine' } },
    get: (name: string) => headers[name.toLowerCase()] || '',
    req: init.req,
    status: 200,
    body: null as any,
  } as any
}

function callsOf(method: string) {
  return state.calls.filter(call => call.method === method).map(call => call.args)
}

describe('files routes open the canonical path they validated', () => {
  let base: string
  let workspace: string
  let realRoot: string
  let outside: string

  beforeEach(() => {
    vi.resetModules()
    state.calls = []
    state.roots = []
    state.beforeCall = null
    base = mkdtempSync(join(tmpdir(), 'hermes-files-realpath-'))
    state.profileDir = join(base, 'profiles', 'mine')
    workspace = join(state.profileDir, 'workspace')
    outside = join(base, 'outside')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outside, { recursive: true })
    realRoot = realpathSync(workspace)

    writeFileSync(join(workspace, 'real.txt'), 'real content')
    symlinkSync('real.txt', join(workspace, 'link.txt'))
    mkdirSync(join(workspace, 'realdir'))
    writeFileSync(join(workspace, 'realdir', 'inner.txt'), 'inner')
    symlinkSync('realdir', join(workspace, 'linkdir'))
    writeFileSync(join(outside, 'secret.txt'), 'other tenant')
    symlinkSync('/etc/hosts', join(workspace, 'evil.txt'))
    symlinkSync(join(outside, 'secret.txt'), join(workspace, 'evil-out.txt'))
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('read: provider.readFile receives <realroot>/real.txt for link.txt', async () => {
    const ctx = makeCtx({ query: { path: 'link.txt' } })
    await runFileRoute('/api/hermes/files/read', ctx)
    expect(callsOf('readFile')).toEqual([[join(realRoot, 'real.txt')]])
    expect(ctx.body).toMatchObject({ content: 'real content', path: 'link.txt' })
  })

  it('stat: provider.stat receives <realroot>/real.txt for link.txt', async () => {
    const ctx = makeCtx({ query: { path: 'link.txt' } })
    await runFileRoute('/api/hermes/files/stat', ctx)
    expect(callsOf('stat')).toEqual([[join(realRoot, 'real.txt')]])
    expect(ctx.status).toBe(200)
  })

  it('stat: nested entries keep their workspace-relative path', async () => {
    const ctx = makeCtx({ query: { path: 'realdir/inner.txt' } })
    await runFileRoute('/api/hermes/files/stat', ctx)
    expect(callsOf('stat')).toEqual([[join(realRoot, 'realdir', 'inner.txt')]])
    expect(ctx.body).toMatchObject({ name: 'inner.txt', path: 'realdir/inner.txt' })
  })

  it('list: provider.listDir receives the canonical directory', async () => {
    const ctx = makeCtx({ query: { path: 'linkdir' } })
    await runFileRoute('/api/hermes/files/list', ctx)
    expect(callsOf('listDir')).toEqual([[join(realRoot, 'realdir')]])
    // Paths stay in the alias form the client navigated with, so the tree keys
    // and the next click stay under `linkdir`. Every later request re-validates.
    expect(ctx.body.entries.map((entry: any) => entry.path)).toEqual(['linkdir/inner.txt'])
  })

  it('write: provider.writeFile receives <realroot>/real.txt for link.txt', async () => {
    const ctx = makeCtx({ body: { path: 'link.txt', content: 'updated' } })
    await runFileRoute('/api/hermes/files/write', ctx)
    expect(callsOf('writeFile')).toEqual([[join(realRoot, 'real.txt')]])
    expect(readFileSync(join(workspace, 'real.txt'), 'utf-8')).toBe('updated')
  })

  it('write: a new file under a symlinked dir lands in the canonical parent with the same name', async () => {
    const ctx = makeCtx({ body: { path: 'linkdir/fresh.txt', content: 'new' } })
    await runFileRoute('/api/hermes/files/write', ctx)
    expect(callsOf('writeFile')).toEqual([[join(realRoot, 'realdir', 'fresh.txt')]])
    expect(ctx.body).toEqual({ ok: true, path: 'linkdir/fresh.txt' })
    expect(readFileSync(join(workspace, 'realdir', 'fresh.txt'), 'utf-8')).toBe('new')
  })

  it('write: a target whose parents do not exist keeps the full missing tail', async () => {
    const ctx = makeCtx({ body: { path: 'new/dir/file.txt', content: 'x' } })
    await runFileRoute('/api/hermes/files/write', ctx)
    expect(callsOf('writeFile')).toEqual([[join(realRoot, 'new', 'dir', 'file.txt')]])
  })

  it('delete: removes the link entry itself and leaves its target intact', async () => {
    const ctx = makeCtx({ body: { path: 'link.txt' } })
    await runFileRoute('/api/hermes/files/delete', ctx)
    expect(callsOf('deleteFile')).toEqual([[join(realRoot, 'link.txt')]])
    expect(ctx.body).toEqual({ ok: true })
    expect(existsSync(join(workspace, 'link.txt'))).toBe(false)
    expect(readFileSync(join(workspace, 'real.txt'), 'utf-8')).toBe('real content')
  })

  it('delete recursive: a symlinked directory loses only the link', async () => {
    const ctx = makeCtx({ body: { path: 'linkdir', recursive: true } })
    await runFileRoute('/api/hermes/files/delete', ctx)
    expect(callsOf('deleteDir')).toEqual([[join(realRoot, 'linkdir')]])
    expect(ctx.body).toEqual({ ok: true })
    expect(readFileSync(join(workspace, 'realdir', 'inner.txt'), 'utf-8')).toBe('inner')
  })

  it('rename: moves the link entry, and the destination resolves to canonical form', async () => {
    const ctx = makeCtx({ body: { oldPath: 'link.txt', newPath: 'linkdir/moved.txt' } })
    await runFileRoute('/api/hermes/files/rename', ctx)
    expect(callsOf('renameFile')).toEqual([[join(realRoot, 'link.txt'), join(realRoot, 'realdir', 'moved.txt')]])
    expect(readFileSync(join(workspace, 'real.txt'), 'utf-8')).toBe('real content')
  })

  it('copy: both paths are resolved to canonical form independently', async () => {
    const ctx = makeCtx({ body: { srcPath: 'link.txt', destPath: 'linkdir/copy.txt' } })
    await runFileRoute('/api/hermes/files/copy', ctx)
    expect(callsOf('copyFile')).toEqual([[join(realRoot, 'real.txt'), join(realRoot, 'realdir', 'copy.txt')]])
    expect(readFileSync(join(workspace, 'realdir', 'copy.txt'), 'utf-8')).toBe('real content')
  })

  it('mkdir: provider.mkDir receives the canonical parent plus the new segments', async () => {
    const ctx = makeCtx({ body: { path: 'linkdir/a/b' } })
    await runFileRoute('/api/hermes/files/mkdir', ctx)
    expect(callsOf('mkDir')).toEqual([[join(realRoot, 'realdir', 'a', 'b')]])
  })

  it('upload: provider.writeFile receives the canonical target', async () => {
    const boundary = 'XBOUNDARY'
    const raw = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="up.txt"\r\n\r\nuploaded\r\n--${boundary}--\r\n`,
    )
    const ctx = makeCtx({
      query: { path: 'linkdir' },
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      req: Readable.from([raw]),
    })
    await runFileRoute('/api/hermes/files/upload', ctx)
    expect(callsOf('writeFile')).toEqual([[join(realRoot, 'realdir', 'up.txt')]])
    expect(ctx.body).toEqual({ files: [{ name: 'up.txt', path: 'linkdir/up.txt' }] })
  })

  it('write: an in-workspace dangling link is a valid target and creates its target', async () => {
    mkdirSync(join(workspace, 'notes'))
    symlinkSync('notes/todo.txt', join(workspace, 'draft.txt'))
    const ctx = makeCtx({ body: { path: 'draft.txt', content: 'todo' } })
    await runFileRoute('/api/hermes/files/write', ctx)
    expect(ctx.body).toEqual({ ok: true, path: 'draft.txt' })
    expect(callsOf('writeFile')).toEqual([[join(realRoot, 'notes', 'todo.txt')]])
    expect(readFileSync(join(workspace, 'notes', 'todo.txt'), 'utf-8')).toBe('todo')
  })

  it('provider is rooted at the canonical workspace', async () => {
    const ctx = makeCtx({ query: { path: 'real.txt' } })
    await runFileRoute('/api/hermes/files/read', ctx)
    expect(state.roots).toEqual([realRoot])
  })

  it('evil.txt -> /etc/hosts is still 403 and never opened', async () => {
    const ctx = makeCtx({ query: { path: 'evil.txt' } })
    await runFileRoute('/api/hermes/files/read', ctx)
    expect(ctx.status).toBe(403)
    expect(ctx.body).toMatchObject({ code: 'permission_denied' })
    expect(callsOf('readFile')).toEqual([])
  })

  it('a link to another tenant file is 403 for write and leaves it untouched', async () => {
    const ctx = makeCtx({ body: { path: 'evil-out.txt', content: 'pwned' } })
    await runFileRoute('/api/hermes/files/write', ctx)
    expect(ctx.status).toBe(403)
    expect(callsOf('writeFile')).toEqual([])
    expect(readFileSync(join(outside, 'secret.txt'), 'utf-8')).toBe('other tenant')
  })

  it('a dangling link that points outside the workspace is 403 and creates nothing', async () => {
    const victim = join(outside, 'created-by-attacker.txt')
    symlinkSync(victim, join(workspace, 'dangle.txt'))
    const ctx = makeCtx({ body: { path: 'dangle.txt', content: 'pwned' } })
    await runFileRoute('/api/hermes/files/write', ctx)
    expect(ctx.status).toBe(403)
    expect(callsOf('writeFile')).toEqual([])
    expect(existsSync(victim)).toBe(false)
  })

  describe('canonical name swapped for a symlink after validation', () => {
    function swapToLink(entry: string, target: string) {
      return (method: string) => {
        if (method === 'stat' || method === 'listDir') return
        const p = join(workspace, entry)
        rmSync(p, { recursive: true, force: true })
        symlinkSync(target, p)
      }
    }

    it('read is 403 and never returns the swapped-in target', async () => {
      state.beforeCall = swapToLink('real.txt', join(outside, 'secret.txt'))
      const ctx = makeCtx({ query: { path: 'real.txt' } })
      await runFileRoute('/api/hermes/files/read', ctx)
      expect(ctx.status).toBe(403)
      expect(ctx.body).toMatchObject({ code: 'permission_denied' })
      expect(JSON.stringify(ctx.body)).not.toContain('other tenant')
    })

    it('write is 403 and leaves the swapped-in target untouched', async () => {
      state.beforeCall = swapToLink('real.txt', join(outside, 'secret.txt'))
      const ctx = makeCtx({ body: { path: 'real.txt', content: 'pwned' } })
      await runFileRoute('/api/hermes/files/write', ctx)
      expect(ctx.status).toBe(403)
      expect(readFileSync(join(outside, 'secret.txt'), 'utf-8')).toBe('other tenant')
    })

    it('copy is 403 and does not copy the swapped-in source', async () => {
      state.beforeCall = swapToLink('real.txt', join(outside, 'secret.txt'))
      const ctx = makeCtx({ body: { srcPath: 'real.txt', destPath: 'copy.txt' } })
      await runFileRoute('/api/hermes/files/copy', ctx)
      expect(ctx.status).toBe(403)
      expect(existsSync(join(workspace, 'copy.txt')) && readFileSync(join(workspace, 'copy.txt'), 'utf-8')).not.toBe('other tenant')
    })

    it('copy is 403 when the destination is swapped and leaves the target untouched', async () => {
      writeFileSync(join(workspace, 'dest.txt'), 'old')
      state.beforeCall = swapToLink('dest.txt', join(outside, 'secret.txt'))
      const ctx = makeCtx({ body: { srcPath: 'real.txt', destPath: 'dest.txt' } })
      await runFileRoute('/api/hermes/files/copy', ctx)
      expect(ctx.status).toBe(403)
      expect(readFileSync(join(outside, 'secret.txt'), 'utf-8')).toBe('other tenant')
    })

    it('mkdir is 403 when the last existing hop is swapped for a directory link', async () => {
      mkdirSync(join(workspace, 'fresh'))
      state.beforeCall = swapToLink('fresh', outside)
      const ctx = makeCtx({ body: { path: 'fresh/a/b' } })
      await runFileRoute('/api/hermes/files/mkdir', ctx)
      expect(ctx.status).toBe(403)
      expect(existsSync(join(outside, 'a'))).toBe(false)
    })
  })

  it('a symlinked alias of a blocked directory is 403 for new files under it', async () => {
    mkdirSync(join(workspace, 'credentials'))
    symlinkSync('credentials', join(workspace, 'vault'))
    const ctx = makeCtx({ body: { path: 'vault/new.txt', content: 'x' } })
    await runFileRoute('/api/hermes/files/write', ctx)
    expect(ctx.status).toBe(403)
    expect(callsOf('writeFile')).toEqual([])
  })
})
