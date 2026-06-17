import { existsSync } from 'fs'
import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { scryptSync } from 'crypto'
import { DatabaseSync } from 'node:sqlite'
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

    cli.stopDaemon({ recoverFromPort: false })

    expect(existsSync(pidFile)).toBe(false)
  })

  it('resets the default SQLite-backed password login used by this fork', async () => {
    const result = await cli.resetDefaultLogin({ silent: true })

    const dbFile = join(home, 'hermes-web-ui.db')
    expect(result).toMatchObject({
      path: dbFile,
      username: 'admin',
      password: '123456',
      action: 'created',
    })

    const db = new DatabaseSync(dbFile)
    try {
      const row = db.prepare('SELECT username, password_hash, role, status FROM users WHERE username = ?').get('admin')
      expect(row).toMatchObject({ username: 'admin', role: 'super_admin', status: 'active' })

      const [scheme, salt, storedHash] = String(row.password_hash).split(':')
      expect(scheme).toBe('scrypt')
      const expectedHash = scryptSync('123456', salt, 64).toString('hex')
      expect(storedHash).toBe(expectedHash)
    } finally {
      db.close()
    }
  })
})
