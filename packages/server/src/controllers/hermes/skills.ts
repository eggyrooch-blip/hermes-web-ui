import { readdir, readFile, realpath, stat } from 'fs/promises'
import { isAbsolute, join, relative, resolve } from 'path'
import { createHash } from 'crypto'
import { homedir } from 'os'
import YAML from 'js-yaml'
import {
  readConfigYaml, updateConfigYaml,
  safeReadFile, extractDescription, listFilesRecursive, getHermesDir,
  type SkillSource,
} from '../../services/config-helpers'
import { validateSkillName } from '../../services/hermes/hermes-cli'
import { getRequestProfileDir, isChatPlaneRequest } from '../../services/request-context'
import { getRequestProfile } from '../../services/request-context'
import { isSensitivePath } from '../../services/hermes/file-provider'
import { safeFileStore } from '../../services/safe-file-store'
import { detectSkillCredentialRequirements } from '../../services/hermes/skill-credentials'
import { installSkillHubSkill } from '../../services/hermes/skillhub-installer'

/** Read bundled manifest as a name→hash map from ~/.hermes/skills/.bundled_manifest */
function readBundledManifest(manifestContent: string | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!manifestContent) return map
  for (const line of manifestContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(':')
    if (idx === -1) continue
    const name = trimmed.slice(0, idx).trim()
    const hash = trimmed.slice(idx + 1).trim()
    if (name && hash) map.set(name, hash)
  }
  return map
}

/** Read hub-installed skill names from legacy hub lock and Hermes SkillHub manifest */
function readHubInstalledNames(lockContent: string | null, hermesSkillHubContent: string | null): Set<string> {
  const names = new Set<string>()
  for (const content of [lockContent, hermesSkillHubContent]) {
    if (!content) continue
    try {
      const data = JSON.parse(content)
      if (data?.installed && typeof data.installed === 'object') {
        for (const name of Object.keys(data.installed)) names.add(name)
      }
    } catch { /* ignore */ }
  }
  return names
}

/** Compute md5 hash of all files in a directory (mirrors Hermes _dir_hash), with in-memory cache */
const hashCache = new Map<string, { hash: string; mtime: number }>()
const HASH_CACHE_TTL = 60_000 // 1 minute

async function dirHash(directory: string): Promise<string> {
  const cached = hashCache.get(directory)
  if (cached && Date.now() - cached.mtime < HASH_CACHE_TTL) return cached.hash

  const hasher = createHash('md5')
  const files = await listFilesRecursive(directory, '')
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  for (const f of files) {
    hasher.update(f.path)
    const content = await readFile(join(directory, f.path))
    hasher.update(content)
  }
  const hash = hasher.digest('hex')
  hashCache.set(directory, { hash, mtime: Date.now() })
  return hash
}

async function isDirectoryLike(parentDir: string, entry: import('fs').Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return (await stat(join(parentDir, entry.name))).isDirectory()
  } catch {
    return false
  }
}

/** Determine the source type of a skill */
function getSkillSource(
  dirName: string,
  bundledManifest: Map<string, string>,
  hubNames: Set<string>,
): SkillSource {
  if (bundledManifest.has(dirName)) return 'builtin'
  if (hubNames.has(dirName)) return 'hub'
  return 'local'
}

/** Read .usage.json as a name→stats map */
interface UsageStats { patch_count: number; use_count: number; view_count: number; pinned: boolean }
function readUsageStats(usageContent: string | null): Map<string, UsageStats> {
  const map = new Map<string, UsageStats>()
  if (!usageContent) return map
  try {
    const data = JSON.parse(usageContent)
    for (const [name, stats] of Object.entries(data)) {
      const s = stats as any
      map.set(name, { patch_count: s.patch_count ?? 0, use_count: s.use_count ?? 0, view_count: s.view_count ?? 0, pinned: !!s.pinned })
    }
  } catch { /* ignore */ }
  return map
}

function requestHermesDir(ctx: any): string {
  return isChatPlaneRequest(ctx) ? getRequestProfileDir(ctx) : getHermesDir()
}

function isInsideDirectory(rootDir: string, targetPath: string): boolean {
  const rel = relative(resolve(rootDir), resolve(targetPath))
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function expandConfiguredPath(value: string): string {
  const expandedEnv = value.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
    return process.env[braced || bare] || ''
  })
  if (expandedEnv === '~') return homedir()
  if (expandedEnv.startsWith('~/')) return join(homedir(), expandedEnv.slice(2))
  return expandedEnv
}

