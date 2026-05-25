import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { isIP } from 'net'
import { basename, dirname, join, posix, relative, resolve } from 'path'
import { inflateRawSync } from 'zlib'
import { promisify } from 'util'
import { safeFileStore } from '../safe-file-store'
import { validateSkillName } from './hermes-cli'
import { detectSkillCredentialRequirements } from './skill-credentials'

const execFileAsync = promisify(execFile)
const SKILLHUB_ZIPFILE_API = 'https://proxy.cms.gotokeep.com/api/aidock-webapp/internal/upload/v1/skill/zipfile'
const MAX_SKILLHUB_ZIP_BYTES = 50 * 1024 * 1024
const MAX_SKILLHUB_EXTRACTED_BYTES = 100 * 1024 * 1024
const MAX_SKILLHUB_DOWNLOAD_REDIRECTS = 3

export interface InstallSkillHubOptions {
  profileName: string
  profileDir: string
  skillCode: string
  fetchImpl?: typeof fetch
}

export interface InstallSkillHubResult {
  skill_code: string
  required_credentials: string[]
  source: 'aidock-skillhub'
}

interface ZipEntry {
  name: string
  data: Buffer
  directory: boolean
}

export async function installSkillHubSkill(options: InstallSkillHubOptions): Promise<InstallSkillHubResult> {
  const skillCode = normalizeSkillCode(options.skillCode)
  const fetcher = options.fetchImpl || fetch
  const bin = kepAuthBin(options.profileDir)
  await ensureKepAuthLoggedIn(bin, options.profileDir, options.profileName)
  const token = await readKepAuthToken(bin, options.profileDir, options.profileName)

  const zipUrl = await fetchSkillHubZipUrl(fetcher, skillCode, token)
  const zipBuffer = await downloadSkillZip(fetcher, zipUrl)
  const checksum = createHash('sha256').update(zipBuffer).digest('hex')
  const entries = normalizeZipEntries(parseZipEntries(zipBuffer))
  const skillMd = entries.find(entry => entry.name === 'SKILL.md' && !entry.directory)
  if (!skillMd) {
    const err: any = new Error('SkillHub package does not contain SKILL.md')
    err.status = 422
    throw err
  }
  const requiredCredentials = detectSkillCredentialRequirements({
    name: skillCode,
    text: skillMd.data.toString('utf-8'),
    source: 'hub',
  })

  const skillsDir = join(options.profileDir, 'skills')
  const targetDir = join(skillsDir, skillCode)
  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true })
  let totalExtracted = 0
  for (const entry of entries) {
    const target = resolve(targetDir, entry.name)
    if (!isInsideDirectory(targetDir, target)) {
      const err: any = new Error(`unsafe zip entry: ${entry.name}`)
      err.status = 422
      throw err
    }
    if (entry.directory) {
      await mkdir(target, { recursive: true })
      continue
    }
    totalExtracted += entry.data.length
    if (totalExtracted > MAX_SKILLHUB_EXTRACTED_BYTES) {
      const err: any = new Error('SkillHub package is too large after extraction')
      err.status = 413
      throw err
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, entry.data)
  }

  await recordSkillHubInstall(skillsDir, skillCode, {
    source: 'aidock-skillhub',
    profile: options.profileName,
    installed_at: new Date().toISOString(),
    checksum_sha256: checksum,
    required_credentials: requiredCredentials,
  })

  return {
    skill_code: skillCode,
    required_credentials: requiredCredentials,
    source: 'aidock-skillhub',
  }
}

function normalizeSkillCode(raw: string): string {
  const value = String(raw || '').trim()
  validateSkillName(value)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    const err: any = new Error('invalid SkillHub skill code')
    err.status = 400
    throw err
  }
  return value
}

function kepAuthBin(profileDir: string): string {
  if (process.env.HERMES_KEP_AUTH_BIN) return process.env.HERMES_KEP_AUTH_BIN
  const sharedHome = basename(dirname(profileDir)) === 'profiles' ? dirname(dirname(profileDir)) : profileDir
  return join(sharedHome, 'bin', 'kep-auth')
}

function kepAuthEnv(profileDir: string, profileName: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: join(profileDir, 'home'),
    HERMES_HOME: profileDir,
    KEP_PROFILE: profileName,
    KEP_NO_AUTO_LOGIN: '1',
  }
}

async function ensureKepAuthLoggedIn(bin: string, profileDir: string, profileName: string): Promise<void> {
  if (!existsSync(bin)) {
    const err: any = new Error('kep-auth binary is not installed')
    err.status = 404
    throw err
  }
  const { stdout, stderr } = await execFileAsync(bin, ['--profile', profileName, '--env', 'online', 'status'], {
    cwd: profileDir,
    env: kepAuthEnv(profileDir, profileName),
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  })
  const output = `${stdout}\n${stderr}`.toLowerCase()
  if (!/state:\s*(valid|logged\s*in)|logged\s*in/.test(output)) {
    const err: any = new Error('kep-auth status reports this profile is not logged in')
    err.status = 401
    throw err
  }
}

