import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Admin / ops plane (isChatPlaneRequest() === false) absolute-path fence.
// Regression for the 2026-10-07 adversarial audit web-ui #01: the sensitive
// blocklist only ran on relative paths and validatePath() had no root
// constraint, so any logged-in `admin` could read <APP_HOME>/.token (the JWT
// HS256 secret when AUTH_JWT_SECRET is unset) via an absolute path.

const tempRoot = mkdtempSync(join(tmpdir(), 'dl-admin-abs-'))
const hermesHome = join(tempRoot, 'hermes')
const profileDir = join(hermesHome, 'profiles', 'research')
const appHome = join(tempRoot, 'webui-home')
const uploadDir = join(appHome, 'upload')
const fakeHome = join(tempRoot, 'home')
const externalDir = join(tempRoot, 'external')

const originalHermesHome = process.env.HERMES_HOME
process.env.HERMES_HOME = hermesHome

mkdirSync(join(profileDir, 'workspace'), { recursive: true })
mkdirSync(join(profileDir, 'credentials'), { recursive: true })
mkdirSync(uploadDir, { recursive: true })
mkdirSync(join(fakeHome, '.ssh'), { recursive: true })
mkdirSync(externalDir, { recursive: true })
writeFileSync(join(appHome, '.token'), 'JWT-SECRET-TOKEN')
writeFileSync(join(profileDir, 'config.yaml'), 'PROFILE-CONFIG-SECRET')
writeFileSync(join(profileDir, '.env'), 'PROFILE-ENV-SECRET')
writeFileSync(join(profileDir, 'auth.json'), 'PROFILE-AUTH-SECRET')
writeFileSync(join(profileDir, 'credentials', 'gitlab.token'), 'CRED-SECRET')
writeFileSync(join(profileDir, 'credentials.json'), 'CRED-JSON-SECRET')
writeFileSync(join(profileDir, 'workspace', 'report.txt'), 'WORKSPACE-REPORT')
writeFileSync(join(uploadDir, 'up.bin'), 'UPLOAD-BYTES')
writeFileSync(join(fakeHome, '.ssh', 'id_rsa'), 'SSH-PRIVATE-KEY')
writeFileSync(join(externalDir, 'notes.txt'), 'EXTERNAL-NOTES')
// A symlink inside the upload dir must not smuggle an outside file past the fence.
symlinkSync(join(externalDir, 'notes.txt'), join(uploadDir, 'link-out.txt'))
// Review p1: symlinks planted in the profile workspace must not let a RELATIVE
// path read the JWT secret or an outside host file.
symlinkSync(join(appHome, '.token'), join(profileDir, 'workspace', 'link-token.txt'))
symlinkSync(join(externalDir, 'notes.txt'), join(profileDir, 'workspace', 'link-ext.txt'))

vi.mock('../../packages/server/src/services/request-context', () => ({
  isChatPlaneRequest: () => false,
  getRequestProfileDir: () => profileDir,
}))

vi.mock('../../packages/server/src/services/hermes/file-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/server/src/services/hermes/file-provider')>()
  return {
    ...actual,
    // Keep non-upload reads on the real local filesystem.
    createFileProvider: async () => actual.localProvider,
  }
})

import { config } from '../../packages/server/src/config'
import { downloadRoutes } from '../../packages/server/src/routes/hermes/download'

const middleware = downloadRoutes.routes()
const SECRETS = [
  'JWT-SECRET-TOKEN',
  'PROFILE-CONFIG-SECRET',
  'PROFILE-ENV-SECRET',
  'PROFILE-AUTH-SECRET',
  'CRED-SECRET',
  'CRED-JSON-SECRET',
  'SSH-PRIVATE-KEY',
]

type Role = 'admin' | 'super_admin' | 'user'
type Route = '/api/hermes/download' | '/api/hermes/preview'

async function request(route: Route, path: string, role: Role): Promise<any> {
  const ctx: any = {
    method: 'GET',
    path: route,
    query: { path },
    headers: {},
    request: {},
    state: { user: { id: 1, username: role, role }, profile: { name: 'research' } },
    // Koa sets 200 when a body is assigned; the route only sets status on errors.
    status: 200,
    body: undefined,
    set: vi.fn(),
  }
  await middleware(ctx, async () => {})
  return ctx
}

async function readBody(body: any): Promise<string> {
  if (body == null) return ''
  if (Buffer.isBuffer(body)) return body.toString('utf-8')
  if (typeof body === 'object' && typeof body[Symbol.asyncIterator] !== 'function') return JSON.stringify(body)
  const chunks: Buffer[] = []
  for await (const chunk of body) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf-8')
}

