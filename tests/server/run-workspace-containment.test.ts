import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const state = vi.hoisted(() => ({ hermesBase: '' }))

// getProfileDir is the only thing workspace.ts needs from the profile layer;
// point it at a real temp tree so symlink containment is exercised for real.
vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: (name: string) =>
    !name || name === 'default' ? state.hermesBase : join(state.hermesBase, 'profiles', name),
}))

const { defaultHermesWorkspace, ensureHermesRunWorkspace } = await import(
  '../../packages/server/src/services/hermes/run-chat/workspace'
)

describe('ensureHermesRunWorkspace containment', () => {
  let mineWorkspace: string
  let theirWorkspace: string

  beforeEach(() => {
    state.hermesBase = mkdtempSync(join(tmpdir(), 'hermes-ws-'))
    mineWorkspace = defaultHermesWorkspace('mine')
    theirWorkspace = defaultHermesWorkspace('theirs')
    mkdirSync(mineWorkspace, { recursive: true })
    mkdirSync(theirWorkspace, { recursive: true })
  })

  afterEach(() => {
    rmSync(state.hermesBase, { recursive: true, force: true })
  })

  it('falls back when a stored workspace points at another profile', async () => {
    // The regression: setWorkspace persists any string, and callers trusted it.
    expect(await ensureHermesRunWorkspace('mine', theirWorkspace)).toBe(mineWorkspace)
  })

  it('falls back when a workspace points outside the hermes tree', async () => {
    expect(await ensureHermesRunWorkspace('mine', '/etc')).toBe(mineWorkspace)
  })

  it('falls back when a symlink inside the workspace escapes it', async () => {
    const escape = join(mineWorkspace, 'escape')
    symlinkSync(state.hermesBase, escape)
    expect(await ensureHermesRunWorkspace('mine', escape)).toBe(mineWorkspace)
  })

  it('falls back on relative traversal', async () => {
    expect(await ensureHermesRunWorkspace('mine', '../../profiles/theirs/workspace')).toBe(mineWorkspace)
  })

  it('never creates an out-of-bounds directory', async () => {
    const victim = join(state.hermesBase, 'credentials', 'nested')
    await ensureHermesRunWorkspace('mine', victim)
    expect(existsSync(victim)).toBe(false)
  })

  it('still rejects traversal when the realpath check is defeated', async () => {
    // Defense in depth: the lexical check must stand on its own. Collapsing the two
    // checks into just the realpath one silently reopens this path.
    const pathModule = await import('../../packages/server/src/services/hermes/hermes-path')
    const spy = vi.spyOn(pathModule, 'isNearestExistingRealPathWithin').mockResolvedValue(true)
    try {
      expect(await ensureHermesRunWorkspace('mine', theirWorkspace)).toBe(mineWorkspace)
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps a compliant stored workspace (the shape all 10 prod rows have)', async () => {
    expect(await ensureHermesRunWorkspace('mine', mineWorkspace)).toBe(mineWorkspace)
  })

  it('allows a subdirectory of the profile workspace and creates it', async () => {
    const sub = join(mineWorkspace, 'project')
    expect(await ensureHermesRunWorkspace('mine', sub)).toBe(sub)
    expect(existsSync(sub)).toBe(true)
  })

  it('resolves a relative workspace against the profile workspace', async () => {
    expect(await ensureHermesRunWorkspace('mine', 'project')).toBe(join(mineWorkspace, 'project'))
  })

  it('defaults to the profile workspace when empty and creates it', async () => {
    for (const empty of [undefined, null, '', '   ']) {
      expect(await ensureHermesRunWorkspace('mine', empty)).toBe(mineWorkspace)
    }
    expect(existsSync(mineWorkspace)).toBe(true)
  })
})
