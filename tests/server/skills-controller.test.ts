import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { scanSkillsDir } from '../../packages/server/src/controllers/hermes/skills'

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
})