export async function resolveExternalSkillsDirs(config: Record<string, any>, localSkillsDir: string): Promise<string[]> {
  const rawDirs = config.skills?.external_dirs
  const entries = typeof rawDirs === 'string'
    ? [rawDirs]
    : Array.isArray(rawDirs)
      ? rawDirs
      : []
  const localResolved = resolve(localSkillsDir)
  const seen = new Set<string>()
  const dirs: string[] = []

  for (const rawEntry of entries) {
    const entry = String(rawEntry || '').trim()
    if (!entry) continue
    const resolved = resolve(expandConfiguredPath(entry))
    if (resolved === localResolved || seen.has(resolved)) continue
    try {
      const info = await stat(resolved)
      if (!info.isDirectory()) continue
    } catch {
      continue
    }
    seen.add(resolved)
    dirs.push(resolved)
  }

  return dirs
}

async function readRequestConfig(ctx: any): Promise<Record<string, any>> {
  if (!isChatPlaneRequest(ctx)) return readConfigYaml()
  const raw = await safeReadFile(join(getRequestProfileDir(ctx), 'config.yaml'))
  if (!raw) return {}
  return (YAML.load(raw) as Record<string, any>) || {}
}

async function updateRequestConfig(
  ctx: any,
  updater: (config: Record<string, any>) => Record<string, any>,
): Promise<void> {
  if (!isChatPlaneRequest(ctx)) {
    await updateConfigYaml(updater)
    return
  }
  await safeFileStore.updateYaml(join(getRequestProfileDir(ctx), 'config.yaml'), updater, { backup: true })
}

async function buildSkillInfo(
  name: string,
  skillMd: string,
  skillDir: string,
  bundledManifest: Map<string, string>,
  hubNames: Set<string>,
  disabledList: string[],
  usageStats: Map<string, UsageStats>,
  chatPlane: boolean,
) {
  const source = getSkillSource(name, bundledManifest, hubNames)
  let modified = false
  if (source === 'builtin' && !chatPlane) {
    const manifestHash = bundledManifest.get(name)
    if (manifestHash) {
      const currentHash = await dirHash(skillDir)
      modified = currentHash !== manifestHash
    }
  }
  const usage = usageStats.get(name)
  return {
    name,
    description: extractDescription(skillMd),
    enabled: !disabledList.includes(name),
    source,
    modified: modified || undefined,
    patchCount: usage?.patch_count,
    useCount: usage?.use_count,
    viewCount: usage?.view_count,
    pinned: usage?.pinned || undefined,
    requiredCredentials: detectSkillCredentialRequirements({ name, text: skillMd, source }),
  }
}

async function collectSkillsRecursive(
  directory: string,
  bundledManifest: Map<string, string>,
  hubNames: Set<string>,
  disabledList: string[],
  usageStats: Map<string, UsageStats>,
  chatPlane: boolean,
  visited = new Set<string>(),
): Promise<any[]> {
  const realDirectory = await realpath(directory).catch(() => resolve(directory))
  if (visited.has(realDirectory)) return []
  visited.add(realDirectory)

  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [] as import('fs').Dirent[])
  const skills: any[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!await isDirectoryLike(directory, entry)) continue
    const dir = join(directory, entry.name)
    const skillMd = await safeReadFile(join(dir, 'SKILL.md'))
    if (skillMd) {
      skills.push(await buildSkillInfo(entry.name, skillMd, dir, bundledManifest, hubNames, disabledList, usageStats, chatPlane))
      continue
    }
    skills.push(...await collectSkillsRecursive(dir, bundledManifest, hubNames, disabledList, usageStats, chatPlane, visited))
  }
  return skills
}

/**
 * Scan for skills at different directory depths.
 *
 * Supports both:
 *   - Three-level: skills/<category>/<skill-name>/SKILL.md  (category is a container)
 *   - Two-level:   skills/<skill-name>/SKILL.md            (flat skill under "misc" category)
 *
 * Categories are identified by having a DESCRIPTION.md at the category level
 * or by containing subdirectories with SKILL.md (three-level pattern).
 * Skills without a parent category (flat skills) are grouped under the "misc" category.
 */
