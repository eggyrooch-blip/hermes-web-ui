import { afterEach, describe, expect, it, vi } from 'vitest'

const { mockExecHermesWithBin } = vi.hoisted(() => ({
  mockExecHermesWithBin: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-process', () => ({
  resolveHermesInvocation: (bin: string) => ({ command: bin, argsPrefix: [] }),
  execHermesWithBin: mockExecHermesWithBin,
  execHermes: vi.fn(),
  spawnHermesWithBin: vi.fn(),
  spawnHermes: vi.fn(),
  resolveHermesBin: () => 'hermes',
}))

afterEach(() => {
  vi.resetModules()
  mockExecHermesWithBin.mockReset()
})

describe('hermes-cli getVersion', () => {
  // A cold `hermes --version` can exceed 5s; the probe must not report an empty version.
  it('gives the version probe a 10s budget', async () => {
    mockExecHermesWithBin.mockResolvedValue({ stdout: 'Hermes Agent v0.21.4\n', stderr: '' })
    const { getVersion } = await import('../../packages/server/src/services/hermes/hermes-cli')

    await expect(getVersion()).resolves.toBe('Hermes Agent v0.21.4')

    const [, args, opts] = mockExecHermesWithBin.mock.calls[0]
    expect(args).toEqual(['--version'])
    expect(opts.timeout).toBe(10000)
  })

  it('returns an empty string when the probe fails', async () => {
    mockExecHermesWithBin.mockRejectedValue(new Error('timed out'))
    const { getVersion } = await import('../../packages/server/src/services/hermes/hermes-cli')

    await expect(getVersion()).resolves.toBe('')
  })
})
