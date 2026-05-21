import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { rewriteAssistantMediaDirectives } from '../../packages/server/src/services/hermes/media-directives'

const roots: string[] = []

function makeProfile() {
  const profileDir = mkdtempSync(join(tmpdir(), 'hwui-media-profile-'))
  roots.push(profileDir)
  return profileDir
}

describe('assistant MEDIA directives', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  it('publishes profile home top-level files to workspace Downloads and rewrites the directive', async () => {
    const profileDir = makeProfile()
    const source = join(profileDir, 'home', 'particle_animation.gif')
    await import('fs/promises').then(fs => fs.mkdir(join(profileDir, 'home'), { recursive: true }))
    await import('fs/promises').then(fs => fs.writeFile(source, Buffer.from('GIF89a')))

    const result = await rewriteAssistantMediaDirectives({
      content: `生成完成！\n\nMEDIA:${source}\n\nDone`,
      profileDir,
    })

    expect(result).toContain('MEDIA:/workspace/Downloads/particle_animation.gif')
    expect(result).not.toContain(profileDir)
    const published = join(profileDir, 'workspace', 'Downloads', 'particle_animation.gif')
    expect(existsSync(published)).toBe(true)
    expect(readFileSync(published)).toEqual(Buffer.from('GIF89a'))
  })

  it('does not publish nested hidden home paths', async () => {
    const profileDir = makeProfile()
    const source = join(profileDir, 'home', '.kep-cli', 'secret.png')
    await import('fs/promises').then(fs => fs.mkdir(join(profileDir, 'home', '.kep-cli'), { recursive: true }))
    await import('fs/promises').then(fs => fs.writeFile(source, 'secret'))

    const result = await rewriteAssistantMediaDirectives({
      content: `MEDIA:${source}`,
      profileDir,
    })

    expect(result).toBe(`MEDIA:${source}`)
    expect(existsSync(join(profileDir, 'workspace', 'Downloads', 'secret.png'))).toBe(false)
  })
})