export async function scanSkillsDir(
  skillsDir: string,
  bundledManifest: Map<string, string>,
  hubNames: Set<string>,
  disabledList: string[],
  usageStats: Map<string, UsageStats>,
  chatPlane: boolean,
) {
  const allEntries = await readdir(skillsDir, { withFileTypes: true })
  const dirNames: string[] = []
  for (const entry of allEntries) {
    if (entry.name.startsWith('.')) continue
    if (await isDirectoryLike(skillsDir, entry)) dirNames.push(entry.name)
  }

  // Classify directories: categories vs. flat skills
  const categoryDirs: { name: string; description: string }[] = []
  const flatSkills: { name: string; skillMd: string; source: string }[] = []

  for (const dirName of dirNames) {
    const catDir = join(skillsDir, dirName)
    const hasDesc = await safeReadFile(join(catDir, 'DESCRIPTION.md'))
    const hasSkillMd = await safeReadFile(join(catDir, 'SKILL.md'))
    const subEntries = await readdir(catDir, { withFileTypes: true })
    const subDirs = []
    for (const se of subEntries) {
      if (await isDirectoryLike(catDir, se)) subDirs.push(se)
    }

    // Priority: SKILL.md at top level → flat skill
    //           DESCRIPTION.md or subdirs (without SKILL.md) → category
    if (hasSkillMd) {
      // Flat skill: has SKILL.md at the top level (two-level pattern)
      // Could also have subdirectories (references/, scripts/, etc.)
      flatSkills.push({
        name: dirName,
        skillMd: hasSkillMd,
        source: getSkillSource(dirName, bundledManifest, hubNames),
      })
    } else if (!!hasDesc || subDirs.length > 0) {
      // True category: has DESCRIPTION.md or subdirs, but no SKILL.md at top level
      const catDescription = hasDesc ? hasDesc.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 100) : ''
      categoryDirs.push({ name: dirName, description: catDescription })
    }
  }

  // Build categories with their nested skills
  const categories: any[] = []

  for (const cat of categoryDirs) {
    const catDir = join(skillsDir, cat.name)
    const skills = await collectSkillsRecursive(catDir, bundledManifest, hubNames, disabledList, usageStats, chatPlane)
    if (skills.length > 0) {
      categories.push({ name: cat.name, description: cat.description, skills })
    }
  }

  // Group flat skills into a "misc" (雜項) category
  if (flatSkills.length > 0) {
    const miscSkills: any[] = []
    for (const fs of flatSkills) {
      const usage = usageStats.get(fs.name)
      miscSkills.push({
        name: fs.name,
        description: extractDescription(fs.skillMd),
        enabled: !disabledList.includes(fs.name),
        source: fs.source,
        modified: undefined,
        patchCount: usage?.patch_count,
        useCount: usage?.use_count,
        viewCount: usage?.view_count,
        pinned: usage?.pinned || undefined,
        requiredCredentials: detectSkillCredentialRequirements({ name: fs.name, text: fs.skillMd, source: fs.source }),
      })
    }
    miscSkills.sort((a: any, b: any) => a.name.localeCompare(b.name))
    categories.push({
      name: 'misc',
      description: '雜項',
      skills: miscSkills,
    })
  }

  categories.sort((a, b) => a.name.localeCompare(b.name))
  for (const cat of categories) { cat.skills.sort((a: any, b: any) => a.name.localeCompare(b.name)) }
  return categories
}

export async function scanExternalSkillsDir(
  skillsDir: string,
  disabledList: string[],
  usageStats: Map<string, UsageStats>,
) {
  const categories = await scanSkillsDir(skillsDir, new Map(), new Set(), disabledList, usageStats, true)
  return categories.map(category => ({
    ...category,
    skills: category.skills.map((skill: any) => ({
      ...skill,
      source: 'external' as SkillSource,
      modified: undefined,
    })),
  }))
}

function collectSkillNames(categories: any[]): Set<string> {
  const names = new Set<string>()
  for (const category of categories) {
    for (const skill of category.skills || []) {
      if (skill?.name) names.add(skill.name)
    }
  }
  return names
}

