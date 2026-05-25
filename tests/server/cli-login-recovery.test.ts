import { existsSync } from 'fs'
import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { scryptSync } from 'crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const originalHome = process.env.HERMES_WEB_UI_HOME
let home = ''
let cli: any = null

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'hermes-webui-cli-recovery-'))
  process.env.HERMES_WEB_UI_HOME = home
  cli = await import('../../bin/hermes-web-ui.mjs')
})

afterAll(() => {
  if (originalHome === undefined) delete process.env.HERMES_WEB_UI_HOME
  else process.env.HERMES_WEB_UI_HOME = originalHome
})

describe('CLI login recovery commands', () => {
  it('clears the login lock file from the configured WebUI home', async () => {
    const lockFile = join(home, '.login-lock.json')
    await mkdir(home, { recursive: true })
    await writeFile(lockFile, '{"passwordIpMap":{}}\n')

    const result = cli.clearLoginLocks({ silent: true, checkRunning: false })

    expect(result).toMatchObject({ path: lockFile, removed: true, serverRunning: false })
    expect(existsSync(lockFile)).toBe(false)
  })

  it('cleans a stale server PID file during stop', async () => {
    const pidFile = join(home, 'server.pid')
    await mkdir(home, { recursive: true })
    await writeFile(pidFile, '999999999\n')

    cli.stopDaemon()

    expect(existsSync(pidFile)).toBe(false)
  })

  it('resets the default file-backed password login used by this fork', async () => {
    const result = cli.resetDefaultLogin({ silent: true })

    expect(result).toMatchObject({
      path: join(home, '.credentials'),
      username: 'admin',
      password: '123456',
      action: 'created',
    })

    const credentials = JSON.parse(await readFile(join(home, '.credentials'), 'utf-8'))
    const hash = scryptSync('123456', credentials.salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')
    expect(credentials).toMatchObject({ username: 'admin', password_hash: hash })
  })
})
