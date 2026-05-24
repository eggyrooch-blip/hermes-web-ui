import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { mergeExternalCategories, scanExternalSkillsDir, scanSkillsDir } from '../../packages/server/src/controllers/hermes/skills'

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
})