export function mergeExternalCategories(categories: any[], externalCategories: any[]): any[] {
  const byName = new Map<string, any>()
  for (const category of categories) {
    byName.set(category.name, { ...category, skills: [...category.skills] })
  }

  const seenSkills = collectSkillNames(categories)
  for (const externalCategory of externalCategories) {
    const target = byName.get(externalCategory.name) || {
      name: externalCategory.name,
      description: externalCategory.description,
      skills: [],
    }
    for (const skill of externalCategory.skills || []) {
      if (seenSkills.has(skill.name)) continue
      seenSkills.add(skill.name)
      target.skills.push(skill)
    }
    if (target.skills.length > 0) byName.set(target.name, target)
  }

  const merged = [...byName.values()]
    .filter(category => category.skills.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const category of merged) {
    category.skills.sort((a: any, b: any) => a.name.localeCompare(b.name))
  }
  return merged
}

async function findSkillDirInRoot(rootDir: string, category: string, skillName: string): Promise<string | null> {
  const skillDir = resolve(rootDir, category === 'misc' ? skillName : join(category, skillName))
  if (!isInsideDirectory(rootDir, skillDir)) return null
  const skillMd = await safeReadFile(join(skillDir, 'SKILL.md'))
  if (skillMd !== null) return skillDir
  if (category === 'misc') return null

  const categoryDir = resolve(rootDir, category)
  if (!isInsideDirectory(rootDir, categoryDir)) return null
  return findNestedSkillDir(categoryDir, skillName)
}

async function findNestedSkillDir(directory: string, skillName: string, visited = new Set<string>()): Promise<string | null> {
  const realDirectory = await realpath(directory).catch(() => resolve(directory))
  if (visited.has(realDirectory)) return null
  visited.add(realDirectory)

  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [] as import('fs').Dirent[])
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!await isDirectoryLike(directory, entry)) continue
    const dir = join(directory, entry.name)
    if (entry.name === skillName && await safeReadFile(join(dir, 'SKILL.md')) !== null) {
      return dir
    }
    const nested = await findNestedSkillDir(dir, skillName, visited)
    if (nested) return nested
  }
  return null
}

async function updatePinnedSkill(skillsDir: string, name: string, pinned: boolean): Promise<void> {
  validateSkillName(name)
  const usagePath = join(skillsDir, '.usage.json')
  await safeFileStore.updateText(usagePath, (raw) => {
    let usage: Record<string, any> = {}
    try {
      usage = raw ? JSON.parse(raw) : {}
    } catch {
      usage = {}
    }
    const current = usage[name] && typeof usage[name] === 'object' ? usage[name] : {}
    usage[name] = {
      ...current,
      patch_count: current.patch_count ?? 0,
      use_count: current.use_count ?? 0,
      view_count: current.view_count ?? 0,
      pinned,
    }
    return `${JSON.stringify(usage, null, 2)}\n`
  })
}

async function resolveSkillDirFromConfig(
  config: Record<string, any>,
  localSkillsDir: string,
  category: string,
  skillName: string,
): Promise<string | null> {
  const localSkillDir = await findSkillDirInRoot(localSkillsDir, category, skillName)
  if (localSkillDir) return localSkillDir

  for (const externalDir of await resolveExternalSkillsDirs(config, localSkillsDir)) {
    const externalSkillDir = await findSkillDirInRoot(externalDir, category, skillName)
    if (externalSkillDir) return externalSkillDir
  }
  return null
}

export async function list(ctx: any) {
  const chatPlane = isChatPlaneRequest(ctx)
  const skillsDir = join(requestHermesDir(ctx), 'skills')
  try {
    const config = await readRequestConfig(ctx)
    const disabledList: string[] = config.skills?.disabled || []

    // Read provenance sources
    const bundledManifest = readBundledManifest(await safeReadFile(join(skillsDir, '.bundled_manifest')))
    const hubNames = readHubInstalledNames(
      await safeReadFile(join(skillsDir, '.hub', 'lock.json')),
      await safeReadFile(join(skillsDir, '.hermes-skillhub.json')),
    )
    const usageStats = readUsageStats(await safeReadFile(join(skillsDir, '.usage.json')))

    // Scan all skills (supports both two-level and three-level directory structures)
    let categories = await scanSkillsDir(skillsDir, bundledManifest, hubNames, disabledList, usageStats, chatPlane)
    for (const externalDir of await resolveExternalSkillsDirs(config, skillsDir)) {
      const externalCategories = await scanExternalSkillsDir(externalDir, disabledList, usageStats)
      categories = mergeExternalCategories(categories, externalCategories)
    }

    // Read archived skills from .archive/
    const archived: any[] = []
    const archiveDir = join(skillsDir, '.archive')
    const archiveEntries = await readdir(archiveDir, { withFileTypes: true }).catch(() => [] as import('fs').Dirent[])
    for (const entry of archiveEntries) {
      if (!entry.isDirectory()) continue
      const skillMd = await safeReadFile(join(archiveDir, entry.name, 'SKILL.md'))
      if (skillMd) {
        const usage = usageStats.get(entry.name)
        archived.push({
          name: entry.name,
          description: extractDescription(skillMd),
          source: getSkillSource(entry.name, bundledManifest, hubNames),
          patchCount: usage?.patch_count,
          useCount: usage?.use_count,
          viewCount: usage?.view_count,
          pinned: usage?.pinned || undefined,
        })
      }
    }
    archived.sort((a: any, b: any) => a.name.localeCompare(b.name))

    ctx.body = { categories, archived }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: `Failed to read skills directory: ${err.message}` }
  }
}