async function readKepAuthToken(bin: string, profileDir: string, profileName: string): Promise<string> {
  const { stdout } = await execFileAsync(bin, ['--profile', profileName, '--env', 'online', 'token'], {
    cwd: profileDir,
    env: kepAuthEnv(profileDir, profileName),
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  })
  const token = String(stdout || '').trim().split(/\r?\n/)[0]?.trim()
  if (!token) {
    const err: any = new Error('kep-auth did not return a token')
    err.status = 401
    throw err
  }
  return token
}

async function fetchSkillHubZipUrl(fetcher: typeof fetch, skillCode: string, token: string): Promise<string> {
  const url = new URL(SKILLHUB_ZIPFILE_API)
  url.searchParams.set('skillCode', skillCode)
  const res = await fetcher(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'hermes-web-ui-skillhub/1.0',
      'x-source': 'cli',
    },
  })
  if (!res.ok) {
    const err: any = new Error(`SkillHub download URL request failed with HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  const data = await res.json().catch(() => null) as any
  const downloadUrl = String(data?.data?.url || data?.url || '').trim()
  if (!downloadUrl || !/^https?:\/\//.test(downloadUrl)) {
    const err: any = new Error('SkillHub did not return a valid download URL')
    err.status = 502
    throw err
  }
  assertSafeSkillHubDownloadUrl(downloadUrl)
  return downloadUrl
}

function assertSafeSkillHubDownloadUrl(rawUrl: string): void {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    const err: any = new Error('SkillHub did not return a valid download URL')
    err.status = 502
    throw err
  }
  const hostname = normalizeUrlHostname(url.hostname)
  const ipKind = isIP(hostname)
  const unsafeHost = hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '0.0.0.0' ||
    hostname === '::' ||
    hostname === '::1' ||
    (ipKind === 4 && isPrivateIpv4(hostname)) ||
    (ipKind === 6 && isPrivateIpv6(hostname))
  if (url.protocol !== 'https:' || unsafeHost) {
    const err: any = new Error('unsafe SkillHub download host')
    err.status = 502
    throw err
  }
}

function normalizeUrlHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '')
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(part => Number(part))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return true
  const [a, b] = parts
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 168 ||
    a >= 224
}

function isPrivateIpv6(hostname: string): boolean {
  const embeddedIpv4 = ipv4FromIpv6TransitionAddress(hostname)
  return hostname === '::1' ||
    hostname === '::' ||
    hostname.startsWith('fc') ||
    hostname.startsWith('fd') ||
    hostname.startsWith('fe80:') ||
    !!embeddedIpv4 && isPrivateIpv4(embeddedIpv4)
}

function ipv4FromIpv6TransitionAddress(hostname: string): string | null {
  const dotted = hostname.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1]
  if (dotted) return dotted

  const groups = hostname.split(':').filter(Boolean)
  if (hostname.startsWith('::ffff:') && groups.length >= 3) {
    return ipv4FromHexGroups(groups.at(-2), groups.at(-1))
  }
  if (hostname.startsWith('2002:')) {
    return ipv4FromHexGroups(groups[1], groups[2] || '0')
  }
  return null
}

function ipv4FromHexGroups(high: string | undefined, low: string | undefined): string | null {
  if (!high || !low || !/^[0-9a-f]{1,4}$/.test(high) || !/^[0-9a-f]{1,4}$/.test(low)) return null
  const value = Number.parseInt(high, 16) * 0x10000 + Number.parseInt(low, 16)
  return [
    value >>> 24 & 0xff,
    value >>> 16 & 0xff,
    value >>> 8 & 0xff,
    value & 0xff,
  ].join('.')
}

async function downloadSkillZip(fetcher: typeof fetch, url: string, redirectsRemaining = MAX_SKILLHUB_DOWNLOAD_REDIRECTS): Promise<Buffer> {
  assertSafeSkillHubDownloadUrl(url)
  const res = await fetcher(url, { method: 'GET', redirect: 'manual' })
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location')
    if (!location || redirectsRemaining <= 0) {
      const err: any = new Error('SkillHub package download redirected too many times')
      err.status = 502
      throw err
    }
    const nextUrl = new URL(location, url).toString()
    assertSafeSkillHubDownloadUrl(nextUrl)
    return downloadSkillZip(fetcher, nextUrl, redirectsRemaining - 1)
  }
  if (!res.ok) {
    const err: any = new Error(`SkillHub package download failed with HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  const arrayBuffer = await res.arrayBuffer()
  if (arrayBuffer.byteLength > MAX_SKILLHUB_ZIP_BYTES) {
    const err: any = new Error('SkillHub package is too large')
    err.status = 413
    throw err
  }
  return Buffer.from(arrayBuffer)
}

function parseZipEntries(file: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = []
  let offset = 0
  let totalUncompressed = 0
  while (offset + 4 <= file.length) {
    const signature = file.readUInt32LE(offset)
    if (signature === 0x02014b50 || signature === 0x06054b50) break
    if (signature !== 0x04034b50) {
      const err: any = new Error('invalid SkillHub zip package')
      err.status = 422
      throw err
    }
    const flags = file.readUInt16LE(offset + 6)
    const method = file.readUInt16LE(offset + 8)
    const compressedSize = file.readUInt32LE(offset + 18)
    const uncompressedSize = file.readUInt32LE(offset + 22)
    const nameLength = file.readUInt16LE(offset + 26)
    const extraLength = file.readUInt16LE(offset + 28)
    if (flags & 0x1 || flags & 0x8) {
      const err: any = new Error('unsupported SkillHub zip entry')
      err.status = 422
      throw err
    }
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > file.length) {
      const err: any = new Error('truncated SkillHub zip package')
      err.status = 422
      throw err
    }
    totalUncompressed += uncompressedSize
    if (totalUncompressed > MAX_SKILLHUB_EXTRACTED_BYTES || uncompressedSize > MAX_SKILLHUB_EXTRACTED_BYTES) {
      const err: any = new Error('SkillHub package is too large after extraction')
      err.status = 413
      throw err
    }
    const rawName = file.subarray(nameStart, nameStart + nameLength).toString('utf-8')
    const compressed = file.subarray(dataStart, dataEnd)
    let data: Buffer
    if (method === 0) data = Buffer.from(compressed)
    else if (method === 8) {
      const remainingLimit = Math.max(0, MAX_SKILLHUB_EXTRACTED_BYTES - (totalUncompressed - uncompressedSize))
      const outputLimit = Math.min(uncompressedSize, remainingLimit)
      data = inflateRawSkillHubEntry(compressed, outputLimit)
    }
    else {
      const err: any = new Error('unsupported SkillHub zip compression method')
      err.status = 422
      throw err
    }
    if (data.length !== uncompressedSize) {
      const err: any = new Error('invalid SkillHub zip entry size')
      err.status = 422
      throw err
    }
    entries.push({ name: rawName, data, directory: rawName.endsWith('/') })
    offset = dataEnd
  }
  if (entries.length === 0) {
    const err: any = new Error('SkillHub zip package is empty')
    err.status = 422
    throw err
  }
  return entries
}

