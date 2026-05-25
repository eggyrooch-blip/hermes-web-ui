import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import YAML from 'js-yaml'

import { mergeExternalCategories, scanExternalSkillsDir, scanSkillsDir } from '../../packages/server/src/controllers/hermes/skills'

async function withHermesHome<T>(
  hermesHome: string,
  env: Record<string, string>,
  run: (skillsController: typeof import('../../packages/server/src/controllers/hermes/skills')) => Promise<T>,
): Promise<T> {
  const previousEnv = new Map<string, string | undefined>()
  for (const key of ['HERMES_HOME', ...Object.keys(env)]) {
    previousEnv.set(key, process.env[key])
  }
  process.env.HERMES_HOME = hermesHome
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value
  }
  vi.resetModules()
  try {
    const skillsController = await import('../../packages/server/src/controllers/hermes/skills')
    return await run(skillsController)
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    vi.resetModules()
  }
}

function chatContext(body: Record<string, unknown>) {
  return {
    request: { body },
    state: { user: { openid: 'ou_test', profile: 'alpha', role: 'user' } },
    query: {},
    get: () => '',
  } as any
}

describe('skills controller scanner', () => {
  it('includes profile skills installed as directory symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-webui-skills-'))
    const sharedSkill = join(root, 'shared', 'Keep', 'kep-prd-analysis')
    const profileSkills = join(root, 'profile', 'skills')
    await mkdir(sharedSkill, { recursive: true })
    await mkdir(join(profileSkills, 'Keep'), { recursive: true })
    await writeFile(
      join(sharedSkill, 'SKILL.md'),
      [
        '---',
        'name: kep-prd-analysis',
        'description: PRD analysis',
        '---',
        '# KEP PRD Analysis',
        '',
      ].join('\n'),
    )
    await symlink(sharedSkill, join(profileSkills, 'Keep', 'kep-prd-analysis'), 'dir')

    const categories = await scanSkillsDir(
      profileSkills,
      new Map(),
      new Set(),
      [],
      new Map(),
      true,
    )

    const keep = categories.find((category: any) => category.name === 'Keep')
    expect(keep?.skills.map((skill: any) => skill.name)).toContain('kep-prd-analysis')
  })

  it('merges configured external skills without overriding local skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-webui-external-skills-'))
    const localSkills = join(root, 'profile', 'skills')
    const externalSkills = join(root, 'external')
    await mkdir(join(localSkills, 'tools', 'dupe-skill'), { recursive: true })
    await mkdir(join(externalSkills, 'tools', 'external-skill'), { recursive: true })
    await mkdir(join(externalSkills, 'tools', 'dupe-skill'), { recursive: true })
    await writeFile(join(localSkills, 'tools', 'dupe-skill', 'SKILL.md'), '# Local Dupe\nlocal copy\n')
    await writeFile(join(externalSkills, 'tools', 'external-skill', 'SKILL.md'), '# External Skill\nexternal copy\n')
    await writeFile(join(externalSkills, 'tools', 'dupe-skill', 'SKILL.md'), '# External Dupe\nexternal duplicate\n')

    const localCategories = await scanSkillsDir(localSkills, new Map(), new Set(), [], new Map(), true)
    const externalCategories = await scanExternalSkillsDir(externalSkills, [], new Map())
    const merged = mergeExternalCategories(localCategories, externalCategories)

    const tools = merged.find((category: any) => category.name === 'tools')
    expect(tools?.skills).toEqual([
      expect.objectContaining({ name: 'dupe-skill', source: 'local', description: 'local copy' }),
      expect.objectContaining({ name: 'external-skill', source: 'external', description: 'external copy' }),
    ])
  })

  it('recursively includes category skills below nested directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-webui-recursive-skills-'))
    const profileSkills = join(root, 'profile', 'skills')
    await mkdir(join(profileSkills, 'eval', 'benchmarks', 'lm-evaluation-harness'), { recursive: true })
    await writeFile(
      join(profileSkills, 'eval', 'benchmarks', 'lm-evaluation-harness', 'SKILL.md'),
      '# LM Evaluation Harness\nbenchmark runner\n',
    )

    const categories = await scanSkillsDir(profileSkills, new Map(), new Set(), [], new Map(), true)

    const evalCategory = categories.find((category: any) => category.name === 'eval')
    expect(evalCategory?.skills).toEqual([
      expect.objectContaining({ name: 'lm-evaluation-harness', description: 'benchmark runner' }),
    ])
  })

  it('skips recursive symlink cycles while scanning nested skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-webui-cycle-skills-'))
    const profileSkills = join(root, 'profile', 'skills')
    const categoryDir = join(profileSkills, 'eval')
    await mkdir(join(categoryDir, 'benchmarks', 'stable-skill'), { recursive: true })
    await writeFile(join(categoryDir, 'benchmarks', 'stable-skill', 'SKILL.md'), '# Stable Skill\nsafe scan\n')
    await symlink(categoryDir, join(categoryDir, 'benchmarks', 'cycle'), 'dir')

    const scan = scanSkillsDir(profileSkills, new Map(), new Set(), [], new Map(), true)
    const categories = await Promise.race([
      scan,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('scan timed out')), 250)),
    ])

    const evalCategory = categories.find((category: any) => category.name === 'eval')
    expect(evalCategory?.skills).toEqual([
      expect.objectContaining({ name: 'stable-skill', description: 'safe scan' }),
    ])
  })

  it('writes chat-plane skill enablement to the current request profile config', async () => {
    const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-webui-toggle-profile-'))
    const profileDir = join(hermesHome, 'profiles', 'alpha')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(hermesHome, 'config.yaml'), 'skills:\n  disabled:\n    - root-only\n')
    await writeFile(join(profileDir, 'config.yaml'), 'skills:\n  disabled:\n    - profile-only\n')

    await withHermesHome(hermesHome, { HERMES_WEB_PLANE: 'chat' }, async ({ toggle }) => {
      const ctx = chatContext({ name: 'sample-skill', enabled: false })
      await toggle(ctx)
      expect(ctx.body).toEqual({ success: true })
    })

    const rootConfig = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    const profileConfig = YAML.load(await readFile(join(profileDir, 'config.yaml'), 'utf-8')) as any
    expect(rootConfig.skills.disabled).toEqual(['root-only'])
    expect(profileConfig.skills.disabled).toEqual(['profile-only', 'sample-skill'])
  })

  it('rejects invalid skill names before writing enablement config', async () => {
    const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-webui-toggle-invalid-'))
    const profileDir = join(hermesHome, 'profiles', 'alpha')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'config.yaml'), 'skills:\n  disabled:\n    - profile-only\n')

    await withHermesHome(hermesHome, { HERMES_WEB_PLANE: 'chat' }, async ({ toggle }) => {
      const ctx = chatContext({ name: 'bad\nskill', enabled: false })
      await toggle(ctx)
      expect(ctx.status).toBe(500)
      expect(ctx.body).toEqual({ error: 'skill name contains control characters' })
    })

    const profileConfig = YAML.load(await readFile(join(profileDir, 'config.yaml'), 'utf-8')) as any
    expect(profileConfig.skills.disabled).toEqual(['profile-only'])
  })

  it('writes chat-plane pinned skills to the current request profile usage file', async () => {
    const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-webui-pin-profile-'))
    const profileSkills = join(hermesHome, 'profiles', 'alpha', 'skills')
    await mkdir(join(hermesHome, 'skills'), { recursive: true })
    await mkdir(profileSkills, { recursive: true })
    await writeFile(join(hermesHome, 'skills', '.usage.json'), JSON.stringify({ 'root-only': { pinned: true } }))
    await writeFile(join(profileSkills, '.usage.json'), JSON.stringify({ 'profile-only': { pinned: true, use_count: 3 } }))

    await withHermesHome(hermesHome, { HERMES_WEB_PLANE: 'chat', HERMES_BIN: '/usr/bin/false' }, async ({ pin_ }) => {
      const ctx = chatContext({ name: 'sample-skill', pinned: true })
      await pin_(ctx)
      expect(ctx.body).toEqual({ success: true })
    })

    const rootUsage = JSON.parse(await readFile(join(hermesHome, 'skills', '.usage.json'), 'utf-8'))
    const profileUsage = JSON.parse(await readFile(join(profileSkills, '.usage.json'), 'utf-8'))
    expect(rootUsage).toEqual({ 'root-only': { pinned: true } })
    expect(profileUsage).toEqual({
      'profile-only': { pinned: true, use_count: 3 },
      'sample-skill': { patch_count: 0, use_count: 0, view_count: 0, pinned: true },
    })
  })
})
