import { chmod, mkdir, readFile, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync } from 'fs'
import { deflateRawSync } from 'zlib'
import { describe, expect, it, vi } from 'vitest'

function crc32(input: Buffer): number {
  let crc = 0xffffffff
  for (const byte of input) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makeZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name)
    const data = Buffer.from(text)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    locals.push(local, nameBuffer, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuffer)
    offset += local.length + nameBuffer.length + data.length
  }
  const centralOffset = offset
  const centralDirectory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([...locals, centralDirectory, end])
}

function makeDeflatedZipWithDeclaredSize(name: string, text: string, declaredSize: number): Buffer {
  const nameBuffer = Buffer.from(name)
  const data = Buffer.from(text)
  const compressed = deflateRawSync(data)
  const crc = crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(declaredSize, 22)
  local.writeUInt16LE(nameBuffer.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(declaredSize, 24)
  central.writeUInt16LE(nameBuffer.length, 28)

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + nameBuffer.length, 12)
  end.writeUInt32LE(local.length + nameBuffer.length + compressed.length, 16)
  return Buffer.concat([local, nameBuffer, compressed, central, nameBuffer, end])
}

describe('SkillHub installer', () => {
  it('downloads AiDock skills with profile-local kep-auth and installs without leaking secrets', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skillhub-install-'))
    const kepAuth = join(profileDir, 'kep-auth')
    await mkdir(join(profileDir, 'home'), { recursive: true })
    await writeFile(kepAuth, [
      '#!/bin/sh',
      `test "$HOME" = "${join(profileDir, 'home')}" || { echo "bad HOME=$HOME"; exit 9; }`,
      'test "$KEP_PROFILE" = "feishu_sunke" || { echo "bad KEP_PROFILE=$KEP_PROFILE"; exit 9; }',
      'if [ "$1" = "--profile" ] && [ "$5" = "status" ]; then echo "state: valid"; exit 0; fi',
      'if [ "$1" = "--profile" ] && [ "$5" = "token" ]; then echo "secret-kep-token"; exit 0; fi',
      'exit 8',
    ].join('\n'), 'utf-8')
    await chmod(kepAuth, 0o755)
    process.env.HERMES_KEP_AUTH_BIN = kepAuth
    const zip = makeZip({
      'skill-creator/SKILL.md': '---\nname: skill-creator\n---\n# Skill Creator\n',
      'skill-creator/references/example.md': 'ok\n',
    })
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/skill/zipfile?skillCode=skill-creator')) {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer secret-kep-token',
          'x-source': 'cli',
        })
        return new Response(JSON.stringify({
          data: { url: 'https://signed.example/skill.zip?X-Cos-Security-Token=secret-url' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.startsWith('https://signed.example/skill.zip')) {
        return new Response(zip, { status: 200, headers: { 'content-type': 'application/zip' } })
      }
      return new Response('not found', { status: 404 })
    })

    const { installSkillHubSkill } = await import('../../packages/server/src/services/hermes/skillhub-installer')
    const result = await installSkillHubSkill({
      profileName: 'feishu_sunke',
      profileDir,
      skillCode: 'skill-creator',
      fetchImpl: fetchMock as any,
    })

    expect(result).toMatchObject({
      skill_code: 'skill-creator',
      required_credentials: ['kep-cli'],
    })
    expect(result).not.toHaveProperty('installed_path')
    expect(await readFile(join(profileDir, 'skills', 'skill-creator', 'SKILL.md'), 'utf-8')).toContain('name: skill-creator')
    const manifest = JSON.parse(await readFile(join(profileDir, 'skills', '.hermes-skillhub.json'), 'utf-8'))
    expect(manifest.installed['skill-creator']).toMatchObject({
      source: 'aidock-skillhub',
      profile: 'feishu_sunke',
    })
    expect(JSON.stringify(result)).not.toContain('secret-kep-token')
    expect(JSON.stringify(result)).not.toContain('secret-url')
    expect(JSON.stringify(manifest)).not.toContain('secret-kep-token')
    expect(JSON.stringify(manifest)).not.toContain('secret-url')
    await expect(stat(join(profileDir, 'skills', 'skill-creator', 'references', 'example.md'))).resolves.toBeTruthy()
  })

  it('rejects zip entries that escape the target skill directory', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skillhub-escape-'))
    const kepAuth = join(profileDir, 'kep-auth')
    await mkdir(join(profileDir, 'home'), { recursive: true })
    await writeFile(kepAuth, [
      '#!/bin/sh',
      `test "$HOME" = "${join(profileDir, 'home')}" || { echo "bad HOME=$HOME"; exit 9; }`,
      'test "$KEP_PROFILE" = "feishu_sunke" || { echo "bad KEP_PROFILE=$KEP_PROFILE"; exit 9; }',
      'if [ "$5" = "status" ]; then echo "state: valid"; exit 0; fi',
      'if [ "$5" = "token" ]; then echo "secret-kep-token"; exit 0; fi',
      'exit 8',
    ].join('\n'), 'utf-8')
    await chmod(kepAuth, 0o755)
    process.env.HERMES_KEP_AUTH_BIN = kepAuth
    const zip = makeZip({
      '../escape/SKILL.md': 'bad\n',
    })
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/skill/zipfile')) {
        return new Response(JSON.stringify({ data: { url: 'https://signed.example/bad.zip?secret-url' } }), { status: 200 })
      }
      return new Response(zip, { status: 200 })
    })

    const { installSkillHubSkill } = await import('../../packages/server/src/services/hermes/skillhub-installer')
    await expect(installSkillHubSkill({
      profileName: 'feishu_sunke',
      profileDir,
      skillCode: 'bad-skill',
      fetchImpl: fetchMock as any,
    })).rejects.toMatchObject({
      message: expect.stringContaining('unsafe zip entry'),
    })
  })

  it('bounds deflated zip output before trusting declared entry sizes', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skillhub-deflate-bound-'))
    const kepAuth = join(profileDir, 'kep-auth')
    await mkdir(join(profileDir, 'home'), { recursive: true })
    await writeFile(kepAuth, [
      '#!/bin/sh',
      'if [ "$5" = "status" ]; then echo "state: valid"; exit 0; fi',
      'if [ "$5" = "token" ]; then echo "secret-kep-token"; exit 0; fi',
      'exit 8',
    ].join('\n'), 'utf-8')
    await chmod(kepAuth, 0o755)
    process.env.HERMES_KEP_AUTH_BIN = kepAuth
    const zip = makeDeflatedZipWithDeclaredSize('bomb/SKILL.md', `${'x'.repeat(1024 * 1024)}\n`, 1)
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/skill/zipfile')) {
        return new Response(JSON.stringify({ data: { url: 'https://signed.example/bomb.zip' } }), { status: 200 })
      }
      return new Response(zip, { status: 200 })
    })

    const { installSkillHubSkill } = await import('../../packages/server/src/services/hermes/skillhub-installer')
    await expect(installSkillHubSkill({
      profileName: 'feishu_sunke',
      profileDir,
      skillCode: 'bomb',
      fetchImpl: fetchMock as any,
    })).rejects.toMatchObject({
      status: 413,
      message: 'SkillHub package is too large after extraction',
    })
  })

  it('rejects SkillHub signed URLs that target localhost or private networks', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skillhub-ssrf-'))
    const kepAuth = join(profileDir, 'kep-auth')
    await mkdir(join(profileDir, 'home'), { recursive: true })
    await writeFile(kepAuth, [
      '#!/bin/sh',
      'if [ "$5" = "status" ]; then echo "state: valid"; exit 0; fi',
      'if [ "$5" = "token" ]; then echo "secret-kep-token"; exit 0; fi',
      'exit 8',
    ].join('\n'), 'utf-8')
    await chmod(kepAuth, 0o755)
    process.env.HERMES_KEP_AUTH_BIN = kepAuth
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/skill/zipfile')) {
        return new Response(JSON.stringify({ data: { url: 'http://127.0.0.1:8648/internal.zip?secret-url' } }), { status: 200 })
      }
      throw new Error('private URL should not be fetched')
    })

    const { installSkillHubSkill } = await import('../../packages/server/src/services/hermes/skillhub-installer')
    await expect(installSkillHubSkill({
      profileName: 'feishu_sunke',
      profileDir,
      skillCode: 'private-skill',
      fetchImpl: fetchMock as any,
    })).rejects.toMatchObject({
      message: expect.stringContaining('unsafe SkillHub download host'),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    'https://[::ffff:127.0.0.1]/internal.zip?secret-url',
    'https://[2002:7f00::]/internal.zip?secret-url',
  ])('rejects IPv6 encoded private SkillHub signed URL %s', async (privateUrl) => {
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skillhub-ipv6-'))
    const kepAuth = join(profileDir, 'kep-auth')
    await mkdir(join(profileDir, 'home'), { recursive: true })
    await writeFile(kepAuth, [
      '#!/bin/sh',
      'if [ "$5" = "status" ]; then echo "state: valid"; exit 0; fi',
      'if [ "$5" = "token" ]; then echo "secret-kep-token"; exit 0; fi',
      'exit 8',
    ].join('\n'), 'utf-8')
    await chmod(kepAuth, 0o755)
    process.env.HERMES_KEP_AUTH_BIN = kepAuth
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/skill/zipfile')) {
        return new Response(JSON.stringify({ data: { url: privateUrl } }), { status: 200 })
      }
      throw new Error('private URL should not be fetched')
    })

    const { installSkillHubSkill } = await import('../../packages/server/src/services/hermes/skillhub-installer')
    await expect(installSkillHubSkill({
      profileName: 'feishu_sunke',
      profileDir,
      skillCode: 'private-skill',
      fetchImpl: fetchMock as any,
    })).rejects.toMatchObject({
      message: expect.stringContaining('unsafe SkillHub download host'),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not auto-follow signed URL redirects to private networks', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skillhub-redirect-'))
    const kepAuth = join(profileDir, 'kep-auth')
    await mkdir(join(profileDir, 'home'), { recursive: true })
    await writeFile(kepAuth, [
      '#!/bin/sh',
      'if [ "$5" = "status" ]; then echo "state: valid"; exit 0; fi',
      'if [ "$5" = "token" ]; then echo "secret-kep-token"; exit 0; fi',
      'exit 8',
    ].join('\n'), 'utf-8')
    await chmod(kepAuth, 0o755)
    process.env.HERMES_KEP_AUTH_BIN = kepAuth
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/skill/zipfile')) {
        return new Response(JSON.stringify({ data: { url: 'https://signed.example/redirect.zip?secret-url' } }), { status: 200 })
      }
      expect(init?.redirect).toBe('manual')
      return new Response('', {
        status: 302,
        headers: { location: 'http://127.0.0.1:8648/internal.zip?secret-url' },
      })
    })

    const { installSkillHubSkill } = await import('../../packages/server/src/services/hermes/skillhub-installer')
    await expect(installSkillHubSkill({
      profileName: 'feishu_sunke',
      profileDir,
      skillCode: 'redirect-skill',
      fetchImpl: fetchMock as any,
    })).rejects.toMatchObject({
      message: expect.stringContaining('unsafe SkillHub download host'),
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('omits server filesystem paths from install responses', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skillhub-response-'))
    const kepAuth = join(profileDir, 'kep-auth')
    await mkdir(join(profileDir, 'home'), { recursive: true })
    await writeFile(kepAuth, [
      '#!/bin/sh',
      'if [ "$5" = "status" ]; then echo "state: valid"; exit 0; fi',
      'if [ "$5" = "token" ]; then echo "secret-kep-token"; exit 0; fi',
      'exit 8',
    ].join('\n'), 'utf-8')
    await chmod(kepAuth, 0o755)
    process.env.HERMES_KEP_AUTH_BIN = kepAuth
    const zip = makeZip({
      'safe-skill/SKILL.md': '---\nname: safe-skill\n---\n# Safe Skill\n',
    })
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/skill/zipfile')) {
        return new Response(JSON.stringify({ data: { url: 'https://signed.example/safe.zip' } }), { status: 200 })
      }
      return new Response(zip, { status: 200 })
    })

    const { installSkillHubSkill } = await import('../../packages/server/src/services/hermes/skillhub-installer')
    const result = await installSkillHubSkill({
      profileName: 'feishu_sunke',
      profileDir,
      skillCode: 'safe-skill',
      fetchImpl: fetchMock as any,
    })

    expect(result).not.toHaveProperty('installed_path')
    expect(JSON.stringify(result)).not.toContain(profileDir)
  })
})