function inflateRawSkillHubEntry(compressed: Buffer, maxOutputLength: number): Buffer {
  try {
    return inflateRawSync(compressed, { maxOutputLength })
  } catch (err: any) {
    if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
      const wrapped: any = new Error('SkillHub package is too large after extraction')
      wrapped.status = 413
      throw wrapped
    }
    const wrapped: any = new Error('invalid SkillHub zip package')
    wrapped.status = 422
    throw wrapped
  }
}

function normalizeZipEntries(entries: ZipEntry[]): ZipEntry[] {
  const names = entries.map(entry => normalizeZipEntryName(entry.name.replace(/\\/g, '/')))
  const prefix = commonTopLevelPrefix(names)
  return entries.map((entry, index) => {
    const normalized = normalizeZipEntryName(prefix ? names[index].slice(prefix.length) : names[index])
    return {
      ...entry,
      name: normalized,
    }
  }).filter(entry => entry.name)
}

function commonTopLevelPrefix(names: string[]): string {
  const files = names.filter(name => name && !name.endsWith('/'))
  if (files.some(name => name === 'SKILL.md')) return ''
  const firstParts = files.map(name => name.split('/')[0]).filter(Boolean)
  if (firstParts.length === 0) return ''
  const first = firstParts[0]
  if (!firstParts.every(part => part === first)) return ''
  return `${first}/`
}

function normalizeZipEntryName(name: string): string {
  const trimmed = name.replace(/^\/+/, '')
  const normalized = posix.normalize(trimmed)
  if (!normalized || normalized === '.') return ''
  if (normalized.startsWith('../') || normalized === '..' || posix.isAbsolute(normalized)) {
    const err: any = new Error(`unsafe zip entry: ${name}`)
    err.status = 422
    throw err
  }
  return normalized
}

function isInsideDirectory(rootDir: string, targetPath: string): boolean {
  const rel = relative(resolve(rootDir), resolve(targetPath))
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.startsWith('/') && rel !== '..')
}

async function recordSkillHubInstall(skillsDir: string, skillCode: string, record: Record<string, any>): Promise<void> {
  const manifestPath = join(skillsDir, '.hermes-skillhub.json')
  await safeFileStore.updateText(manifestPath, (raw) => {
    let manifest: Record<string, any> = {}
    try {
      manifest = raw ? JSON.parse(raw) : {}
    } catch {
      manifest = {}
    }
    if (!manifest.installed || typeof manifest.installed !== 'object') manifest.installed = {}
    manifest.installed[skillCode] = record
    return `${JSON.stringify(manifest, null, 2)}\n`
  })
}
