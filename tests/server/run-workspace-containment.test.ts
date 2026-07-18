import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
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
    // realpathSync so the fixture root is stable across platforms whose tmpdir is
    // itself a symlink (macOS: /var -> /private/var). Prod (Linux) has no symlink
    // here, so this is a no-op there — it must not be what makes the tests pass.
    state.hermesBase = realpathSync(mkdtempSync(join(tmpdir(), 'hermes-ws-')))
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

  it('refuses to run when the workspace root is a symlink out of the profile', async () => {
    // The root is the boundary every other check measures against — if it may point
    // anywhere, it vouches for itself and everything "inside" it passes.
    rmSync(mineWorkspace, { recursive: true, force: true })
    symlinkSync('/etc', mineWorkspace)
    await expect(ensureHermesRunWorkspace('mine')).rejects.toThrow(/is a symlink/)
  })

  it('refuses to run when the workspace root is a symlink to the profile root', async () => {
    // A profile-internal symlink would widen the run to the whole profile (credentials,
    // memory), not just <profile>/workspace — reject it too, not only escaping links.
    const profileRoot = join(state.hermesBase, 'profiles', 'mine')
    rmSync(mineWorkspace, { recursive: true, force: true })
    symlinkSync(profileRoot, mineWorkspace)
    await expect(ensureHermesRunWorkspace('mine')).rejects.toThrow(/is a symlink/)
  })

  it('refuses to run when the workspace root is a dangling symlink (no ENOENT crash)', async () => {
    // Previously the dangling root cleared the realpath check via an ancestor and then
    // ENOENT'd the run at mkdir; now it fails closed with a clear message.
    rmSync(mineWorkspace, { recursive: true, force: true })
    symlinkSync(join(state.hermesBase, 'profiles', 'mine', 'gone-target'), mineWorkspace)
    await expect(ensureHermesRunWorkspace('mine')).rejects.toThrow(/is a symlink/)
  })

  it('refuses to run when the workspace root is not a directory', async () => {
    rmSync(mineWorkspace, { recursive: true, force: true })
    writeFileSync(mineWorkspace, 'not a dir')
    await expect(ensureHermesRunWorkspace('mine')).rejects.toThrow(/not a directory/)
  })

  it('falls back on a dangling symlink instead of crashing the run', async () => {
    const dangling = join(mineWorkspace, 'dangling')
    symlinkSync(join(state.hermesBase, 'gone', 'target'), dangling)
    expect(await ensureHermesRunWorkspace('mine', dangling)).toBe(mineWorkspace)
  })

  it('keeps a compliant stored workspace', async () => {
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
