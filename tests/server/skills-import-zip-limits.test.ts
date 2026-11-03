import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import AdmZip from 'adm-zip'

const mockGetActiveProfileName = vi.hoisted(() => vi.fn())
const mockGetProfileDir = vi.hoisted(() => vi.fn())
const mockGetHermesBaseDir = vi.hoisted(() => vi.fn())
const mockSafeReadFile = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  getSkillUsageStatsFromDb: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: mockGetActiveProfileName,
  getProfileDir: mockGetProfileDir,
  getHermesBaseDir: mockGetHermesBaseDir,
}))

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  readConfigYamlForProfile: vi.fn(async () => ({})),
  updateConfigYamlForProfile: vi.fn(),
  safeReadFile: mockSafeReadFile,
  extractDescription: vi.fn(() => ''),
  listFilesRecursive: vi.fn(async () => []),
}))

const MB = 1024 * 1024

// Build a zip whose central-directory "uncompressed size" (CENLEN) is attacker
// controlled, exactly like the GHSA-xcpc-8h2w-3j85 PoC: STORED entries holding
// one real byte each while declaring an arbitrary uncompressed size.
function forgedZip(entries: Array<{ name: string; declaredSize: number }>, declaredEntryCount = entries.length): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const loc = Buffer.alloc(30 + name.length + 1)
    loc.writeUInt32LE(0x04034b50, 0)
    loc.writeUInt16LE(0, 8)
    loc.writeUInt32LE(1, 18)
    loc.writeUInt32LE(entry.declaredSize, 22)
    loc.writeUInt16LE(name.length, 26)
    loc.writeUInt16LE(0, 28)
    name.copy(loc, 30)
    loc[30 + name.length] = 0x41

    const cen = Buffer.alloc(46 + name.length)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(0, 10)
    cen.writeUInt32LE(1, 20)
    cen.writeUInt32LE(entry.declaredSize, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt32LE(offset, 42)
    name.copy(cen, 46)

    locals.push(loc)
    centrals.push(cen)
    offset += loc.length
  }
  const cenBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(declaredEntryCount, 8)
  end.writeUInt16LE(declaredEntryCount, 10)
  end.writeUInt32LE(cenBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cenBuf, end])
}

