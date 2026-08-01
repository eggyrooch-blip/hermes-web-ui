import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'node:stream'

const mockGetSkillUsageStatsFromDb = vi.hoisted(() => vi.fn())
const mockGetActiveProfileName = vi.hoisted(() => vi.fn())
const mockGetProfileDir = vi.hoisted(() => vi.fn())
const mockGetHermesBaseDir = vi.hoisted(() => vi.fn())
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
  getHermesBaseDir: mockGetHermesBaseDir,
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
    mockGetHermesBaseDir.mockReturnValue('/tmp/hermes-shared-root')
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

  it('serves the detail/files path for a nested symlinked skill (does not 404)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-files-symlink-'))
    const profileDir = join(root, 'research')
    const skillsRoot = join(profileDir, 'skills')
    // Mirror production: managed installs symlink into the SHARED skills root
    // (<shared>/skills), which is on the read-path allow-list.
    const central = join(root, 'skills', 'nested-linked')
    await mkdir(central, { recursive: true })
    await mkdir(join(skillsRoot, 'tools'), { recursive: true })
    await writeFile(join(central, 'SKILL.md'), '# Nested Linked\n', 'utf-8')
    // Nested symlinked skill: skills/tools/nested-linked → central. The list now
    // shows it, so its files endpoint must resolve it (findSkillDirByName follows symlinks).
    await symlink(central, join(skillsRoot, 'tools', 'nested-linked'))
    mockGetProfileDir.mockReturnValue(profileDir)
    mockGetHermesBaseDir.mockReturnValue(root)
    mockReadConfigYamlForProfile.mockResolvedValue({})
    mockListFilesRecursive.mockResolvedValue([{ path: 'SKILL.md' }, { path: 'guide.md' }])

    const ctx: any = {
      params: { category: 'tools', skill: 'nested-linked' },
      state: { profile: { name: 'research' } },
      status: 200,
      body: null,
    }

    try {
      const { listFiles } = await loadController()
      await listFiles(ctx)

      expect(ctx.status).not.toBe(404)
      expect(ctx.body.files).toEqual([{ path: 'guide.md' }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses skills access for an UNPROVISIONED profile instead of falling back to the shared root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-unprovisioned-'))
    // Central shared repo exists and holds skills that many profiles symlink to.
    await mkdir(join(root, 'skills', 'lark-doc'), { recursive: true })
    await writeFile(join(root, 'skills', 'lark-doc', 'SKILL.md'), '# CENTRAL\n', 'utf-8')
    // The caller's profile dir does NOT exist → getProfileDir() falls back to root.
    mockGetProfileDir.mockReturnValue(root)
    mockGetHermesBaseDir.mockReturnValue(root)

    const ctx: any = {
      params: { path: 'lark-doc/SKILL.md' },
      state: { profile: { name: 'ghost-profile' } },
      status: 200,
      body: null,
    }

    try {
      const { readFile_, deleteSkill } = await loadController()
      await readFile_(ctx)
      expect(ctx.status).toBe(403)
      expect(JSON.stringify(ctx.body)).not.toContain('CENTRAL')

      const delCtx: any = {
        params: { category: 'misc', skill: 'lark-doc' },
        state: { profile: { name: 'ghost-profile' } },
        status: 200,
        body: null,
      }
      await deleteSkill(delCtx)
      expect(delCtx.status).toBe(403)
      // Central repo untouched
      expect(await readFile(join(root, 'skills', 'lark-doc', 'SKILL.md'), 'utf-8')).toContain('CENTRAL')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // ── Read-path containment (fork) ────────────────────────────────────────────
  // A tenant's agent can create symlinks under its own skills dir (the sandbox
  // binds PROFILE_HOME read-write). The WebUI process does NOT run inside the
  // sandbox, so a lexical containment check would let it follow such a link into
  // another tenant's profile. Reads must resolve the REAL path and require it to
  // land in an allow-listed root.

  // Review round 1 blockers: the allow-list alone was bypassable because one of
  // its entries (external_dirs) is tenant-controlled, and because the skills dir
  // itself can be a symlink. A deny rule now outranks the allow-list.

  it('R4-BLOCKER: chaining INSIDE the own skills dir and out to / is refused', async () => {
    // Round-4 review finding: <profile>/skills/a -> <profile>/skills/b -> /
    // The first hop stays in the tenant's own skills dir, so a naive first-hop
    // check treats it as trusted and GET a/etc/passwd reads arbitrary host files.
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-selfchain-'))
    const outside = join(root, 'outside')
    const profileSkills = join(root, 'profiles', 'attacker', 'skills')
    await mkdir(join(outside, 'etc'), { recursive: true })
    await mkdir(profileSkills, { recursive: true })
    await writeFile(join(outside, 'etc', 'passwd'), 'HOST-PASSWD-XYZ\n', 'utf-8')
    await symlink(outside, join(profileSkills, 'b'))              // hop 2: escapes
    await symlink(join(profileSkills, 'b'), join(profileSkills, 'a')) // hop 1: stays inside
    mockGetProfileDir.mockReturnValue(join(root, 'profiles', 'attacker'))
    mockGetHermesBaseDir.mockReturnValue(root)

    const ctx: any = {
      params: { path: 'a/etc/passwd' },
      state: { profile: { name: 'attacker' } },
      status: 200,
      body: null,
    }

    try {
      const { readFile_ } = await loadController()
      await readFile_(ctx)

      expect(ctx.status).toBe(403)
      expect(JSON.stringify(ctx.body)).not.toContain('HOST-PASSWD')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('R3: a TWO-HOP managed chain (<profile>/skills/x -> <shared>/skills/x -> ~/.agents/skills/x) still reads', async () => {
    // Real production shape, found by browser verification: the central repo entry
    // is itself a symlink into another platform-owned root. Resolving to the END of
    // the chain refuses it; only the tenant-controlled FIRST hop must be trusted.
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-twohop-'))
    const agentsRoot = join(root, 'agents-skills', 'lark-doc')
    const sharedSkills = join(root, 'skills')
    const profileSkills = join(root, 'profiles', 'research', 'skills')
    await mkdir(agentsRoot, { recursive: true })
    await mkdir(sharedSkills, { recursive: true })
    await mkdir(profileSkills, { recursive: true })
    await writeFile(join(agentsRoot, 'SKILL.md'), '# Lark Doc\nchained managed skill\n', 'utf-8')
    await symlink(agentsRoot, join(sharedSkills, 'lark-doc'))           // hop 2: platform-owned
    await symlink(join(sharedSkills, 'lark-doc'), join(profileSkills, 'lark-doc')) // hop 1: tenant-visible
    mockGetProfileDir.mockReturnValue(join(root, 'profiles', 'research'))
    mockGetHermesBaseDir.mockReturnValue(root)

    const ctx: any = {
      params: { path: 'lark-doc/SKILL.md' },
      state: { profile: { name: 'research' } },
      status: 200,
      body: null,
    }

    try {
      const { readFile_ } = await loadController()
      await readFile_(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.content).toContain('chained managed skill')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('R3-deny: a two-hop chain whose END lands in another profile is still refused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-twohop-deny-'))
    const victimSkills = join(root, 'profiles', 'victim', 'skills', 'private')
    const sharedSkills = join(root, 'skills')
    const attackerSkills = join(root, 'profiles', 'attacker', 'skills')
    await mkdir(victimSkills, { recursive: true })
    await mkdir(sharedSkills, { recursive: true })
    await mkdir(attackerSkills, { recursive: true })
    await writeFile(join(victimSkills, 'SKILL.md'), 'VICTIM-TOPSECRET\n', 'utf-8')
    // hop 2 points back INTO a profile — the deny rule must still win even though
    // the tenant's first hop lands in the trusted shared root.
    await symlink(victimSkills, join(sharedSkills, 'trojan'))
    await symlink(join(sharedSkills, 'trojan'), join(attackerSkills, 'trojan'))
    mockGetProfileDir.mockReturnValue(join(root, 'profiles', 'attacker'))
    mockGetHermesBaseDir.mockReturnValue(root)

    const ctx: any = {
      params: { path: 'trojan/SKILL.md' },
      state: { profile: { name: 'attacker' } },
      status: 200,
      body: null,
    }

    try {
      const { readFile_ } = await loadController()
      await readFile_(ctx)

      expect(ctx.status).toBe(403)
      expect(JSON.stringify(ctx.body)).not.toContain('VICTIM-TOPSECRET')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('R2-1b: a symlinked PROFILE dir (real skills child) is refused — intermediate component', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-profiledir-symlink-'))
    const fakeEtc = join(root, 'etc')
    await mkdir(join(fakeEtc, 'skills'), { recursive: true })
    await mkdir(join(root, 'profiles'), { recursive: true })
    await writeFile(join(fakeEtc, 'skills', 'SKILL.md'), 'ROOT-PASSWD-XYZ\n', 'utf-8')
    // The PROFILE dir is the symlink; `skills` under it is a real directory, so a
    // final-component lstat check would wave this through.
    const attackerDir = join(root, 'profiles', 'attacker')
    await symlink(fakeEtc, attackerDir)
    mockGetProfileDir.mockReturnValue(attackerDir)
    mockGetHermesBaseDir.mockReturnValue(root)

    const ctx: any = {
      params: { path: 'SKILL.md' },
      state: { profile: { name: 'attacker' } },
      status: 200,
      body: null,
    }

    try {
      const { readFile_ } = await loadController()
      await readFile_(ctx)

      expect(ctx.status).toBe(403)
      expect(JSON.stringify(ctx.body)).not.toContain('ROOT-PASSWD')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('R2-1: a skills dir symlinked OUTSIDE profiles (e.g. /etc) is refused, not allow-listed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-skillsdir-etc-'))
    // Stand-in for /etc: a system dir that is NOT under <shared>/profiles, so the
    // deny rule alone would not catch it.
    const fakeEtc = join(root, 'etc')
    const attackerDir = join(root, 'profiles', 'attacker')
    await mkdir(fakeEtc, { recursive: true })
    await mkdir(attackerDir, { recursive: true })
    await writeFile(join(fakeEtc, 'SKILL.md'), 'ROOT-PASSWD-XYZ\n', 'utf-8')
    await symlink(fakeEtc, join(attackerDir, 'skills'))
    mockGetProfileDir.mockReturnValue(attackerDir)
    mockGetHermesBaseDir.mockReturnValue(root)

    const ctx: any = {
      params: { path: 'SKILL.md' },
      state: { profile: { name: 'attacker' } },
      status: 200,
      body: null,
    }

    try {
      const { readFile_ } = await loadController()
      await readFile_(ctx)

      expect(ctx.status).toBe(403)
      expect(JSON.stringify(ctx.body)).not.toContain('ROOT-PASSWD')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('R2-3: listExternalDirs refuses an unprovisioned profile (no shared-root fallback)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-extdirs-ghost-'))
    await mkdir(join(root, 'skills'), { recursive: true })
    // Ghost profile → getProfileDir falls back to the shared root.
    mockGetProfileDir.mockReturnValue(root)
    mockGetHermesBaseDir.mockReturnValue(root)
    mockReadConfigYamlForProfile.mockResolvedValue({ skills: { external_dirs: ['/srv/team-skills'] } })

    const ctx: any = { state: { profile: { name: 'ghost-profile' } }, status: 200, body: null }

    try {
      const { listExternalDirs } = await loadController()
      await listExternalDirs(ctx)

      expect(ctx.status).toBe(403)
      expect(JSON.stringify(ctx.body)).not.toContain('team-skills')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('BLOCKER-1: external_dirs pointing at another profile does NOT allow-list it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-extdir-escape-'))
    const victimSkills = join(root, 'profiles', 'victim', 'skills', 'secret-skill')
    const attackerDir = join(root, 'profiles', 'attacker')
    await mkdir(victimSkills, { recursive: true })
    await mkdir(join(attackerDir, 'skills'), { recursive: true })
    await writeFile(join(victimSkills, 'SKILL.md'), 'VICTIM_SECRET=hunter2\n', 'utf-8')
    // Attacker points their own external_dirs at the victim's skills root and
    // symlinks it into their own skills dir.
    await symlink(join(root, 'profiles', 'victim', 'skills'), join(attackerDir, 'skills', 'peek'))
    mockGetProfileDir.mockReturnValue(attackerDir)
    mockGetHermesBaseDir.mockReturnValue(root)
    mockReadConfigYamlForProfile.mockResolvedValue({
      skills: { external_dirs: [join(root, 'profiles', 'victim', 'skills')] },
    })

    const ctx: any = {
      params: { path: 'peek/secret-skill/SKILL.md' },
      state: { profile: { name: 'attacker' } },
      status: 200,
      body: null,
    }

    try {
      const { readFile_ } = await loadController()
      await readFile_(ctx)

      expect(ctx.status).toBe(403)
      expect(JSON.stringify(ctx.body)).not.toContain('hunter2')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('BLOCKER-2: a skills dir that is ITSELF a symlink to another profile is refused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-skillsdir-symlink-'))
    const victimSkills = join(root, 'profiles', 'victim', 'skills', 'private')
    const attackerDir = join(root, 'profiles', 'attacker')
    await mkdir(victimSkills, { recursive: true })
    await mkdir(attackerDir, { recursive: true })
    await writeFile(join(victimSkills, 'SKILL.md'), 'TOPSECRET-XYZ\n', 'utf-8')
    // The attacker's whole skills dir is a link into the victim's.
    await symlink(join(root, 'profiles', 'victim', 'skills'), join(attackerDir, 'skills'))
    mockGetProfileDir.mockReturnValue(attackerDir)
    mockGetHermesBaseDir.mockReturnValue(root)

    const ctx: any = {
      params: { path: 'private/SKILL.md' },
      state: { profile: { name: 'attacker' } },
      status: 200,
      body: null,
    }

    try {
      const { readFile_ } = await loadController()
      await readFile_(ctx)

      expect(ctx.status).toBe(403)
      expect(JSON.stringify(ctx.body)).not.toContain('TOPSECRET')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to READ a file through a symlink pointing at another profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-read-escape-'))
    const victimDir = join(root, 'profiles', 'victim')
    const attackerSkills = join(root, 'profiles', 'attacker', 'skills')
    await mkdir(victimDir, { recursive: true })
    await mkdir(attackerSkills, { recursive: true })
    await writeFile(join(victimDir, 'SKILL.md'), '# VICTIM SECRET\n', 'utf-8')
    await symlink(victimDir, join(attackerSkills, 'evil'))
    mockGetProfileDir.mockReturnValue(join(root, 'profiles', 'attacker'))
    mockGetHermesBaseDir.mockReturnValue(root)

    const ctx: any = {
      params: { path: 'evil/SKILL.md' },
      state: { profile: { name: 'attacker' } },
      status: 200,
      body: null,
    }

    try {
      const { readFile_ } = await loadController()
      await readFile_(ctx)

      expect(ctx.status).toBe(403)
      expect(JSON.stringify(ctx.body)).not.toContain('VICTIM SECRET')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to LIST files through a symlink pointing outside the allow-listed roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-list-escape-'))
    const outside = join(root, 'elsewhere', 'stolen')
    const attackerSkills = join(root, 'profiles', 'attacker', 'skills')
    await mkdir(outside, { recursive: true })
    await mkdir(attackerSkills, { recursive: true })
    await writeFile(join(outside, 'SKILL.md'), '# OUTSIDE\n', 'utf-8')
    await symlink(outside, join(attackerSkills, 'stolen'))
    mockGetProfileDir.mockReturnValue(join(root, 'profiles', 'attacker'))
    mockGetHermesBaseDir.mockReturnValue(root)
    mockListFilesRecursive.mockResolvedValue([{ path: 'SKILL.md' }, { path: 'loot.md' }])

    const ctx: any = {
      params: { category: 'misc', skill: 'stolen' },
      state: { profile: { name: 'attacker' } },
      status: 200,
      body: null,
    }

    try {
      const { listFiles } = await loadController()
      await listFiles(ctx)

      expect(ctx.status).toBe(403)
      expect(ctx.body.files).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('still READS a managed skill symlinked into the shared skills root (regression: 110k prod installs)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-read-managed-'))
    const shared = join(root, 'skills', 'lark-doc')
    const profileSkills = join(root, 'profiles', 'research', 'skills')
    await mkdir(shared, { recursive: true })
    await mkdir(profileSkills, { recursive: true })
    await writeFile(join(shared, 'SKILL.md'), '# Lark Doc\n', 'utf-8')
    await symlink(shared, join(profileSkills, 'lark-doc'))
    mockGetProfileDir.mockReturnValue(join(root, 'profiles', 'research'))
    mockGetHermesBaseDir.mockReturnValue(root)

    const ctx: any = {
      params: { path: 'lark-doc/SKILL.md' },
      state: { profile: { name: 'research' } },
      status: 200,
      body: null,
    }

    try {
      const { readFile_ } = await loadController()
      await readFile_(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.content).toContain('Lark Doc')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('still READS a skill under a configured external_dirs root — DIRECTLY, no symlink', async () => {
    // Round-5 review caught the previous version of this test: it symlinked the
    // external dir into the profile, which is NOT how external skills are read.
    // The real path has no symlink at all, so the containment check must accept a
    // target that simply resolves inside a configured external root.
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-read-external-'))
    const external = join(root, 'team-skills', 'shared-helper')
    const profileSkills = join(root, 'profiles', 'research', 'skills')
    await mkdir(external, { recursive: true })
    await mkdir(profileSkills, { recursive: true })
    await writeFile(join(external, 'SKILL.md'), '# Shared Helper\nexternal skill body\n', 'utf-8')
    mockGetProfileDir.mockReturnValue(join(root, 'profiles', 'research'))
    mockGetHermesBaseDir.mockReturnValue(root)
    mockReadConfigYamlForProfile.mockResolvedValue({ skills: { external_dirs: [join(root, 'team-skills')] } })

    const ctx: any = {
      params: { path: 'misc/shared-helper/SKILL.md' },
      state: { profile: { name: 'research' } },
      status: 200,
      body: null,
    }

    try {
      const { readFile_ } = await loadController()
      await readFile_(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.content).toContain('external skill body')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats skills under a SYMLINKED container as read-only (editable:false + delete refused, target intact)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-symlink-container-'))
    const profileDir = join(root, 'research')
    const skillsRoot = join(profileDir, 'skills')
    // A real container in a shared location holding a REAL child skill.
    const sharedContainer = join(root, 'shared', 'vendor-pack')
    const childSkill = join(sharedContainer, 'child-skill')
    await mkdir(childSkill, { recursive: true })
    await writeFile(join(childSkill, 'SKILL.md'), '# Child Skill\nin shared pack\n', 'utf-8')
    await mkdir(skillsRoot, { recursive: true })
    // Symlink the whole CONTAINER as a category: skills/vendor-pack → sharedContainer.
    await symlink(sharedContainer, join(skillsRoot, 'vendor-pack'))
    mockGetProfileDir.mockReturnValue(profileDir)
    mockReadConfigYamlForProfile.mockResolvedValue({})

    try {
      const { list, deleteSkill, updateFile_ } = await loadController()

      // (1) The child is listed but READ-ONLY (descended through a symlink).
      const listCtx: any = { state: { profile: { name: 'research' } }, body: null }
      await list(listCtx)
      const child = listCtx.body.categories.flatMap((c: any) => c.skills).find((s: any) => s.name === 'child-skill')
      expect(child).toBeTruthy()
      expect(child.editable).toBe(false)

      // (2) Deleting it through the symlinked parent is REFUSED; shared target intact.
      const delCtx: any = {
        params: { category: 'vendor-pack', skill: 'child-skill' },
        state: { profile: { name: 'research' } },
        status: 200,
        body: null,
      }
      await deleteSkill(delCtx)
      expect(delCtx.status).toBe(403)
      await expect(readFile(join(childSkill, 'SKILL.md'), 'utf-8')).resolves.toContain('in shared pack')

      // (3) Editing it through the symlinked parent is REFUSED; shared target unchanged.
      const editCtx: any = {
        request: { body: { category: 'vendor-pack', skill: 'child-skill', path: 'SKILL.md', content: '# hijacked\n' } },
        state: { profile: { name: 'research' } },
        status: 200,
        body: null,
      }
      await updateFile_(editCtx)
      expect(editCtx.status).toBe(403)
      await expect(readFile(join(childSkill, 'SKILL.md'), 'utf-8')).resolves.toContain('in shared pack')
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
