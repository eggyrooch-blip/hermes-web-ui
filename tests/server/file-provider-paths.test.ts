import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { normalizePlatformPath, validatePath } from '../../packages/server/src/services/hermes/file-provider'
import {
  isNearestExistingRealPathWithin,
  isPathWithin,
  isRealPathWithin,
  nearestExistingRealPath,
  realPathOrResolved,
  relativePathFromBase,
} from '../../packages/server/src/services/hermes/hermes-path'

describe('file provider platform path normalization', () => {
  it('converts MSYS drive paths to Windows absolute paths on Windows', () => {
    expect(normalizePlatformPath('/c/Users/Administrator/Desktop/screenshot.png', 'win32'))
      .toBe('C:\\Users\\Administrator\\Desktop\\screenshot.png')
    expect(normalizePlatformPath('/d/tmp/report.txt', 'win32'))
      .toBe('D:\\tmp\\report.txt')
  })

  it('leaves MSYS-style paths unchanged on non-Windows platforms', () => {
    expect(normalizePlatformPath('/c/Users/Administrator/Desktop/screenshot.png', 'darwin'))
      .toBe('/c/Users/Administrator/Desktop/screenshot.png')
    expect(normalizePlatformPath('/c/Users/Administrator/Desktop/screenshot.png', 'linux'))
      .toBe('/c/Users/Administrator/Desktop/screenshot.png')
  })

  it('leaves normal Windows paths unchanged', () => {
    expect(normalizePlatformPath('C:\\Users\\Administrator\\Desktop\\screenshot.png', 'win32'))
      .toBe('C:\\Users\\Administrator\\Desktop\\screenshot.png')
  })

  it('allows literal double dots inside safe absolute path segments', () => {
    const filePath = join(tmpdir(), 'foo..bar.txt')

    expect(validatePath(filePath)).toBe(resolve(filePath))
  })

  it('rejects parent-directory traversal segments', () => {
    const filePath = `${join(tmpdir(), 'safe')}/../evil.txt`

    expect(() => validatePath(filePath)).toThrow('Invalid file path')
  })
})

describe('Hermes path containment helpers', () => {
  it('does not treat sibling paths with the same prefix as inside the base', () => {
    expect(isPathWithin('/tmp/hermes-profile2/state.db', '/tmp/hermes-profile')).toBe(false)
    expect(isPathWithin('/tmp/hermes-profile/state.db', '/tmp/hermes-profile')).toBe(true)
  })

  it('returns normalized relative paths only for children', () => {
    expect(relativePathFromBase('/tmp/hermes-profile/logs/run.txt', '/tmp/hermes-profile'))
      .toBe('logs/run.txt')
    expect(relativePathFromBase('/tmp/hermes-profile2/logs/run.txt', '/tmp/hermes-profile'))
      .toBeNull()
  })

  it('uses real paths so symlink targets outside the base are not treated as contained', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-realpath-'))
    try {
      const workspace = join(root, 'workspace')
      const external = join(root, 'external')
      mkdirSync(workspace)
      mkdirSync(external)
      writeFileSync(join(external, 'secret.txt'), 'secret', 'utf-8')
      symlinkSync(external, join(workspace, 'escape'), 'dir')

      await expect(realPathOrResolved(join(workspace, 'escape', 'secret.txt')))
        .resolves.toBe(realpathSync(join(external, 'secret.txt')))
      await expect(nearestExistingRealPath(join(workspace, 'escape', 'new.txt')))
        .resolves.toBe(realpathSync(external))
      await expect(isRealPathWithin(join(workspace, 'escape', 'secret.txt'), workspace))
        .resolves.toBe(false)
      await expect(isNearestExistingRealPathWithin(join(workspace, 'escape', 'new.txt'), workspace))
        .resolves.toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('allows missing children whose nearest existing ancestor stays inside the base', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-realpath-'))
    try {
      const workspace = join(root, 'workspace')
      mkdirSync(join(workspace, 'safe'), { recursive: true })

      await expect(realPathOrResolved(join(workspace, 'safe', 'missing.txt')))
        .resolves.toBe(resolve(workspace, 'safe', 'missing.txt'))
      await expect(nearestExistingRealPath(join(workspace, 'safe', 'missing.txt')))
        .resolves.toBe(realpathSync(resolve(workspace, 'safe')))
      await expect(isNearestExistingRealPathWithin(join(workspace, 'safe', 'missing.txt'), workspace))
        .resolves.toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