function multipartZip(boundary: string, filename: string, zip: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`),
    Buffer.from('Content-Type: application/zip\r\n\r\n'),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
}

function importCtx(filename: string, zip: Buffer): any {
  const boundary = '----hermes-skill-import-zip-limits'
  return {
    get: vi.fn((header: string) => header.toLowerCase() === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
    req: Readable.from([multipartZip(boundary, filename, zip)]),
    state: { profile: { name: 'research' } },
    body: null,
  }
}

async function loadController() {
  vi.resetModules()
  return import('../../packages/server/src/controllers/hermes/skills')
}

async function stagingDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter(name => name.startsWith('hermes-skill-import-'))
}

describe('skills import zip limits', () => {
  let root: string
  let profileDir: string
  let maxAllocRequest: number
  const ALLOC_CAP = 64 * MB

  beforeEach(async () => {
    vi.clearAllMocks()
    root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-zip-limits-'))
    profileDir = join(root, 'research')
    mockGetActiveProfileName.mockReturnValue('default')
    mockGetProfileDir.mockReturnValue(profileDir)
    mockGetHermesBaseDir.mockReturnValue(join(root, 'shared'))
    mockSafeReadFile.mockImplementation(async (path: string) => {
      try { return await readFile(path, 'utf-8') } catch { return null }
    })

    // Record every Buffer.alloc request; refuse (instead of committing) anything
    // above the cap so a regression cannot actually allocate gigabytes here.
    maxAllocRequest = 0
    const realAlloc = Buffer.alloc.bind(Buffer)
    vi.spyOn(Buffer, 'alloc').mockImplementation(((size: number, ...rest: any[]) => {
      if (typeof size === 'number' && size > maxAllocRequest) maxAllocRequest = size
      if (typeof size === 'number' && size > ALLOC_CAP) {
        throw new Error(`test hook refused Buffer.alloc(${size})`)
      }
      return (realAlloc as any)(size, ...rest)
    }) as any)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it('rejects a ~109 byte zip declaring a 3GB entry before any large allocation', async () => {
    const zip = forgedZip([{ name: 'a.txt', declaredSize: 0xC0000000 }])
    expect(zip.length).toBe(109)
    const before = await stagingDirs()
    const ctx = importCtx('bomb.zip', zip)
    const { importSkill } = await loadController()

    await importSkill(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body.error).toMatch(/超限/)
    expect(ctx.body.error).toContain('3221225472')
    expect(maxAllocRequest).toBeLessThan(ALLOC_CAP)
    expect(await stagingDirs()).toEqual(before)
  })

  it('rejects a zip whose declared total uncompressed size exceeds 200MB', async () => {
    // six entries x 40MB = 240MB: each under the 50MB per-entry cap, total over 200MB
    const zip = forgedZip(Array.from({ length: 6 }, (_, i) => ({ name: `part-${i}.bin`, declaredSize: 40 * MB })))
    const ctx = importCtx('total.zip', zip)
    const { importSkill } = await loadController()

    await importSkill(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body.error).toMatch(/超限/)
    expect(ctx.body.error).toMatch(/total/i)
    expect(ctx.body.error).toContain(String(200 * MB))
    expect(maxAllocRequest).toBeLessThan(ALLOC_CAP)
  })

  it('rejects a zip with more than 5000 entries', async () => {
    const builder = new AdmZip()
    builder.addFile('SKILL.md', Buffer.from('# Many Files\n'))
    for (let i = 0; i < 5000; i++) builder.addFile(`files/f${i}.txt`, Buffer.alloc(0))
    const zipBuf = builder.toBuffer()
    expect(new AdmZip(zipBuf).getEntries().length).toBe(5001)
    const ctx = importCtx('many-files.zip', zipBuf)
    const { importSkill } = await loadController()

    await importSkill(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body.error).toMatch(/超限/)
    expect(ctx.body.error).toContain('5001')
    await expect(readFile(join(profileDir, 'skills', 'many-files', 'SKILL.md'), 'utf-8')).rejects.toThrow()
  }, 30_000)

  it('rejects an end record declaring more than 5000 entries before materialising them', async () => {
    // EOCD claims 5001 entries while only one central header exists: the cap must
    // come from the declared count, not from objects built by getEntries().
    const zip = forgedZip([{ name: 'a.txt', declaredSize: 1 }], 5001)
    const ctx = importCtx('declared-count.zip', zip)
    const { importSkill } = await loadController()

    await importSkill(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body.error).toMatch(/超限/)
    expect(ctx.body.error).toContain('5001')
    expect(maxAllocRequest).toBeLessThan(ALLOC_CAP)
  })

  it('returns 400 (not 500) when the central directory is truncated', async () => {
    // EOCD claims 3 entries but only 2 central headers follow: adm-zip throws
    // lazily inside getEntries(), which must still map to a client error.
    const zip = forgedZip([{ name: 'a.txt', declaredSize: 1 }, { name: 'b.txt', declaredSize: 1 }], 3)
    const ctx = importCtx('truncated.zip', zip)
    const { importSkill } = await loadController()

    await importSkill(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body.error).toMatch(/^Failed to read zip archive: /)
  })

  it('runs against adm-zip >= 0.6 (GHSA-xcpc-8h2w-3j85 fixed)', () => {
    const require = createRequire(import.meta.url)
    const { version } = require('adm-zip/package.json') as { version: string }
    const [major, minor] = version.split('.').map(Number)
    expect(major > 0 || minor >= 6, `adm-zip ${version} is below 0.6.0`).toBe(true)
  })

  it('still imports a normal small skill zip', async () => {
    const builder = new AdmZip()
    builder.addFile('demo-skill/SKILL.md', Buffer.from('# Demo Skill\nfrom zip\n'))
    builder.addFile('demo-skill/scripts/run.sh', Buffer.from('#!/bin/sh\necho ok\n'))
    const ctx = importCtx('demo-skill.zip', builder.toBuffer())
    const { importSkill } = await loadController()

    await importSkill(ctx)

    expect(ctx.status).not.toBe(400)
    expect(ctx.body).toEqual({ success: true, name: 'demo-skill' })
    await expect(readFile(join(profileDir, 'skills', 'demo-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('# Demo Skill\nfrom zip\n')
    await expect(readFile(join(profileDir, 'skills', 'demo-skill', 'scripts', 'run.sh'), 'utf-8')).resolves.toBe('#!/bin/sh\necho ok\n')
  })
})