export async function toggle(ctx: any) {
  const { name, enabled } = ctx.request.body as { name?: string; enabled?: boolean }
  if (!name || typeof enabled !== 'boolean') {
    ctx.status = 400
    ctx.body = { error: 'Missing name or enabled flag' }
    return
  }
  try {
    validateSkillName(name)
    await updateRequestConfig(ctx, (config) => {
      if (!config.skills) config.skills = {}
      if (!Array.isArray(config.skills.disabled)) config.skills.disabled = []
      const disabled = config.skills.disabled as string[]
      const idx = disabled.indexOf(name)
      if (enabled) { if (idx !== -1) disabled.splice(idx, 1) }
      else { if (idx === -1) disabled.push(name) }
      return config
    })
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function listFiles(ctx: any) {
  const { category, skill } = ctx.params
  const hd = requestHermesDir(ctx)
  const skillsRoot = resolve(hd, 'skills')
  const config = await readRequestConfig(ctx)
  const skillDir = await resolveSkillDirFromConfig(config, skillsRoot, category, skill)
  if (!skillDir || isSensitivePath(category) || isSensitivePath(skill)) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }
  try {
    const allFiles = await listFilesRecursive(skillDir, '')
    const files = allFiles.filter(f => f.path !== 'SKILL.md')
    ctx.body = { files }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function readFile_(ctx: any) {
  const filePath = (ctx.params as any).path
  const hd = requestHermesDir(ctx)
  const skillsRoot = resolve(hd, 'skills')
  const parts = String(filePath || '').split('/').filter(Boolean)
  const category = parts[0] || ''
  const skillName = parts[1] || ''
  const restPath = parts.slice(2).join('/')
  const config = await readRequestConfig(ctx)
  const skillDir = category && skillName
    ? await resolveSkillDirFromConfig(config, skillsRoot, category, skillName)
    : null
  const fullPath = skillDir ? resolve(join(skillDir, restPath)) : ''
  if (!skillDir || !restPath || !isInsideDirectory(skillDir, fullPath) || isSensitivePath(restPath)) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }
  const content = await safeReadFile(fullPath)
  if (content === null) {
    ctx.status = 404
    ctx.body = { error: 'File not found' }
    return
  }
  ctx.body = { content }
}

export async function pin_(ctx: any) {
  const { name, pinned } = ctx.request.body as { name?: string; pinned?: boolean }
  if (!name || typeof pinned !== 'boolean') {
    ctx.status = 400
    ctx.body = { error: 'Missing name or pinned flag' }
    return
  }
  try {
    await updatePinnedSkill(join(requestHermesDir(ctx), 'skills'), name, pinned)
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function installFromSkillHub(ctx: any) {
  const body = (ctx.request.body || {}) as { skill_code?: unknown; skillCode?: unknown }
  const skillCode = typeof body.skill_code === 'string'
    ? body.skill_code
    : typeof body.skillCode === 'string'
      ? body.skillCode
      : ''
  if (!skillCode.trim()) {
    ctx.status = 400
    ctx.body = { error: 'skill_code is required' }
    return
  }
  try {
    const profileName = getRequestProfile(ctx)
    const result = await installSkillHubSkill({
      profileName,
      profileDir: getRequestProfileDir(ctx),
      skillCode,
    })
    ctx.status = 200
    ctx.body = result
  } catch (err: any) {
    ctx.status = typeof err?.status === 'number' ? err.status : 500
    ctx.body = { error: err?.message || 'Failed to install SkillHub skill' }
  }
}
