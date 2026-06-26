import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'

const mockGetSkillUsageStatsFromDb = vi.hoisted(() => vi.fn())
const mockGetActiveProfileName = vi.hoisted(() => vi.fn())
const mockGetProfileDir = vi.hoisted(() => vi.fn())
const mockUpdateConfigYamlForProfile = vi.hoisted(() => vi.fn())
const mockReadConfigYamlForProfile = vi.hoisted(() => vi.fn())
const mockSafeReadFile = vi.hoisted(() => vi.fn())
const mockExtractDescription = vi.hoisted(() => vi.fn())
const mockListFilesRecursive = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  getSkillUsageStatsFromDb: mockGetSkillUsageStatsFromDb,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: mockGetActiveProfileName,
  getProfileDir: mockGetProfileDir,
}))

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  readConfigYamlForProfile: mockReadConfigYamlForProfile,
  updateConfigYamlForProfile: mockUpdateConfigYamlForProfile,
  safeReadFile: mockSafeReadFile,
  extractDescription: mockExtractDescription,
  listFilesRecursive: mockListFilesRecursive,
}))

async function loadController() {
  vi.resetModules()
  return import('../../packages/server/src/controllers/hermes/skills')
}

function multipartBody(boundary: string, parts: Array<{ name: string; value: string; filename?: string; filenameStar?: string; contentType?: string }>): Buffer {
  const chunks: Buffer[] = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    const filename = part.filenameStar
      ? `; filename*=UTF-8''${part.filenameStar}`
      : part.filename
        ? `; filename="${part.filename}"`
        : ''
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"${filename}\r\n`))
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`))
    chunks.push(Buffer.from('\r\n'))
    chunks.push(Buffer.from(part.value))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

describe('skills controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetActiveProfileName.mockReturnValue('default')
    mockGetProfileDir.mockImplementation((profile: string) => `/tmp/hermes-${profile}`)
    mockReadConfigYamlForProfile.mockResolvedValue({})
    mockSafeReadFile.mockImplementation(async (path: string) => {
      try {
        return await readFile(path, 'utf-8')
      } catch {
        return null
      }
    })
    mockExtractDescription.mockImplementation((content: string) => {
      return content.split('\n').find(line => line.trim() && !line.startsWith('#'))?.trim() || ''
    })
    mockListFilesRecursive.mockResolvedValue([])
    mockUpdateConfigYamlForProfile.mockImplementation(async (_profile: string, updater: (config: Record<string, any>) => Record<string, any>) => updater({}))
    mockGetSkillUsageStatsFromDb.mockResolvedValue({
      period_days: 7,
      summary: {
        total_skill_loads: 0,
        total_skill_edits: 0,
        total_skill_actions: 0,
        distinct_skills_used: 0,
      },
      by_day: [],
      top_skills: [],
    })
  })

  it('loads skill usage from the request-scoped profile state database', async () => {
    const { usageStats } = await loadController()
    const ctx: any = { query: { days: '30' }, state: { profile: { name: 'research' } }, body: null }

    await usageStats(ctx)

    expect(mockGetSkillUsageStatsFromDb).toHaveBeenCalledWith(30, undefined, 'research')
    expect(ctx.body.period_days).toBe(7)
  })

  it('falls back to active profile when no request profile is set', async () => {
    mockGetActiveProfileName.mockReturnValue('travel')
    const { usageStats } = await loadController()
    const ctx: any = { query: {}, state: {}, body: null }

    await usageStats(ctx)

    expect(mockGetSkillUsageStatsFromDb).toHaveBeenCalledWith(7, undefined, 'travel')
  })

  it('toggles skills in the request-scoped profile config', async () => {
    let updatedConfig: Record<string, any> | undefined
    mockUpdateConfigYamlForProfile.mockImplementation(async (_profile: string, updater: (config: Record<string, any>) => Record<string, any>) => {
      updatedConfig = await updater({ skills: { disabled: ['old-skill'] }, model: { default: 'glm-5.1' } })
      return undefined
    })
    const { toggle } = await loadController()
    const ctx: any = {
      request: { body: { name: 'new-skill', enabled: false } },
      state: { profile: { name: 'research' } },
      body: null,
    }

    await toggle(ctx)

    expect(mockUpdateConfigYamlForProfile).toHaveBeenCalledWith('research', expect.any(Function))
    expect(updatedConfig).toEqual({
      skills: { disabled: ['old-skill', 'new-skill'] },
      model: { default: 'glm-5.1' },
    })
    expect(ctx.body).toEqual({ success: true })
  })

  it('lists configured external skill directories with external source while keeping local skills first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-external-skills-'))
    const profileDir = join(root, 'profile')
    const localSkillDir = join(profileDir, 'skills', 'tools', 'dupe-skill')
    const externalDir = join(root, 'external-skills')
    const externalSkillDir = join(externalDir, 'tools', 'external-skill')
    const externalDupeDir = join(externalDir, 'tools', 'dupe-skill')

    await mkdir(localSkillDir, { recursive: true })
    await mkdir(externalSkillDir, { recursive: true })
    await mkdir(externalDupeDir, { recursive: true })
    await writeFile(join(localSkillDir, 'SKILL.md'), '# Local Dupe\nlocal copy\n', 'utf-8')
    await writeFile(join(externalSkillDir, 'SKILL.md'), '# External Skill\nexternal copy\n', 'utf-8')
    await writeFile(join(externalDupeDir, 'SKILL.md'), '# External Dupe\nexternal duplicate\n', 'utf-8')

    mockGetProfileDir.mockReturnValue(profileDir)
    mockReadConfigYamlForProfile.mockResolvedValue({
      skills: { external_dirs: [externalDir] },
    })

    try {
      const { list } = await loadController()
      const ctx: any = { state: { profile: { name: 'research' } }, body: null }

      await list(ctx)

      const tools = ctx.body.categories.find((category: any) => category.name === 'tools')
      expect(tools.skills).toEqual([
        expect.objectContaining({ name: 'dupe-skill', source: 'local', editable: true, description: 'local copy' }),
        expect.objectContaining({ name: 'external-skill', source: 'external', editable: false, description: 'external copy' }),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // Regression: Hermes installs most skills as SYMLINKS into the profile skills/
  // scan root (lark-* suite, kep-*-cli, kep-trevi-*, personal/managed installs).
  // Node readdir({withFileTypes}) reports a symlink as isDirectory()===false, so a
  // bare isDirectory() filter silently DROPS every symlinked skill from the page
  // (the upstream re-baseline regression). The scan must follow symlinks.
  it('lists symlinked skills (top-level flat + nested in a category), not just real dirs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-symlink-skills-'))
    const profileDir = join(root, 'profile')
    const skillsRoot = join(profileDir, 'skills')
    // Shared central skills dir that the profile symlinks INTO (mirrors ~/.hermes/skills).
    const central = join(root, 'central-skills')

    // A real-dir skill nested in a category (should keep showing).
    const realSkillDir = join(skillsRoot, 'tools', 'real-skill')
    await mkdir(realSkillDir, { recursive: true })
    await writeFile(join(realSkillDir, 'SKILL.md'), '# Real Skill\nreal dir\n', 'utf-8')

    // Central targets for the symlinks.
    const centralFlat = join(central, 'lark-im')
    const centralNested = join(central, 'linked-skill')
    await mkdir(centralFlat, { recursive: true })
    await mkdir(centralNested, { recursive: true })
    await writeFile(join(centralFlat, 'SKILL.md'), '# Lark IM\nsymlinked flat\n', 'utf-8')
    await writeFile(join(centralNested, 'SKILL.md'), '# Linked Skill\nsymlinked nested\n', 'utf-8')

    // Top-level flat symlinked skill (lark-im pattern) → misc category.
    await symlink(centralFlat, join(skillsRoot, 'lark-im'))
    // Symlinked skill INSIDE a category → tools category.
    await symlink(centralNested, join(skillsRoot, 'tools', 'linked-skill'))

    mockGetProfileDir.mockReturnValue(profileDir)
    mockReadConfigYamlForProfile.mockResolvedValue({})

    try {
      const { list } = await loadController()
      const ctx: any = { state: { profile: { name: 'research' } }, body: null }

      await list(ctx)

      const names = (ctx.body.categories as any[]).flatMap(c => c.skills.map((s: any) => s.name))
      // Real dir still present.
      expect(names).toContain('real-skill')
      // The two symlinked skills MUST appear (bare isDirectory() drops them).
      expect(names).toContain('lark-im')
      expect(names).toContain('linked-skill')

      const tools = ctx.body.categories.find((c: any) => c.name === 'tools')
      expect(tools.skills.map((s: any) => s.name).sort()).toEqual(['linked-skill', 'real-skill'])
      const misc = ctx.body.categories.find((c: any) => c.name === 'misc')
      expect(misc.skills.map((s: any) => s.name)).toContain('lark-im')

      // Symlinked (managed) skills must surface as READ-ONLY: editable:false so the
      // UI hides edit/delete affordances. Real-dir local skills stay editable.
      const findSkill = (n: string) => ctx.body.categories.flatMap((c: any) => c.skills).find((s: any) => s.name === n)
      expect(findSkill('real-skill')).toMatchObject({ source: 'local', editable: true })
      expect(findSkill('lark-im').editable).toBe(false)
      expect(findSkill('linked-skill').editable).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to delete a symlinked (managed) skill — symlink and its shared target survive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-delete-symlink-'))
    const profileDir = join(root, 'research')
    const skillsRoot = join(profileDir, 'skills')
    const central = join(root, 'central-skills', 'lark-im')
    await mkdir(central, { recursive: true })
    await mkdir(join(skillsRoot, 'tools'), { recursive: true })
    await writeFile(join(central, 'SKILL.md'), '# Lark IM\nshared install\n', 'utf-8')
    const linkPath = join(skillsRoot, 'tools', 'lark-im')
    await symlink(central, linkPath)
    mockGetProfileDir.mockReturnValue(profileDir)

    const ctx: any = {
      params: { category: 'tools', skill: 'lark-im' },
      state: { profile: { name: 'research' } },
      body: null,
    }

    try {
      const { deleteSkill } = await loadController()
      await deleteSkill(ctx)

      expect(ctx.status).toBe(403)
      // The symlink is untouched (skill still installed) and the SHARED target is intact.
      await expect(readFile(join(linkPath, 'SKILL.md'), 'utf-8')).resolves.toContain('shared install')
      await expect(readFile(join(central, 'SKILL.md'), 'utf-8')).resolves.toContain('shared install')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prefers keephub provenance over hub when listing skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-keephub-list-'))
    const profileDir = join(root, 'research')
    const skillDir = join(profileDir, 'skills', 'tools', 'shared-skill')
    const hubLockDir = join(profileDir, 'skills', '.hub')
    const keephubLockDir = join(profileDir, 'skills', '.keephub')

    await mkdir(skillDir, { recursive: true })
    await mkdir(hubLockDir, { recursive: true })
    await mkdir(keephubLockDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '# Shared Skill\nsynced copy\n', 'utf-8')
    await writeFile(join(hubLockDir, 'lock.json'), JSON.stringify({ installed: { 'shared-skill': { version: '1.0.0' } } }), 'utf-8')
    await writeFile(join(keephubLockDir, 'lock.json'), JSON.stringify({ installed: { 'shared-skill': { version: '2.0.0' } } }), 'utf-8')
    mockGetProfileDir.mockReturnValue(profileDir)

    try {
      const { list } = await loadController()
      const ctx: any = { state: { profile: { name: 'research' } }, body: null }

      await list(ctx)

      const tools = ctx.body.categories.find((category: any) => category.name === 'tools')
      expect(tools.skills).toEqual([
        expect.objectContaining({ name: 'shared-skill', source: 'keephub', editable: false, description: 'synced copy' }),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('updates external skill directories in the request-scoped profile config', async () => {
    let updatedConfig: Record<string, any> | undefined
    mockUpdateConfigYamlForProfile.mockImplementation(async (_profile: string, updater: (config: Record<string, any>) => Record<string, any>) => {
      updatedConfig = await updater({ skills: { disabled: ['old-skill'] }, model: { default: 'glm-5.1' } })
      return undefined
    })
    const { updateExternalDirs } = await loadController()
    const ctx: any = {
      request: { body: { dirs: [' ~/research-skills ', '', '~/research-skills', '$HOME/shared-skills'] } },
      state: { profile: { name: 'research' } },
      body: null,
    }

    await updateExternalDirs(ctx)

    expect(mockUpdateConfigYamlForProfile).toHaveBeenCalledWith('research', expect.any(Function))
    expect(updatedConfig).toEqual({
      skills: { disabled: ['old-skill'], external_dirs: ['~/research-skills', '$HOME/shared-skills'] },
      model: { default: 'glm-5.1' },
    })
    expect(ctx.body).toEqual({ success: true, dirs: ['~/research-skills', '$HOME/shared-skills'] })
  })

  it('imports skills into the request-scoped profile directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-import-profile-'))
    const defaultProfileDir = join(root, 'default')
    const researchProfileDir = join(root, 'research')
    mockGetProfileDir.mockImplementation((profile: string) => profile === 'research' ? researchProfileDir : defaultProfileDir)

    const boundary = '----hermes-skill-import-test'
    const ctx: any = {
      get: vi.fn((header: string) => header.toLowerCase() === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
      req: Readable.from([multipartBody(boundary, [
        { name: 'file', filename: 'demo-skill/SKILL.md', contentType: 'text/markdown', value: '# Demo Skill\nresearch copy\n' },
      ])]),
      state: { profile: { name: 'research' } },
      body: null,
    }

    try {
      const { importSkill } = await loadController()

      await importSkill(ctx)

      await expect(readFile(join(researchProfileDir, 'skills', 'demo-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('# Demo Skill\nresearch copy\n')
      await expect(readFile(join(defaultProfileDir, 'skills', 'demo-skill', 'SKILL.md'), 'utf-8')).rejects.toThrow()
      expect(ctx.body).toEqual({ success: true, name: 'demo-skill' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns bad request for malformed encoded skill import filenames', async () => {
    const boundary = '----hermes-skill-import-bad-filename'
    const ctx: any = {
      get: vi.fn((header: string) => header.toLowerCase() === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
      req: Readable.from([multipartBody(boundary, [
        { name: 'file', filenameStar: '%E0%A4%A', contentType: 'text/markdown', value: '# Demo Skill\n' },
      ])]),
      state: { profile: { name: 'research' } },
      body: null,
    }

    const { importSkill } = await loadController()

    await importSkill(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Invalid multipart filename encoding' })
  })

  it('imports skills with valid encoded multipart filenames', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-import-encoded-filename-'))
    const profileDir = join(root, 'research')
    mockGetProfileDir.mockReturnValue(profileDir)

    const boundary = '----hermes-skill-import-encoded-filename'
    const ctx: any = {
      get: vi.fn((header: string) => header.toLowerCase() === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
      req: Readable.from([multipartBody(boundary, [
        { name: 'file', filenameStar: 'demo-skill%2FSKILL.md', contentType: 'text/markdown', value: '# Demo Skill\nencoded filename\n' },
      ])]),
      state: { profile: { name: 'research' } },
      body: null,
    }

    try {
      const { importSkill } = await loadController()

      await importSkill(ctx)

      await expect(readFile(join(profileDir, 'skills', 'demo-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('# Demo Skill\nencoded filename\n')
      expect(ctx.body).toEqual({ success: true, name: 'demo-skill' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('deletes local skills only from the request-scoped profile directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-delete-profile-'))
    const defaultProfileDir = join(root, 'default')
    const researchProfileDir = join(root, 'research')
    const defaultSkillDir = join(defaultProfileDir, 'skills', 'tools', 'dupe-skill')
    const researchSkillDir = join(researchProfileDir, 'skills', 'tools', 'dupe-skill')
    await mkdir(defaultSkillDir, { recursive: true })
    await mkdir(researchSkillDir, { recursive: true })
    await writeFile(join(defaultSkillDir, 'SKILL.md'), '# Default Copy\n', 'utf-8')
    await writeFile(join(researchSkillDir, 'SKILL.md'), '# Research Copy\n', 'utf-8')
    mockGetProfileDir.mockImplementation((profile: string) => profile === 'research' ? researchProfileDir : defaultProfileDir)

    const ctx: any = {
      params: { category: 'tools', skill: 'dupe-skill' },
      state: { profile: { name: 'research' } },
      body: null,
    }

    try {
      const { deleteSkill } = await loadController()

      await deleteSkill(ctx)

      await expect(readFile(join(defaultSkillDir, 'SKILL.md'), 'utf-8')).resolves.toBe('# Default Copy\n')
      await expect(readFile(join(researchSkillDir, 'SKILL.md'), 'utf-8')).rejects.toThrow()
      expect(ctx.body).toEqual({ success: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects deleting keephub-managed skills from the request-scoped profile directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-delete-keephub-skill-'))
    const profileDir = join(root, 'research')
    const skillDir = join(profileDir, 'skills', 'tools', 'shared-skill')
    const keephubLockDir = join(profileDir, 'skills', '.keephub')
    await mkdir(skillDir, { recursive: true })
    await mkdir(keephubLockDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '# Shared Skill\n', 'utf-8')
    await writeFile(join(keephubLockDir, 'lock.json'), JSON.stringify({ installed: { 'shared-skill': { version: '1.0.0' } } }), 'utf-8')
    mockGetProfileDir.mockReturnValue(profileDir)

    const ctx: any = {
      params: { category: 'tools', skill: 'shared-skill' },
      state: { profile: { name: 'research' } },
      body: null,
    }

    try {
      const { deleteSkill } = await loadController()

      await deleteSkill(ctx)

      await expect(readFile(join(skillDir, 'SKILL.md'), 'utf-8')).resolves.toBe('# Shared Skill\n')
      expect(ctx.status).toBe(403)
      expect(ctx.body).toEqual({ error: 'Only local skills can be deleted (this skill is keephub)' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('updates an editable request-scoped profile-local skill file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-edit-local-skill-'))
    const profileDir = join(root, 'research')
    const skillDir = join(profileDir, 'skills', 'daily-writing')
    const skillPath = join(skillDir, 'SKILL.md')
    await mkdir(skillDir, { recursive: true })
    await writeFile(skillPath, '# Daily Writing\nold instructions\n', 'utf-8')
    mockGetProfileDir.mockReturnValue(profileDir)

    const ctx: any = {
      request: {
        body: {
          category: 'misc',
          skill: 'daily-writing',
          path: 'SKILL.md',
          content: '# Daily Writing\nnew instructions\n',
        },
      },
      state: { profile: { name: 'research' } },
      body: null,
    }

    try {
      const { updateFile_ } = await loadController()

      await updateFile_(ctx)

      await expect(readFile(skillPath, 'utf-8')).resolves.toBe('# Daily Writing\nnew instructions\n')
      expect(ctx.body).toEqual({ success: true, content: '# Daily Writing\nnew instructions\n' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects editing keephub-managed skills so synced directories remain read-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-edit-keephub-skill-'))
    const profileDir = join(root, 'research')
    const skillDir = join(profileDir, 'skills', 'daily-writing')
    const skillPath = join(skillDir, 'SKILL.md')
    const keephubLockDir = join(profileDir, 'skills', '.keephub')
    await mkdir(skillDir, { recursive: true })
    await mkdir(keephubLockDir, { recursive: true })
    await writeFile(skillPath, '# Daily Writing\nkeep synced instructions\n', 'utf-8')
    await writeFile(join(keephubLockDir, 'lock.json'), JSON.stringify({ installed: { 'daily-writing': { version: '1.0.0' } } }), 'utf-8')
    mockGetProfileDir.mockReturnValue(profileDir)

    const ctx: any = {
      request: {
        body: {
          category: 'misc',
          skill: 'daily-writing',
          path: 'SKILL.md',
          content: '# Daily Writing\nchanged locally\n',
        },
      },
      state: { profile: { name: 'research' } },
      body: null,
    }

    try {
      const { updateFile_ } = await loadController()

      await updateFile_(ctx)

      await expect(readFile(skillPath, 'utf-8')).resolves.toBe('# Daily Writing\nkeep synced instructions\n')
      expect(ctx.status).toBe(403)
      expect(ctx.body).toEqual({ error: 'Skill is read-only' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects editing configured external skills so shared directories remain read-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-edit-external-skill-'))
    const profileDir = join(root, 'research')
    const externalDir = join(root, 'external-skills')
    const externalSkillDir = join(externalDir, 'tools', 'external-skill')
    const skillPath = join(externalSkillDir, 'SKILL.md')
    await mkdir(join(profileDir, 'skills'), { recursive: true })
    await mkdir(externalSkillDir, { recursive: true })
    await writeFile(skillPath, '# External Skill\nexternal instructions\n', 'utf-8')
    mockGetProfileDir.mockReturnValue(profileDir)
    mockReadConfigYamlForProfile.mockResolvedValue({
      skills: { external_dirs: [externalDir] },
    })

    const ctx: any = {
      request: {
        body: {
          category: 'tools',
          skill: 'external-skill',
          path: 'SKILL.md',
          content: '# External Skill\nchanged externally\n',
        },
      },
      state: { profile: { name: 'research' } },
      body: null,
    }

    try {
      const { updateFile_ } = await loadController()

      await updateFile_(ctx)

      await expect(readFile(skillPath, 'utf-8')).resolves.toBe('# External Skill\nexternal instructions\n')
      expect(ctx.status).toBe(403)
      expect(ctx.body).toEqual({ error: 'Skill is read-only' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects editing profile-local skill directories that are symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-edit-symlink-skill-'))
    const profileDir = join(root, 'research')
    const sharedSkillDir = join(root, 'shared', 'daily-writing')
    const localSkillsDir = join(profileDir, 'skills')
    const localSkillLink = join(localSkillsDir, 'daily-writing')
    const skillPath = join(sharedSkillDir, 'SKILL.md')
    await mkdir(sharedSkillDir, { recursive: true })
    await mkdir(localSkillsDir, { recursive: true })
    await writeFile(skillPath, '# Shared Skill\nshared instructions\n', 'utf-8')
    await symlink(sharedSkillDir, localSkillLink, 'dir')
    mockGetProfileDir.mockReturnValue(profileDir)

    const ctx: any = {
      request: {
        body: {
          category: 'misc',
          skill: 'daily-writing',
          path: 'SKILL.md',
          content: '# Shared Skill\nchanged through link\n',
        },
      },
      state: { profile: { name: 'research' } },
      body: null,
    }

    try {
      const { updateFile_ } = await loadController()

      await updateFile_(ctx)

      await expect(readFile(skillPath, 'utf-8')).resolves.toBe('# Shared Skill\nshared instructions\n')
      expect(ctx.status).toBe(403)
      expect(ctx.body).toEqual({ error: 'Skill is read-only' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects editing files reached through symlinked subdirectories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-edit-symlink-subdir-'))
    const profileDir = join(root, 'research')
    const skillDir = join(profileDir, 'skills', 'daily-writing')
    const outsideDir = join(root, 'outside')
    const outsideFile = join(outsideDir, 'note.md')
    await mkdir(skillDir, { recursive: true })
    await mkdir(outsideDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '# Daily Writing\nlocal instructions\n', 'utf-8')
    await writeFile(outsideFile, 'outside original\n', 'utf-8')
    await symlink(outsideDir, join(skillDir, 'references'), 'dir')
    mockGetProfileDir.mockReturnValue(profileDir)

    const ctx: any = {
      request: {
        body: {
          category: 'misc',
          skill: 'daily-writing',
          path: 'references/note.md',
          content: 'outside changed\n',
        },
      },
      state: { profile: { name: 'research' } },
      body: null,
    }

    try {
      const { updateFile_ } = await loadController()

      await updateFile_(ctx)

      await expect(readFile(outsideFile, 'utf-8')).resolves.toBe('outside original\n')
      expect(ctx.status).toBe(403)
      expect(ctx.body).toEqual({ error: 'Access denied' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