async function expectDenied(route: Route, path: string, role: Role) {
  const ctx = await request(route, path, role)
  const text = await readBody(ctx.body)
  expect(ctx.status, `${route} ${role} ${path}`).toBe(403)
  expect(ctx.body?.code, `${route} ${role} ${path}`).toBe('permission_denied')
  for (const secret of SECRETS) expect(text, `${route} ${role} ${path}`).not.toContain(secret)
  expect(text, `${route} ${role} ${path}`).not.toContain('EXTERNAL-NOTES')
}

async function expectServed(route: Route, path: string, role: Role, content: string) {
  const ctx = await request(route, path, role)
  expect(ctx.body?.error, `${route} ${role} ${path}`).toBeUndefined()
  expect(ctx.status, `${route} ${role} ${path}`).toBe(200)
  await expect(readBody(ctx.body)).resolves.toBe(content)
}

const originalUploadDir = config.uploadDir
const ROUTES: Route[] = ['/api/hermes/download', '/api/hermes/preview']

beforeEach(() => {
  config.uploadDir = uploadDir
})

afterAll(() => {
  config.uploadDir = originalUploadDir
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('admin plane absolute-path fence (non super_admin)', () => {
  for (const route of ROUTES) {
    it(`${route}: admin cannot read <APP_HOME>/.token, profile config.yaml, ~/.ssh/id_rsa or /etc/hosts`, async () => {
      for (const p of [
        join(appHome, '.token'),
        join(profileDir, 'config.yaml'),
        join(fakeHome, '.ssh', 'id_rsa'),
        '/etc/hosts',
        join(externalDir, 'notes.txt'),
      ]) {
        await expectDenied(route, p, 'admin')
      }
    })

    it(`${route}: admin cannot escape the upload dir through a symlink`, async () => {
      await expectDenied(route, join(uploadDir, 'link-out.txt'), 'admin')
    })

    it(`${route}: admin still reads absolute paths inside the upload dir and the profile dir`, async () => {
      await expectServed(route, join(uploadDir, 'up.bin'), 'admin', 'UPLOAD-BYTES')
      await expectServed(route, join(profileDir, 'workspace', 'report.txt'), 'admin', 'WORKSPACE-REPORT')
    })

    it(`${route}: a role-less / plain user is fenced the same way`, async () => {
      await expectDenied(route, join(appHome, '.token'), 'user')
      await expectDenied(route, '/etc/hosts', 'user')
    })
  }
})

describe('super_admin keeps host-wide reads but never sensitive files', () => {
  for (const route of ROUTES) {
    it(`${route}: super_admin reads paths outside the upload/profile dirs`, async () => {
      await expectServed(route, join(externalDir, 'notes.txt'), 'super_admin', 'EXTERNAL-NOTES')
      const ctx = await request(route, '/etc/hosts', 'super_admin')
      expect(ctx.body?.error).toBeUndefined()
      expect(ctx.status).toBe(200)
    })

    it(`${route}: sensitive files are 403 for super_admin as absolute paths`, async () => {
      for (const p of [
        join(appHome, '.token'),
        join(profileDir, '.env'),
        join(profileDir, 'config.yaml'),
        join(profileDir, 'auth.json'),
        join(profileDir, 'credentials.json'),
        join(profileDir, 'credentials', 'gitlab.token'),
        join(fakeHome, '.ssh', 'id_rsa'),
      ]) {
        await expectDenied(route, p, 'super_admin')
      }
    })
  }
})

describe('sensitive blocklist applies to relative paths for every role', () => {
  for (const route of ROUTES) {
    for (const role of ['admin', 'super_admin'] as Role[]) {
      it(`${route}: ${role} relative sensitive paths are 403`, async () => {
        for (const p of ['config.yaml', '.env', 'auth.json', 'credentials.json', 'credentials/gitlab.token', 'workspace/../config.yaml']) {
          await expectDenied(route, p, role)
        }
      })
    }

    it(`${route}: admin relative non-sensitive download is unchanged`, async () => {
      await expectServed(route, 'workspace/report.txt', 'admin', 'WORKSPACE-REPORT')
    })
  }
})

describe('relative paths are fenced on the symlink-resolved target (review p1)', () => {
  for (const route of ROUTES) {
    for (const role of ['admin', 'super_admin'] as Role[]) {
      it(`${route}: ${role} cannot read <APP_HOME>/.token through a workspace symlink`, async () => {
        await expectDenied(route, 'workspace/link-token.txt', role)
      })
    }

    it(`${route}: admin cannot read an outside file through a workspace symlink`, async () => {
      await expectDenied(route, 'workspace/link-ext.txt', 'admin')
    })

    it(`${route}: super_admin still follows a workspace symlink to a non-sensitive outside file`, async () => {
      await expectServed(route, 'workspace/link-ext.txt', 'super_admin', 'EXTERNAL-NOTES')
    })
  }
})
