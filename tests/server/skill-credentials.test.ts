import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('skill credential status', () => {
  const roots: string[] = []
  const originalPath = process.env.PATH

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
    vi.resetModules()
    delete process.env.HERMES_HOME
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    delete process.env.HERMES_KEP_AUTH_BIN
    delete process.env.HERMES_BIN
    delete process.env.HERMES_MEEGLE_BIN
    delete process.env.HERMES_MEEGLE_EXTRA_PATHS
    delete process.env.HERMES_MEEGLE_HOST
    delete process.env.HERMES_MEEGLE_STATUS_ALLOW_NPX
    delete process.env.HERMES_MULTITENANCY_DB
    delete process.env.HERMES_WEB_PLANE
    delete process.env.HERMES_WEBUI_CONNECTORS_USE_BROKER
    delete process.env.HERMES_RUN_BROKER_URL
  })

  function makeRoutingDb(rows: Array<{ user_id: string; profile_name: string; open_id: string; active?: number; owner_open_id?: string; provenance?: string; kind?: string | null }>) {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-routing-'))
    roots.push(dir)
    const dbPath = join(dir, 'multitenancy.db')
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`
        CREATE TABLE multitenancy_routing (
          user_id TEXT PRIMARY KEY NOT NULL,
          profile_name TEXT NOT NULL,
          open_id TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          owner_open_id TEXT,
          kind TEXT DEFAULT 'user',
          provenance TEXT DEFAULT 'sync'
        );
      `)
      const stmt = db.prepare('INSERT INTO multitenancy_routing (user_id, profile_name, open_id, active, owner_open_id, kind, provenance) VALUES (?, ?, ?, ?, ?, ?, ?)')
      for (const row of rows) {
        stmt.run(row.user_id, row.profile_name, row.open_id, row.active ?? 1, row.owner_open_id ?? row.open_id, row.kind === undefined ? 'user' : row.kind, row.provenance ?? 'sync')
      }
    } finally {
      db.close()
    }
    return dbPath
  }

  function makeProfile() {
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-'))
    roots.push(profileDir)
    mkdirSync(join(profileDir, 'skills', 'Keep', 'keep-record'), { recursive: true })
    mkdirSync(join(profileDir, 'skills', 'Keep', 'kep-hades-cli'), { recursive: true })
    mkdirSync(join(profileDir, 'skills', 'Keep', 'kep-prd-analysis'), { recursive: true })
    mkdirSync(join(profileDir, 'home', '.keepai'), { recursive: true })
    mkdirSync(join(profileDir, 'home', '.kep-cli', 'keyring-fallback'), { recursive: true })
    mkdirSync(join(profileDir, 'workspace', 'credentials'), { recursive: true })
    writeFileSync(join(profileDir, 'skills', 'Keep', 'keep-record', 'SKILL.md'), [
      '---',
      'name: keep-record',
      '---',
      'Uses get_qrcode and keep_auth_token for profile-local Keep login.',
    ].join('\n'), 'utf-8')
    writeFileSync(join(profileDir, 'skills', 'Keep', 'kep-hades-cli', 'SKILL.md'), [
      '---',
      'name: kep-hades-cli',
      'metadata:',
      '  hermes:',
      '    tags: [kep-cli, hades]',
      '---',
      '<local-home>/.hermes/bin/kep-auth --profile "$KEP_PROFILE" --env online status',
    ].join('\n'), 'utf-8')
    writeFileSync(join(profileDir, 'skills', 'Keep', 'kep-prd-analysis', 'SKILL.md'), [
      '---',
      'name: kep-prd-analysis',
      '---',
      'Clone https://oauth2:${GITLAB_TOKEN}@gitlab.example.com/org/repo.git',
    ].join('\n'), 'utf-8')
    writeFileSync(join(profileDir, 'home', '.keepai', '.env'), 'keep_auth_token=keep-secret-token\nkeep_username=Keep User\n', 'utf-8')
    writeFileSync(join(profileDir, 'home', '.kep-cli', 'keyring-fallback', 'token-key:online:feishu_user_a'), 'kep-secret-token', 'utf-8')
    writeFileSync(join(profileDir, 'workspace', 'credentials', 'gitlab.token'), 'gitlab-secret-token', 'utf-8')
    return profileDir
  }

  it('local fallback still fills action on every row — the type no longer forces it', async () => {
    // action 放宽为可选后，编译器不再逼着这里填。但本地实现是 broker 不可用时的兜底，
    // 它的每一行都代表一个员工能操作的连接器：漏填会让那张卡在降级态永远点不动，
    // 而且没有任何类型错误提醒。可选性是给 broker 表达"无操作"用的，不是给这里偷懒用的。
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = makeProfile()

    const result = await listSkillCredentialStatuses({
      profileName: 'feishu_user_a',
      profileDir,
      user: { openid: 'ou_user_a', profile: 'feishu_user_a', role: 'user', name: '孙可' },
      larkStatus: null,
    } as any)

    expect(result.credentials.length).toBeGreaterThan(0)
    for (const c of result.credentials) {
      expect(c.action, `${c.id} 缺 action —— 本地兜底的每一行都必须可操作`).toBeDefined()
      expect(c.action!.label, `${c.id} 的 action.label 为空`).toBeTruthy()
    }
  })

  it('summarizes first-party skill credentials without returning raw secrets', async () => {
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = makeProfile()
    const kepAuth = join(profileDir, 'kep-auth')
    writeFileSync(kepAuth, '#!/bin/sh\necho "env: online"\necho "state: logged in"\n', 'utf-8')
    chmodSync(kepAuth, 0o755)
    process.env.HERMES_KEP_AUTH_BIN = kepAuth

    const result = await listSkillCredentialStatuses({
      profileName: 'feishu_user_a',
      profileDir,
      user: {
        openid: 'ou_user_a',
        profile: 'feishu_user_a',
        role: 'user',
        name: '孙可',
      },
      larkStatus: {
        status: 'valid',
        lark_cli: {
          available: true,
          default_identity: 'user',
        },
      },
    })

    expect(result.profile_name).toBe('feishu_user_a')
    expect(result.credentials.map(item => item.id)).toEqual([
      'lark-cli',
      'feishu-project',
      'keep-record',
      'kep-cli-online',
      'kep-cli-pre',
      'gitlab',
    ])
    expect(result.credentials.find(item => item.id === 'lark-cli')).toMatchObject({
      status: 'authenticated',
      account_hint: '孙可',
      default_identity: 'user',
    })
    expect(result.credentials.find(item => item.id === 'keep-record')).toMatchObject({
      status: 'unknown',
      installed: true,
      account_hint: 'Keep User',
    })
    expect(result.credentials.find(item => item.id === 'kep-cli-online')).toMatchObject({
      status: 'authenticated',
      installed: true,
    })
    expect(result.credentials.find(item => item.id === 'gitlab')).toMatchObject({
      status: 'configured',
      installed: true,
    })

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('keep-secret-token')
    expect(serialized).not.toContain('kep-secret-token')
    expect(serialized).not.toContain('gitlab-secret-token')
  })

  it('reports Feishu Project CLI auth status without exposing token material or MCP wording', async () => {
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-meegle-cli-'))
    roots.push(profileDir)
    const meegle = join(profileDir, 'fake-meegle')
    writeFileSync(meegle, [
      '#!/bin/sh',
      'if [ "$1" = "--profile" ]; then',
      '  test "$2" = "hermes_feishu_user_a" || exit 10',
      '  shift 2',
      'fi',
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
      '  echo \'{"authenticated":true,"host":"project.feishu.cn","source":"token_store","expires_in_minutes":60,"account":"Meegle User"}\'',
      '  exit 0',
      'fi',
      'exit 9',
    ].join('\n'), 'utf-8')
    chmodSync(meegle, 0o755)
    process.env.HERMES_MEEGLE_BIN = meegle

    const result = await listSkillCredentialStatuses({
      profileName: 'feishu_user_a',
      profileDir,
    })

    expect(result.credentials.find(item => item.id === 'feishu-project')).toMatchObject({
      id: 'feishu-project',
      title: '飞书项目',
      provider: 'feishu-project',
      installed: true,
      status: 'authenticated',
      account_hint: 'Meegle User',
      action: {
        kind: 'oauth_url',
        label: '重新授权',
      },
    })
    expect(JSON.stringify(result)).not.toContain('MCP')
    expect(JSON.stringify(result)).not.toContain('access_token')
    expect(JSON.stringify(result)).not.toContain('refresh_token')
  })

  it('treats Feishu Project CLI as installable through the official npm package when npx is available', async () => {
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-meegle-npx-'))
    roots.push(profileDir)
    const binDir = join(profileDir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const npx = join(binDir, 'npx')
    const invoked = join(profileDir, 'npx-status-invoked.txt')
    writeFileSync(npx, [
      '#!/bin/sh',
      `touch "${invoked}"`,
      'exit 9',
    ].join('\n'), 'utf-8')
    chmodSync(npx, 0o755)
    process.env.PATH = binDir
    process.env.HERMES_MEEGLE_STATUS_ALLOW_NPX = '1'

    const result = await listSkillCredentialStatuses({
      profileName: 'feishu_user_a',
      profileDir,
    })

    expect(result.credentials.find(item => item.id === 'feishu-project')).toMatchObject({
      installed: true,
      status: 'needs_auth',
      detail: '飞书项目需要授权后才能查询和更新工作项。',
    })
    expect(existsSync(invoked)).toBe(false)
  })

  it('reads Feishu Project auth status through npx when the global meegle command is absent', async () => {
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-meegle-npx-status-'))
    roots.push(profileDir)
    const binDir = join(profileDir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const npx = join(binDir, 'npx')
    const invoked = join(profileDir, 'npx-auth-status-args.txt')
    writeFileSync(npx, [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > "${invoked}"`,
      'test "$1" = "-y" || exit 12',
      'test "$2" = "@lark-project/meegle" || exit 11',
      'shift 2',
      'if [ "$1" = "--profile" ]; then',
      '  test "$2" = "hermes_feishu_user_a" || exit 10',
      '  shift 2',
      'fi',
      'if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "$3" = "--format" ] && [ "$4" = "json" ]; then',
      '  echo \'{"authenticated":true,"host":"project.feishu.cn","expires_in_minutes":110,"access_token":"secret-token"}\'',
      '  exit 0',
      'fi',
      'exit 9',
    ].join('\n'), 'utf-8')
    chmodSync(npx, 0o755)
    process.env.PATH = binDir
    process.env.HERMES_MEEGLE_STATUS_ALLOW_NPX = '1'

    const result = await listSkillCredentialStatuses({
      profileName: 'feishu_user_a',
      profileDir,
    })

    expect(result.credentials.find(item => item.id === 'feishu-project')).toMatchObject({
      installed: true,
      status: 'authenticated',
      account_hint: 'project.feishu.cn',
      action: {
        label: '重新授权',
      },
    })
    expect(readFileSync(invoked, 'utf-8')).toContain('--profile\nhermes_feishu_user_a')
    expect(JSON.stringify(result)).not.toContain('secret-token')
    expect(JSON.stringify(result)).not.toContain('access_token')
    expect(JSON.stringify(result)).not.toContain('refresh_token')
    expect(JSON.stringify(result)).not.toMatch(/keychain/i)
  })

  it('degrades Feishu Project npx status failures to needs_auth without exposing stderr', async () => {
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-meegle-npx-status-fail-'))
    roots.push(profileDir)
    const binDir = join(profileDir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const npx = join(binDir, 'npx')
    const invoked = join(profileDir, 'npx-auth-status-fail-args.txt')
    writeFileSync(npx, [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > "${invoked}"`,
      'echo "auth status failed: refresh_token=secret-refresh keychain=/Users/example/Library/Keychains/login.keychain-db" >&2',
      'exit 1',
    ].join('\n'), 'utf-8')
    chmodSync(npx, 0o755)
    process.env.PATH = binDir
    process.env.HERMES_MEEGLE_STATUS_ALLOW_NPX = '1'

    const result = await listSkillCredentialStatuses({
      profileName: 'feishu_user_a',
      profileDir,
    })

    expect(result.credentials.find(item => item.id === 'feishu-project')).toMatchObject({
      installed: true,
      status: 'needs_auth',
      account_hint: undefined,
      action: {
        label: '授权',
      },
    })
    expect(readFileSync(invoked, 'utf-8')).toContain('--profile\nhermes_feishu_user_a')
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('secret-refresh')
    expect(serialized).not.toContain('refresh_token')
    expect(serialized).not.toMatch(/keychain/i)
  })

  it('finds the official npm package launcher when launchd starts WebUI with a narrow PATH', async () => {
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-meegle-launchd-'))
    roots.push(profileDir)
    const launchdBin = join(profileDir, 'launchd-bin')
    const homebrewBin = join(profileDir, 'homebrew-bin')
    mkdirSync(launchdBin, { recursive: true })
    mkdirSync(homebrewBin, { recursive: true })
    const npx = join(homebrewBin, 'npx')
    writeFileSync(npx, '#!/bin/sh\nexit 9\n', 'utf-8')
    chmodSync(npx, 0o755)
    process.env.PATH = launchdBin
    process.env.HERMES_MEEGLE_EXTRA_PATHS = homebrewBin

    const result = await listSkillCredentialStatuses({
      profileName: 'feishu_user_a',
      profileDir,
    })

    expect(result.credentials.find(item => item.id === 'feishu-project')).toMatchObject({
      installed: true,
      status: 'needs_auth',
    })
  })

  it.each([true, false])('waits for complete device-code JSON before selecting its authorization URL (complete=%s)', async (includeComplete) => {
    const { startFeishuProjectAuth } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-meegle-json-url-'))
    roots.push(profileDir)
    const meegle = join(profileDir, 'fake-meegle')
    const bare = 'https://project.feishu.cn/oauth/device'
    const complete = `${bare}?user_code=TEST-FIXTURE`
    const payload = JSON.stringify({
      client_id: 'fixture-client', device_code: 'fixture-device', expires_in: 600,
      interval: 5, user_code: 'TEST-FIXTURE', verification_uri: bare,
      ...(includeComplete ? { verification_uri_complete: complete } : {}),
    })
    // First chunk already contains a complete bare URI; the final JSON field
    // and closing brace arrive later, as with the real Meegle CLI stdout.
    const split = payload.indexOf(bare) + bare.length + 1
    writeFileSync(meegle, [
      '#!/bin/sh',
      'case "$*" in *"auth login"*) ;; *) exit 0 ;; esac',
      `printf '%s' '${payload.slice(0, split)}'`,
      'sleep 0.15',
      `printf '%s\\n' '${payload.slice(split)}'`,
    ].join('\n'), 'utf-8')
    chmodSync(meegle, 0o755)
    process.env.HERMES_MEEGLE_BIN = meegle
    const result = await startFeishuProjectAuth({ id: 'feishu-project', profileName: 'feishu_user_a', profileDir })
    expect(result.verification_uri).toBe(includeComplete ? complete : bare)
  })

  it('starts Feishu Project CLI device-code auth without writing MCP config', async () => {
    const { startFeishuProjectAuth } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-meegle-start-'))
    roots.push(profileDir)
    writeFileSync(join(profileDir, 'config.yaml'), [
      'model:',
      '  default: claude',
      '',
    ].join('\n'), 'utf-8')
    const meegle = join(profileDir, 'fake-meegle')
    writeFileSync(meegle, [
      '#!/bin/sh',
      'if [ "$1" = "--profile" ]; then',
      '  test "$2" = "hermes_feishu_user_a" || exit 10',
      '  shift 2',
      'fi',
      'if [ "$1" = "config" ] && [ "$2" = "set" ] && [ "$3" = "host" ]; then',
      '  test "$4" = "project.feishu.cn" || exit 8',
      '  exit 0',
      'fi',
      'if [ "$1" = "auth" ] && [ "$2" = "login" ]; then',
      '  test "$3" = "--device-code" || exit 7',
      '  test "$4" = "--host" || exit 6',
      '  test "$5" = "project.feishu.cn" || exit 5',
      `  echo 'Open "https://project.feishu.cn/oauth/device?user_code=ABCD-1234".' >&2`,
      '  sleep 0.2',
      '  exit 0',
      'fi',
      'exit 9',
    ].join('\n'), 'utf-8')
    chmodSync(meegle, 0o755)
    process.env.HERMES_MEEGLE_BIN = meegle

    const result = await startFeishuProjectAuth({
      id: 'feishu-project',
      profileName: 'feishu_user_a',
      profileDir,
    })

    expect(result).toMatchObject({
      id: 'feishu-project',
      status: 'auth_pending',
      verification_uri: 'https://project.feishu.cn/oauth/device?user_code=ABCD-1234',
      action: {
        kind: 'oauth_url',
        label: '授权飞书项目',
      },
    })
    const config = readFileSync(join(profileDir, 'config.yaml'), 'utf-8')
    expect(config).not.toContain('FeishuProjectMcp')
    expect(config).not.toContain('mcp_server')
    expect(JSON.stringify(result)).not.toContain('access_token')
    expect(JSON.stringify(result)).not.toContain('refresh_token')
  })

  it('starts Feishu Project auth only in the selected profile HOME', async () => {
    const { listSkillCredentialStatuses, startFeishuProjectAuth } = await import('../../packages/server/src/services/hermes/skill-credentials')
    for (const profileName of ['alice', 'bob']) {
      const profileDir = mkdtempSync(join(tmpdir(), `hermes-skill-credentials-meegle-${profileName}-`))
      roots.push(profileDir)
      const profileHome = join(profileDir, 'home')
      mkdirSync(profileHome, { recursive: true })
      const meegle = join(profileDir, 'fake-meegle')
      const invoked = join(profileDir, 'meegle-profile-home-args.txt')
      writeFileSync(meegle, [
        '#!/bin/sh',
        `test "$HOME" = "${profileHome}" || { echo "bad HOME=$HOME" >&2; exit 12; }`,
        `printf '%s\\n' "$@" >> "${invoked}"`,
        'profile=""',
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "--profile" ]; then profile="$2"; shift 2; continue; fi',
        '  break',
        'done',
        `test "$profile" = "hermes_${profileName}" || { echo "bad profile=$profile" >&2; exit 11; }`,
        'if [ "$1" = "config" ]; then exit 0; fi',
        'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
        '  test -f "$HOME/.meegle/authenticated" && echo \'{"authenticated":true,"access_token":"secret-token"}\' || echo \'{"authenticated":false}\'',
        '  exit 0',
        'fi',
        'if [ "$1" = "auth" ] && [ "$2" = "login" ]; then',
        '  mkdir -p "$HOME/.meegle" && touch "$HOME/.meegle/authenticated"',
        '  echo "Open https://project.feishu.cn/oauth/device?user_code=KEYCHAIN-1234"',
        '  sleep 0.2',
        '  exit 0',
        'fi',
        'exit 9',
      ].join('\n'), 'utf-8')
      chmodSync(meegle, 0o755)
      process.env.HERMES_MEEGLE_BIN = meegle
      process.env.HOME = join(profileDir, 'service-home')

      const result = await startFeishuProjectAuth({ id: 'feishu-project', profileName, profileDir })
      const status = await listSkillCredentialStatuses({ profileName, profileDir })

      expect(result.verification_uri).toBe('https://project.feishu.cn/oauth/device?user_code=KEYCHAIN-1234')
      expect(readFileSync(invoked, 'utf-8')).toContain(`--profile\nhermes_${profileName}`)
      expect(status.credentials.find(item => item.id === 'feishu-project')?.status).toBe('authenticated')
      expect(JSON.stringify(status)).not.toContain('secret-token')
    }
  })

  it('starts Feishu Project auth through npx when no global meegle command is installed', async () => {
    const { startFeishuProjectAuth } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-meegle-npx-start-'))
    roots.push(profileDir)
    const binDir = join(profileDir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const npx = join(binDir, 'npx')
    const invoked = join(profileDir, 'npx-start-args.txt')
    writeFileSync(npx, [
      '#!/bin/sh',
      `printf '%s\\n' "$@" >> "${invoked}"`,
      'shift 2',
      'if [ "$1" = "--profile" ]; then',
      '  test "$2" = "hermes_feishu_user_a" || exit 10',
      '  shift 2',
      'fi',
      'if [ "$1" = "config" ] && [ "$2" = "set" ] && [ "$3" = "host" ] && [ "$4" = "project.feishu.cn" ]; then',
      '  exit 0',
      'fi',
      'if [ "$1" = "auth" ] && [ "$2" = "login" ] && [ "$3" = "--device-code" ]; then',
      '  echo "Open https://project.feishu.cn/oauth/device?user_code=NPX-1234"',
      '  sleep 0.2',
      '  exit 0',
      'fi',
      'exit 9',
    ].join('\n'), 'utf-8')
    chmodSync(npx, 0o755)
    process.env.PATH = binDir

    const result = await startFeishuProjectAuth({
      id: 'feishu-project',
      profileName: 'feishu_user_a',
      profileDir,
    })

    expect(result.verification_uri).toBe('https://project.feishu.cn/oauth/device?user_code=NPX-1234')
    expect(readFileSync(invoked, 'utf-8')).toContain('@lark-project/meegle')
  })

  it('starts Feishu Project auth through the common-bin npx fallback under a narrow launchd PATH', async () => {
    const { startFeishuProjectAuth } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-meegle-launchd-start-'))
    roots.push(profileDir)
    const launchdBin = join(profileDir, 'launchd-bin')
    const homebrewBin = join(profileDir, 'homebrew-bin')
    mkdirSync(launchdBin, { recursive: true })
    mkdirSync(homebrewBin, { recursive: true })
    const npx = join(homebrewBin, 'npx')
    const invoked = join(profileDir, 'common-npx-start-args.txt')
    writeFileSync(npx, [
      '#!/bin/sh',
      `printf '%s\\n' "$@" >> "${invoked}"`,
      'shift 2',
      'if [ "$1" = "--profile" ]; then',
      '  test "$2" = "hermes_feishu_user_a" || exit 10',
      '  shift 2',
      'fi',
      'if [ "$1" = "config" ]; then exit 0; fi',
      'if [ "$1" = "auth" ] && [ "$2" = "login" ]; then',
      '  echo "Open https://project.feishu.cn/oauth/device?user_code=BREW-1234"',
      '  sleep 0.2',
      '  exit 0',
      'fi',
      'exit 9',
    ].join('\n'), 'utf-8')
    chmodSync(npx, 0o755)
    process.env.PATH = launchdBin
    process.env.HERMES_MEEGLE_EXTRA_PATHS = homebrewBin

    const result = await startFeishuProjectAuth({
      id: 'feishu-project',
      profileName: 'feishu_user_a',
      profileDir,
    })

    expect(result.verification_uri).toBe('https://project.feishu.cn/oauth/device?user_code=BREW-1234')
    expect(readFileSync(invoked, 'utf-8')).toContain('@lark-project/meegle')
  })

  it('adds the common-bin directory to Meegle child PATH so npx can find node under launchd', async () => {
    const { startFeishuProjectAuth } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-meegle-node-path-'))
    roots.push(profileDir)
    const launchdBin = join(profileDir, 'launchd-bin')
    const homebrewBin = join(profileDir, 'homebrew-bin')
    mkdirSync(launchdBin, { recursive: true })
    mkdirSync(homebrewBin, { recursive: true })

    const node = join(homebrewBin, 'node')
    writeFileSync(node, [
      '#!/bin/sh',
      `exec ${JSON.stringify(process.execPath)} "$@"`,
    ].join('\n'), 'utf-8')
    chmodSync(node, 0o755)

    const npx = join(homebrewBin, 'npx')
    const invoked = join(profileDir, 'node-path-npx-start-args.txt')
    writeFileSync(npx, [
      '#!/usr/bin/env node',
      'const fs = require("fs");',
      `const invoked = ${JSON.stringify(invoked)};`,
      'const args = process.argv.slice(2);',
      'fs.appendFileSync(invoked, `PATH=${process.env.PATH}\\n${args.join("\\n")}\\n---\\n`);',
      'const packageIndex = args.indexOf("@lark-project/meegle");',
      'const command = packageIndex >= 0 ? args.slice(packageIndex + 1) : args;',
      'if (command[0] !== "--profile" || command[1] !== "hermes_feishu_user_a") process.exit(10);',
      'const profiledCommand = command.slice(2);',
      'if (profiledCommand[0] === "config" && profiledCommand[1] === "set" && profiledCommand[2] === "host") process.exit(0);',
      'if (profiledCommand[0] === "auth" && profiledCommand[1] === "login" && profiledCommand[2] === "--device-code") {',
      '  console.log("Open https://project.feishu.cn/oauth/device?user_code=NODEPATH-1234");',
      '  setTimeout(() => process.exit(0), 200);',
      '} else {',
      '  process.exit(9);',
      '}',
    ].join('\n'), 'utf-8')
    chmodSync(npx, 0o755)

    process.env.PATH = launchdBin
    process.env.HERMES_MEEGLE_EXTRA_PATHS = homebrewBin

    const result = await startFeishuProjectAuth({
      id: 'feishu-project',
      profileName: 'feishu_user_a',
      profileDir,
    })

    expect(result.verification_uri).toBe('https://project.feishu.cn/oauth/device?user_code=NODEPATH-1234')
    expect(readFileSync(invoked, 'utf-8')).toContain(`PATH=${launchdBin}`)
    expect(readFileSync(invoked, 'utf-8')).toContain(homebrewBin)
  })

  it('returns a readable error when Feishu Project CLI cannot be spawned', async () => {
    const { startFeishuProjectAuth } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-meegle-missing-bin-'))
    roots.push(profileDir)
    process.env.HERMES_MEEGLE_BIN = join(profileDir, 'missing-meegle-bin')
    process.env.PATH = profileDir

    await expect(startFeishuProjectAuth({
      id: 'feishu-project',
      profileName: 'feishu_user_a',
      profileDir,
    })).rejects.toMatchObject({
      status: 502,
      message: 'Meegle CLI command was not found. Install @lark-project/meegle or configure HERMES_MEEGLE_BIN for WebUI.',
    })
  })

  it('detects credential adapters from installed skill metadata instead of fixed folders', async () => {
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-adaptive-'))
    roots.push(profileDir)
    mkdirSync(join(profileDir, 'skills', 'org', 'health-log'), { recursive: true })
    mkdirSync(join(profileDir, 'skills', 'ads', 'hades'), { recursive: true })
    mkdirSync(join(profileDir, 'skills', 'product', 'prd-helper'), { recursive: true })
    mkdirSync(join(profileDir, 'home', '.keepai'), { recursive: true })
    mkdirSync(join(profileDir, 'workspace', 'credentials'), { recursive: true })
    writeFileSync(join(profileDir, 'skills', 'org', 'health-log', 'SKILL.md'), [
      '---',
      'name: keep-record',
      '---',
      'Auth uses get_qrcode and keep_auth_token.',
    ].join('\n'), 'utf-8')
    writeFileSync(join(profileDir, 'skills', 'ads', 'hades', 'SKILL.md'), [
      '---',
      'name: hades-helper',
      'metadata:',
      '  hermes:',
      '    tags: [kep-cli]',
      '---',
      'Run kep-auth --profile "$KEP_PROFILE" --env online status before queries.',
    ].join('\n'), 'utf-8')
    writeFileSync(join(profileDir, 'skills', 'product', 'prd-helper', 'SKILL.md'), [
      '---',
      'name: product-prd-helper',
      '---',
      'Use GITLAB_TOKEN to read gitlab.example.com repositories.',
    ].join('\n'), 'utf-8')
    writeFileSync(join(profileDir, 'home', '.keepai', '.env'), 'keep_auth_token=keep-secret-token\n', 'utf-8')
    writeFileSync(join(profileDir, 'workspace', 'credentials', 'gitlab.token'), 'gitlab-secret-token', 'utf-8')
    const kepAuth = join(profileDir, 'kep-auth')
    writeFileSync(kepAuth, '#!/bin/sh\necho "state: valid"\n', 'utf-8')
    chmodSync(kepAuth, 0o755)
    process.env.HERMES_KEP_AUTH_BIN = kepAuth

    const result = await listSkillCredentialStatuses({
      profileName: 'adaptive_profile',
      profileDir,
    })

    expect(result.credentials.find(item => item.id === 'keep-record')).toMatchObject({
      installed: true,
      status: 'unknown',
    })
    expect(result.credentials.find(item => item.id === 'kep-cli-online')).toMatchObject({
      installed: true,
      status: 'authenticated',
    })
    expect(result.credentials.find(item => item.id === 'gitlab')).toMatchObject({
      installed: true,
      status: 'configured',
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('keep-secret-token')
    expect(serialized).not.toContain('gitlab-secret-token')
  })

  it('classifies internal-system skill requirements without requiring upstream metadata changes', async () => {
    const { detectSkillCredentialRequirements } = await import('../../packages/server/src/services/hermes/skill-credentials')

    expect(detectSkillCredentialRequirements({
      name: 'feishu-wiki-reader',
      tags: [],
      text: 'Use lark_cli to read wiki:wiki:readonly documents from open.feishu.cn.',
    })).toEqual(['lark-cli'])

    expect(detectSkillCredentialRequirements({
      name: 'keep-login-skill',
      tags: [],
      text: 'Fetch proxy.cms.example.com APIs with kep-auth and KEP_PROFILE.',
      source: 'hub',
    })).toEqual(['kep-cli'])

    expect(detectSkillCredentialRequirements({
      name: 'daily-breaking',
      tags: [],
      text: 'Prepare the daily digest from the current workspace.',
      source: 'hub',
    })).toEqual(['kep-cli'])

    expect(detectSkillCredentialRequirements({
      name: 'meegle',
      tags: [],
      text: '飞书项目（Meego/Meegle）操作工具。Use when user needs to work with Feishu/Lark Meego project management, including querying work items, requirements, tasks, bugs, schedules, views and todos.',
    })).toEqual(['feishu-project'])

    expect(detectSkillCredentialRequirements({
      name: 'kep-prd-analysis',
      tags: ['aidock'],
      text: '分析 PRD 需求、任务、工作项和排期，并调用 proxy.cms.example.com。',
      source: 'hub',
    })).toEqual(['kep-cli'])

    expect(detectSkillCredentialRequirements({
      name: 'lark-base',
      tags: [],
      text: 'Use lark base and open.feishu.cn to organize requirement tables and schedules.',
    })).toEqual(['lark-cli'])

    expect(detectSkillCredentialRequirements({
      name: 'another-digest',
      tags: [],
      text: 'Prepare the digest from the current workspace.',
      source: 'aidock-skillhub',
    })).toEqual(['kep-cli'])

    expect(detectSkillCredentialRequirements({
      name: 'mixed-internal-report',
      tags: ['aidock'],
      text: 'Download SkillHub data from ark.example.com/aidock-cms, then write the result to a Feishu docx.',
    })).toEqual(['lark-cli', 'kep-cli'])

    expect(detectSkillCredentialRequirements({
      name: 'local-docx-exporter',
      tags: [],
      text: 'Create a local docx file in the workspace.',
    })).toEqual([])
  })

  it('shows which installed skills require lark-cli and kep-cli credentials', async () => {
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-required-by-'))
    roots.push(profileDir)
    mkdirSync(join(profileDir, 'skills', 'internal', 'wiki-helper'), { recursive: true })
    mkdirSync(join(profileDir, 'skills', 'internal', 'aidock-helper'), { recursive: true })
    mkdirSync(join(profileDir, 'skills', 'internal', 'meegle'), { recursive: true })
    writeFileSync(join(profileDir, 'skills', 'internal', 'wiki-helper', 'SKILL.md'), [
      '---',
      'name: wiki-helper',
      '---',
      'Use lark_cli to read Feishu wiki pages and summarize 需求排期 tables.',
    ].join('\n'), 'utf-8')
    writeFileSync(join(profileDir, 'skills', 'internal', 'aidock-helper', 'SKILL.md'), [
      '---',
      'name: aidock-helper',
      'metadata:',
      '  hermes:',
      '    tags: [aidock]',
      '---',
      'Call proxy.cms.example.com through kep-auth to analyze PRD 需求、任务、工作项 and 排期.',
    ].join('\n'), 'utf-8')
    writeFileSync(join(profileDir, 'skills', 'internal', 'meegle', 'SKILL.md'), [
      '---',
      'name: meegle',
      '---',
      '飞书项目（Meego/Meegle）操作工具，Use with project.feishu.cn URLs.',
    ].join('\n'), 'utf-8')
    const kepAuth = join(profileDir, 'kep-auth')
    writeFileSync(kepAuth, '#!/bin/sh\necho "state: valid"\n', 'utf-8')
    chmodSync(kepAuth, 0o755)
    process.env.HERMES_KEP_AUTH_BIN = kepAuth

    const result = await listSkillCredentialStatuses({
      profileName: 'feishu_sunke',
      profileDir,
      larkStatus: {
        status: 'valid',
        lark_cli: { available: true, default_identity: 'user' },
      },
    })

    expect(result.credentials.find(item => item.id === 'lark-cli')?.required_by).toEqual(['wiki-helper'])
    expect(result.credentials.find(item => item.id === 'kep-cli-online')).toMatchObject({
      installed: true,
      status: 'authenticated',
      required_by: ['aidock-helper'],
    })
    expect(result.credentials.find(item => item.id === 'feishu-project')?.required_by).toEqual(['meegle'])
  })

  it('detects kep-cli-backed skills installed as multitenancy directory symlinks', async () => {
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-symlink-home-'))
    roots.push(hermesHome)
    const profileDir = join(hermesHome, 'profiles', 'user_a')
    const sharedSkillDir = join(hermesHome, 'skills', 'Keep', 'kep-hades-cli')
    mkdirSync(sharedSkillDir, { recursive: true })
    mkdirSync(join(profileDir, 'skills', 'Keep'), { recursive: true })
    writeFileSync(join(sharedSkillDir, 'SKILL.md'), [
      '---',
      'name: kep-hades-cli',
      'metadata:',
      '  hermes:',
      '    tags: [kep-cli, hades]',
      '---',
      'Run kep-auth --profile "$KEP_PROFILE" --env online status before queries.',
    ].join('\n'), 'utf-8')
    symlinkSync(sharedSkillDir, join(profileDir, 'skills', 'Keep', 'kep-hades-cli'), 'dir')

    const result = await listSkillCredentialStatuses({
      profileName: 'user_a',
      profileDir,
    })

    expect(result.credentials.find(item => item.id === 'kep-cli-online')).toMatchObject({
      installed: true,
      status: 'needs_auth',
    })
    expect(result.credentials.find(item => item.id === 'kep-cli-online')?.detail).not.toBe('No kep-cli online backed skill is installed for this profile.')
  })

  it('treats SkillHub-installed skills as kep-cli-backed even without text markers', async () => {
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-hub-source-'))
    roots.push(profileDir)
    mkdirSync(join(profileDir, 'skills', 'daily-breaking'), { recursive: true })
    writeFileSync(join(profileDir, 'skills', 'daily-breaking', 'SKILL.md'), [
      '---',
      'name: daily-breaking',
      '---',
      'Prepare the daily digest from the current workspace.',
    ].join('\n'), 'utf-8')
    writeFileSync(join(profileDir, 'skills', '.hermes-skillhub.json'), JSON.stringify({
      installed: {
        'daily-breaking': {
          source: 'aidock-skillhub',
          profile: 'feishu_sunke',
        },
      },
    }), 'utf-8')
    const kepAuth = join(profileDir, 'kep-auth')
    writeFileSync(kepAuth, '#!/bin/sh\necho "state: valid"\n', 'utf-8')
    chmodSync(kepAuth, 0o755)
    process.env.HERMES_KEP_AUTH_BIN = kepAuth

    const result = await listSkillCredentialStatuses({
      profileName: 'feishu_sunke',
      profileDir,
    })

    expect(result.credentials.find(item => item.id === 'kep-cli-online')).toMatchObject({
      installed: true,
      status: 'authenticated',
      required_by: ['daily-breaking'],
    })
  })

  it('reports needs_auth for SkillHub installs without a concrete kep-cli skill when kep-auth is not logged in', async () => {
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-hub-needs-auth-'))
    roots.push(profileDir)
    mkdirSync(join(profileDir, 'skills', 'daily-breaking'), { recursive: true })
    writeFileSync(join(profileDir, 'skills', 'daily-breaking', 'SKILL.md'), [
      '---',
      'name: daily-breaking',
      '---',
      'Prepare the daily digest from the current workspace.',
    ].join('\n'), 'utf-8')
    writeFileSync(join(profileDir, 'skills', '.hermes-skillhub.json'), JSON.stringify({
      installed: { 'daily-breaking': { source: 'aidock-skillhub' } },
    }), 'utf-8')
    const kepAuth = join(profileDir, 'kep-auth')
    writeFileSync(kepAuth, '#!/bin/sh\necho "state: not logged in"\n', 'utf-8')
    chmodSync(kepAuth, 0o755)
    process.env.HERMES_KEP_AUTH_BIN = kepAuth

    const result = await listSkillCredentialStatuses({
      profileName: 'feishu_sunke',
      profileDir,
    })

    expect(result.credentials.find(item => item.id === 'kep-cli-online')).toMatchObject({
      installed: true,
      status: 'needs_auth',
      required_by: ['daily-breaking'],
      detail: 'kep-auth status reports this profile is not logged in to online.',
    })
  })

  it('checks kep-auth live status instead of treating keyring material as connected', async () => {
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = makeProfile()
    const kepAuth = join(profileDir, 'kep-auth')
    writeFileSync(kepAuth, '#!/bin/sh\necho "env: online"\necho "state: not logged in"\n', 'utf-8')
    chmodSync(kepAuth, 0o755)
    process.env.HERMES_KEP_AUTH_BIN = kepAuth

    const result = await listSkillCredentialStatuses({
      profileName: 'feishu_user_a',
      profileDir,
    })

    expect(result.credentials.find(item => item.id === 'kep-cli-online')).toMatchObject({
      status: 'needs_auth',
      detail: 'kep-auth status reports this profile is not logged in to online.',
    })
    expect(JSON.stringify(result)).not.toContain('kep-secret-token')
  })

  it('treats kep-auth state valid as an authenticated live login', async () => {
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = makeProfile()
    const kepAuth = join(profileDir, 'kep-auth')
    writeFileSync(kepAuth, [
      '#!/bin/sh',
      `test "$HERMES_HOME" = "${profileDir}" || { echo "bad HERMES_HOME=$HERMES_HOME"; exit 9; }`,
      'test "$KEP_PROFILE" = "feishu_user_a" || { echo "bad KEP_PROFILE=$KEP_PROFILE"; exit 9; }',
      `test "$HOME" = "${join(profileDir, 'home')}" || { echo "bad HOME=$HOME"; exit 9; }`,
      'echo "env: online"',
      'echo "state: valid"',
      'echo "operator: user_a"',
    ].join('\n'), 'utf-8')
    chmodSync(kepAuth, 0o755)
    process.env.HERMES_KEP_AUTH_BIN = kepAuth

    const result = await listSkillCredentialStatuses({
      profileName: 'feishu_user_a',
      profileDir,
    })

    expect(result.credentials.find(item => item.id === 'kep-cli-online')).toMatchObject({
      status: 'authenticated',
      detail: 'kep-auth status verified this profile online login.',
      account_hint: 'user_a',
    })
    expect(JSON.stringify(result)).not.toContain('user-a@example.com')
  })

  it('checks kep-cli pre status when a profile skill declares --env pre', async () => {
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = makeProfile()
    writeFileSync(join(profileDir, 'skills', 'Keep', 'kep-hades-cli', 'SKILL.md'), [
      '---',
      'name: kep-hades-cli',
      'metadata:',
      '  hermes:',
      '    tags: [kep-cli, hades]',
      '---',
      '<local-home>/.hermes/bin/kep-auth --profile "$KEP_PROFILE" --env pre status',
    ].join('\n'), 'utf-8')
    const kepAuth = join(profileDir, 'kep-auth')
    writeFileSync(kepAuth, [
      '#!/bin/sh',
      'if [ "$4" = "pre" ]; then',
      '  echo "env: pre"',
      '  echo "state: valid"',
      '  echo "operator: pre_user"',
      '  exit 0',
      'fi',
      'echo "env: online"',
      'echo "state: not logged in"',
      'exit 3',
    ].join('\n'), 'utf-8')
    chmodSync(kepAuth, 0o755)
    process.env.HERMES_KEP_AUTH_BIN = kepAuth

    const result = await listSkillCredentialStatuses({
      profileName: 'feishu_user_a',
      profileDir,
    })

    expect(result.credentials.find(item => item.id === 'kep-cli-pre')).toMatchObject({
      status: 'authenticated',
      account_hint: 'pre_user',
      action: { kind: 'oauth_url', env: 'pre' },
    })
  })

  it('keeps mixed kep-cli online and pre required_by on their own cards', async () => {
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-kep-mixed-env-'))
    roots.push(profileDir)
    mkdirSync(join(profileDir, 'skills', 'Keep', 'kep-hades-cli'), { recursive: true })
    mkdirSync(join(profileDir, 'skills', 'Keep', 'kep-trevi-delivery-orchestrate'), { recursive: true })
    mkdirSync(join(profileDir, 'home'), { recursive: true })
    writeFileSync(join(profileDir, 'skills', 'Keep', 'kep-hades-cli', 'SKILL.md'), [
      '---',
      'name: kep-hades-cli',
      'metadata:',
      '  hermes:',
      '    tags: [kep-cli, hades]',
      '---',
      '<local-home>/.hermes/bin/kep-auth --profile "$KEP_PROFILE" --env online status',
    ].join('\n'), 'utf-8')
    writeFileSync(join(profileDir, 'skills', 'Keep', 'kep-trevi-delivery-orchestrate', 'SKILL.md'), [
      '---',
      'name: kep-trevi-delivery-orchestrate',
      'metadata:',
      '  hermes:',
      '    tags: [kep-cli, trevi]',
      '---',
      '<local-home>/.hermes/bin/kep-auth --profile "$KEP_PROFILE" --env pre status',
    ].join('\n'), 'utf-8')
    const kepAuth = join(profileDir, 'kep-auth')
    writeFileSync(kepAuth, [
      '#!/bin/sh',
      'if [ "$4" = "pre" ]; then',
      '  echo "env: pre"',
      '  echo "state: valid"',
      '  echo "operator: pre_user"',
      '  exit 0',
      'fi',
      'echo "env: online"',
      'echo "state: valid"',
      'echo "operator: online_user"',
    ].join('\n'), 'utf-8')
    chmodSync(kepAuth, 0o755)
    process.env.HERMES_KEP_AUTH_BIN = kepAuth

    const result = await listSkillCredentialStatuses({
      profileName: 'feishu_user_a',
      profileDir,
    })

    expect(result.credentials.find(item => item.id === 'kep-cli-online')).toMatchObject({
      status: 'authenticated',
      required_by: ['kep-hades-cli'],
    })
    expect(result.credentials.find(item => item.id === 'kep-cli-pre')).toMatchObject({
      status: 'authenticated',
      required_by: ['kep-trevi-delivery-orchestrate'],
    })
  })

  it('starts kep-cli OAuth login from WebUI and returns the browser authorization URL', async () => {
    const { startKepCliAuth } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = makeProfile()
    const kepAuth = join(profileDir, 'kep-auth')
    writeFileSync(kepAuth, [
      '#!/bin/sh',
      `test "$HERMES_HOME" = "${profileDir}" || { echo "bad HERMES_HOME=$HERMES_HOME" >&2; exit 9; }`,
      'test "$KEP_PROFILE" = "feishu_user_a" || { echo "bad KEP_PROFILE=$KEP_PROFILE" >&2; exit 9; }',
      `test "$HOME" = "${join(profileDir, 'home')}" || { echo "bad HOME=$HOME" >&2; exit 9; }`,
      'echo "https://auth.example.com/?response_url=http://localhost:52237&oauth2=1" >&2',
      'sleep 0.2',
    ].join('\n'), 'utf-8')
    chmodSync(kepAuth, 0o755)
    process.env.HERMES_KEP_AUTH_BIN = kepAuth

    const result = await startKepCliAuth({
      id: 'kep-cli-online',
      profileName: 'feishu_user_a',
      profileDir,
    })

    expect(result).toMatchObject({
      id: 'kep-cli-online',
      status: 'auth_pending',
      verification_uri: 'https://auth.example.com/?response_url=http://localhost:52237&oauth2=1',
      action: {
        kind: 'oauth_url',
        label: '打开 kep-cli online 认证',
        env: 'online',
      },
    })
  })

  it('starts kep-cli OAuth login for pre when requested by the WebUI action', async () => {
    const { startKepCliAuth } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = makeProfile()
    const kepAuth = join(profileDir, 'kep-auth')
    writeFileSync(kepAuth, [
      '#!/bin/sh',
      'test "$1" = "--profile" || { echo "bad arg1=$1" >&2; exit 9; }',
      'test "$2" = "feishu_user_a" || { echo "bad profile=$2" >&2; exit 9; }',
      'test "$3" = "--env" || { echo "bad arg3=$3" >&2; exit 9; }',
      'test "$4" = "pre" || { echo "bad env=$4" >&2; exit 9; }',
      'test "$5" = "login" || { echo "bad command=$5" >&2; exit 9; }',
      'echo "https://auth.example.com/?response_url=http://localhost:52237&oauth2=1" >&2',
      'sleep 0.2',
    ].join('\n'), 'utf-8')
    chmodSync(kepAuth, 0o755)
    process.env.HERMES_KEP_AUTH_BIN = kepAuth

    const result = await startKepCliAuth({
      id: 'kep-cli-pre',
      profileName: 'feishu_user_a',
      profileDir,
      env: 'pre',
    } as any)

    expect(result).toMatchObject({
      id: 'kep-cli-pre',
      status: 'auth_pending',
      action: { kind: 'oauth_url', env: 'pre' },
    })
  })

  it('rewrites kep-cli OAuth callback through the public WebUI origin and proxies back to the active local listener', async () => {
    const {
      completeKepCliAuthCallback,
      startKepCliAuth,
    } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = makeProfile()
    const kepAuth = join(profileDir, 'kep-auth')
    writeFileSync(kepAuth, [
      '#!/bin/sh',
      'echo "https://auth.example.com/?response_url=http://localhost:52237&oauth2=1" >&2',
      'sleep 0.2',
    ].join('\n'), 'utf-8')
    chmodSync(kepAuth, 0o755)
    process.env.HERMES_KEP_AUTH_BIN = kepAuth

    const result = await startKepCliAuth({
      id: 'kep-cli',
      profileName: 'feishu_user_a',
      profileDir,
      publicOrigin: 'https://hermes.example.com',
    })

    const authUrl = new URL(result.verification_uri)
    const responseUrl = new URL(authUrl.searchParams.get('response_url') || '')
    expect(responseUrl.origin).toBe('https://hermes.example.com')
    expect(responseUrl.pathname).toMatch(/^\/api\/auth\/kep-cli\/callback\/[A-Za-z0-9_-]+$/)
    expect(result.verification_uri).not.toContain('response_url=http://localhost')

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('kep-auth ok', { status: 200 }))
    const callback = await completeKepCliAuthCallback({
      sessionId: responseUrl.pathname.split('/').pop() || '',
      query: 'code=oauth-code',
    })

    expect(fetchSpy).toHaveBeenCalledWith('http://localhost:52237/?code=oauth-code', {
      method: 'GET',
      redirect: 'manual',
    })
    expect(callback).toEqual({ status: 'ok', body: 'kep-auth ok' })
  })

  it('rejects unknown kep-cli OAuth callback sessions without contacting localhost', async () => {
    const { completeKepCliAuthCallback } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(completeKepCliAuthCallback({
      sessionId: 'missing-session',
      query: 'code=oauth-code',
    })).rejects.toMatchObject({
      status: 404,
      message: 'kep-cli auth session was not found or has expired',
    })

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not treat Keep-record local credential files as authenticated without a verified QR flow', async () => {
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = makeProfile()

    const result = await listSkillCredentialStatuses({
      profileName: 'feishu_user_a',
      profileDir,
    })

    expect(result.credentials.find(item => item.id === 'keep-record')).toMatchObject({
      status: 'unknown',
      account_hint: 'Keep User',
      detail: 'Keep-record local credential file exists, but WebUI has not verified a live Keep login. Use QR scan to authorize or refresh it.',
    })
    expect(JSON.stringify(result)).not.toContain('keep-secret-token')
  })

  it('recognizes profile-local Lark-cli user authorization without returning token contents', async () => {
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = makeProfile()
    mkdirSync(join(profileDir, 'feishu_uat'), { recursive: true })
    writeFileSync(
      join(profileDir, 'feishu_uat', 'ou_user_a.json'),
      JSON.stringify({
        user_open_id: 'ou_user_a',
        access_token: 'lark-secret-token',
        expires_at: Date.now() + 60 * 60 * 1000,
      }),
      'utf-8',
    )

    const result = await listSkillCredentialStatuses({
      profileName: 'feishu_user_a',
      profileDir,
      user: { openid: 'ou_user_a', profile: 'feishu_user_a', role: 'user' },
    })

    expect(result.credentials.find(item => item.id === 'lark-cli')).toMatchObject({
      status: 'authenticated',
      default_identity: 'user',
    })
    expect(JSON.stringify(result)).not.toContain('lark-secret-token')
    expect(JSON.stringify(result)).not.toContain('ou_user_a')
  })

  it('does not scan profile-local Lark authorization files without a trusted actor', async () => {
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = makeProfile()
    mkdirSync(join(profileDir, 'feishu_uat'), { recursive: true })
    writeFileSync(
      join(profileDir, 'feishu_uat', 'ou_other.json'),
      JSON.stringify({ user_open_id: 'ou_other', access_token: 'other-token', expires_at: Date.now() + 5 * 60_000 }),
      'utf-8',
    )

    const result = await listSkillCredentialStatuses({
      profileName: 'user_a',
      profileDir,
    })

    expect(result.credentials.find(item => item.id === 'lark-cli')?.status).toBe('needs_auth')
    expect(JSON.stringify(result)).not.toContain('other-token')
  })

  it('does not use another actor\'s profile-local Lark authorization', async () => {
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = makeProfile()
    mkdirSync(join(profileDir, 'feishu_uat'), { recursive: true })
    writeFileSync(
      join(profileDir, 'feishu_uat', 'ou_other.json'),
      JSON.stringify({ user_open_id: 'ou_other', access_token: 'other-token', expires_at: Date.now() + 60_000 }),
      'utf-8',
    )

    const result = await listSkillCredentialStatuses({
      profileName: 'user_a',
      profileDir,
      user: { openid: 'ou_user_a', profile: 'user_a', role: 'user' },
    })

    expect(result.credentials.find(item => item.id === 'lark-cli')?.status).toBe('needs_auth')
    expect(JSON.stringify(result)).not.toContain('other-token')
  })

  it('does not treat bot-only Lark-cli runtime availability as personal user authorization', async () => {
    const { listSkillCredentialStatuses } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = makeProfile()

    const result = await listSkillCredentialStatuses({
      profileName: 'user_b',
      profileDir,
      user: {
        openid: 'ou_user_b',
        profile: 'user_b',
        role: 'user',
        name: '孙迎仑',
      },
      larkStatus: {
        status: 'missing',
        lark_cli: {
          available: true,
          default_identity: 'bot',
        },
      },
    })

    expect(result.credentials.find(item => item.id === 'lark-cli')).toMatchObject({
      status: 'needs_auth',
      detail: 'Lark-cli needs user authorization for private Lark resources.',
      action: {
        label: '授权',
      },
    })
    expect(result.credentials.find(item => item.id === 'lark-cli')?.default_identity).toBeUndefined()
  })

  it('returns safe action metadata for starting credential flows', async () => {
    const { getSkillCredentialStartAction } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = makeProfile()

    await expect(getSkillCredentialStartAction({
      id: 'lark-cli',
      profileName: 'feishu_user_a',
      profileDir,
    })).resolves.toMatchObject({
      id: 'lark-cli',
      action: {
        kind: 'feishu_device_flow',
      },
    })

    await expect(getSkillCredentialStartAction({
      id: 'keep-record',
      profileName: 'feishu_user_a',
      profileDir,
    })).resolves.toMatchObject({
      id: 'keep-record',
      action: {
        kind: 'skill_flow',
        command: '/keep-record auth',
      },
    })

    await expect(getSkillCredentialStartAction({
      id: 'gitlab-personal',
      profileName: 'feishu_user_a',
      profileDir,
      publicOrigin: 'https://hermes.example.com',
    })).resolves.toEqual({
      id: 'gitlab-personal',
      verification_uri: 'https://hermes.example.com/#/hermes/chat?surface=expert&tab=connectors&open_credential=gitlab-personal',
    })

    // 全局 GitLab 和未知连接器仍没有员工可启动的流程，不能返回假成功。
    for (const id of ['gitlab', 'no-such-connector']) {
      const err = await getSkillCredentialStartAction({
        id,
        profileName: 'feishu_user_a',
        profileDir,
      }).then(() => null, (e: any) => e)
      expect(err, `${id} must not report a started flow`).toBeInstanceOf(Error)
      expect(err.status).toBe(400)
      expect(JSON.stringify(err.message)).not.toContain('gitlab-secret-token')
    }
  })

  it('returns a same-origin current-page handoff for stale GitLab personal start requests', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-home-'))
    roots.push(hermesHome)
    process.env.HERMES_HOME = hermesHome
    mkdirSync(join(hermesHome, 'profiles', 'preview'), { recursive: true })

    vi.resetModules()
    const { skillCredentialStart } = await import('../../packages/server/src/controllers/auth')
    const ctx: any = {
      params: { id: 'gitlab-personal' },
      query: { profile: 'preview' },
      request: { body: {} },
      state: {},
      origin: 'http://127.0.0.1:8648',
      get: (name: string) => ({
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'hermes.example.com',
      } as Record<string, string>)[name.toLowerCase()] || '',
    }

    await skillCredentialStart(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({
      id: 'gitlab-personal',
      verification_uri: 'https://hermes.example.com/#/hermes/chat?surface=expert&tab=connectors&open_credential=gitlab-personal',
    })
    expect(JSON.stringify(ctx.body)).not.toContain('profile=')
    expect(JSON.stringify(ctx.body)).not.toContain('open_id')
    expect(JSON.stringify(ctx.body)).not.toContain('token=')
  })

  it('starts and completes Keep-record QR auth without returning the token', async () => {
    const {
      completeKeepRecordAuth,
      listSkillCredentialStatuses,
      startKeepRecordAuth,
    } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = makeProfile()
    const scriptsDir = join(profileDir, 'skills', 'Keep', 'keep-record', 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(
      join(scriptsDir, 'mcp-call.js'),
      'console.log(JSON.stringify({ok:true,data:{qrcodeId:"qr-1",qrcodeUrl:"https://keep.example/qr.png",redirectUrl:"https://keep.example/login"}}))\n',
      'utf-8',
    )
    writeFileSync(
      join(scriptsDir, 'login-wait.js'),
      'console.log(JSON.stringify({ok:true,data:{status:"authorized",token:"keep-secret-token",user:{username:"Keep User"}}}))\n',
      'utf-8',
    )
    writeFileSync(
      join(scriptsDir, 'persist_auth.js'),
      [
        'const fs = require("fs");',
        'const path = require("path");',
        'const token = process.argv.find(arg => arg.startsWith("--token="))?.slice(8) || "";',
        'const username = process.argv.find(arg => arg.startsWith("--username="))?.slice(11) || "";',
        'fs.mkdirSync(path.join(process.env.HOME, ".keepai"), { recursive: true });',
        'fs.writeFileSync(path.join(process.env.HOME, ".keepai", ".env"), `keep_auth_token=${token}\\nkeep_username=${username}\\n`);',
      ].join('\n'),
      'utf-8',
    )

    const started = await startKeepRecordAuth({
      id: 'keep-record',
      profileName: 'feishu_user_a',
      profileDir,
    })

    expect(started).toMatchObject({
      status: 'qr_pending',
      qrcode_id: 'qr-1',
      qrcode_url: 'https://keep.example/qr.png',
      redirect_url: 'https://keep.example/login',
    })
    expect(JSON.stringify(started)).not.toContain('keep-secret-token')

    const completed = await completeKeepRecordAuth({
      id: 'keep-record',
      profileName: 'feishu_user_a',
      profileDir,
      qrcodeId: 'qr-1',
    })

    expect(completed).toEqual({
      id: 'keep-record',
      status: 'authenticated',
      account_hint: 'Keep User',
    })
    expect(JSON.stringify(completed)).not.toContain('keep-secret-token')

    const listed = await listSkillCredentialStatuses({
      profileName: 'feishu_user_a',
      profileDir,
    })
    expect(listed.credentials.find(item => item.id === 'keep-record')).toMatchObject({
      status: 'authenticated',
      account_hint: 'Keep User',
    })
    expect(JSON.stringify(listed)).not.toContain('keep-secret-token')
  })

  it('runs Keep-record auth scripts with a compatible installed skill SDK fallback', async () => {
    const { startKeepRecordAuth } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = makeProfile()
    const scriptsDir = join(profileDir, 'skills', 'Keep', 'keep-record', 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    const fallbackRoot = join(dirname(profileDir), 'legacy-profile', 'skills', 'Keep', 'keep-record', 'node_modules')
    const sdkDir = join(fallbackRoot, '@keepclaw', 'skill-sdk')
    mkdirSync(join(sdkDir, 'src'), { recursive: true })
    writeFileSync(join(sdkDir, 'package.json'), JSON.stringify({
      name: '@keepclaw/skill-sdk',
      version: '0.6.2',
      exports: {
        './mcp-cli': './src/mcp-cli.js',
      },
    }), 'utf-8')
    writeFileSync(join(sdkDir, 'src', 'mcp-cli.js'), [
      'exports.runCli = () => {',
      '  if (!process.env.NODE_PATH || !process.env.NODE_PATH.includes("legacy-profile")) process.exit(7);',
      '  console.log(JSON.stringify({ok:true,data:{qrcodeId:"qr-fallback",qrcodeUrl:"https://keep.example/fallback.png",redirectUrl:"https://keep.example/fallback"}}));',
      '};',
    ].join('\n'), 'utf-8')
    writeFileSync(
      join(scriptsDir, 'mcp-call.js'),
      'require("@keepclaw/skill-sdk/mcp-cli").runCli()\n',
      'utf-8',
    )

    const started = await startKeepRecordAuth({
      id: 'keep-record',
      profileName: 'feishu_user_a',
      profileDir,
    })

    expect(started).toMatchObject({
      status: 'qr_pending',
      qrcode_id: 'qr-fallback',
      qrcode_url: 'https://keep.example/fallback.png',
      redirect_url: 'https://keep.example/fallback',
    })
  })

  it('loads credential status from the request profile without a Feishu session', async () => {
    // This test asserts the LOCAL reader's output (gitlab=configured + secret
    // redaction); the broker path is covered by connector-registry-client.test.ts.
    process.env.HERMES_WEBUI_CONNECTORS_USE_BROKER = '0'
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-home-'))
    roots.push(hermesHome)
    process.env.HERMES_HOME = hermesHome
    mkdirSync(join(hermesHome, 'profiles', 'preview'), { recursive: true })
    mkdirSync(join(hermesHome, 'profiles', 'preview', 'workspace', 'credentials'), { recursive: true })
    writeFileSync(join(hermesHome, 'active_profile'), 'preview\n', 'utf-8')
    writeFileSync(
      join(hermesHome, 'profiles', 'preview', 'workspace', 'credentials', 'gitlab.token'),
      'gitlab-secret-token',
      'utf-8',
    )

    vi.resetModules()
    const { skillCredentialsStatus } = await import('../../packages/server/src/controllers/auth')
    const ctx: any = {
      state: {},
      query: {},
      get: (name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'preview' : '',
    }

    await skillCredentialsStatus(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.profile_name).toBe('preview')
    expect(ctx.body.credentials.find((item: any) => item.id === 'gitlab')).toMatchObject({
      status: 'configured',
    })
    expect(JSON.stringify(ctx.body)).not.toContain('gitlab-secret-token')
  })

  it('rejects connector identity fields supplied by the browser before broker dispatch', async () => {
    vi.resetModules()
    const { connectorCatalogConnect, customConnectors, customConnectorImport } = await import('../../packages/server/src/controllers/auth')
    const user = { openid: 'ou_user_a', profile: 'feishu_user_a', role: 'user' }
    const forgedQuery: any = { state: { user }, query: { profile: 'feishu_user_b' }, request: {}, get: () => '' }
    await customConnectors(forgedQuery)
    expect(forgedQuery.status).toBe(400)

    const forgedBody: any = {
      state: { user }, query: {}, get: () => '',
      request: { body: { profile_name: 'feishu_user_b', config: '{}' } },
    }
    await customConnectorImport(forgedBody)
    expect(forgedBody.status).toBe(400)
    expect(JSON.stringify(forgedBody.body)).not.toContain('ou_user_a')

    const forgedConnect: any = {
      state: { user }, query: {}, get: () => '',
      request: { body: { row_key: 'workbuddy:ready', subject_id: 'other' } },
    }
    await connectorCatalogConnect(forgedConnect)
    expect(forgedConnect.status).toBe(400)

    const malformedFields: any = {
      state: { user }, query: {}, get: () => '',
      request: { body: { row_key: 'workbuddy:ready', fields: 'secret' } },
    }
    await connectorCatalogConnect(malformedFields)
    expect(malformedFields.status).toBe(400)
  })

  it('loads credential status from an owner-scoped selected profile for a Feishu session', async () => {
    // Asserts the LOCAL reader's output (gitlab=configured + secret redaction)
    // through owner-scoped profile resolution; broker path tested separately.
    process.env.HERMES_WEBUI_CONNECTORS_USE_BROKER = '0'
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-home-'))
    roots.push(hermesHome)
    process.env.HERMES_HOME = hermesHome
    process.env.HERMES_WEB_PLANE = 'chat'
    process.env.HERMES_MULTITENANCY_DB = makeRoutingDb([
      { user_id: 'user_a', profile_name: 'feishu_user_a', open_id: 'ou_user_a' },
      { user_id: 'group_alpha', profile_name: 'feishu_group_alpha', open_id: '', owner_open_id: 'ou_user_a', provenance: 'group', kind: 'agent' },
    ])
    mkdirSync(join(hermesHome, 'profiles', 'feishu_user_a'), { recursive: true })
    mkdirSync(join(hermesHome, 'profiles', 'feishu_group_alpha', 'workspace', 'credentials'), { recursive: true })
    writeFileSync(
      join(hermesHome, 'profiles', 'feishu_group_alpha', 'workspace', 'credentials', 'gitlab.token'),
      'group-gitlab-secret-token',
      'utf-8',
    )
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      status: 'authenticated',
      account_hint: '孙可',
    }), { status: 200 }) as any)

    vi.resetModules()
    const { skillCredentialsStatus } = await import('../../packages/server/src/controllers/auth')
    const ctx: any = {
      state: { user: { openid: 'ou_user_a', profile: 'feishu_user_a', role: 'user' } },
      query: { profile: 'feishu_group_alpha' },
      get: () => '',
    }

    await skillCredentialsStatus(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.profile_name).toBe('feishu_group_alpha')
    expect(ctx.body.credentials.find((item: any) => item.id === 'gitlab')).toMatchObject({
      status: 'configured',
    })
    expect(JSON.stringify(ctx.body)).not.toContain('group-gitlab-secret-token')
    fetchSpy.mockRestore()
  })

  it('serves connector status from the broker by default (single source of truth)', async () => {
    // No HERMES_WEBUI_CONNECTORS_USE_BROKER set → default ON → must hit the broker.
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-home-'))
    roots.push(hermesHome)
    process.env.HERMES_HOME = hermesHome
    process.env.HERMES_RUN_BROKER_URL = 'http://broker.test'
    mkdirSync(join(hermesHome, 'profiles', 'preview', 'workspace', 'credentials'), { recursive: true })
    writeFileSync(join(hermesHome, 'active_profile'), 'preview\n', 'utf-8')
    // A local gitlab token: the LOCAL reader would report 'configured'. If the result
    // came from local instead of the broker, this test would catch it.
    writeFileSync(join(hermesHome, 'profiles', 'preview', 'workspace', 'credentials', 'gitlab.token'), 'local-secret', 'utf-8')

    const brokerBody = {
      profile_name: 'preview',
      connectors: [
        { id: 'kep-cli-online', title: 'kep-cli online', provider: 'keep', installed: true, status: 'needs_auth', detail: 'kep-cli online 登录已过期，请重新认证。', action: { kind: 'oauth_url', label: '重新认证', env: 'online' } },
        { id: 'gitlab', title: 'GitLab', provider: 'gitlab', installed: true, status: 'configured', detail: 'from-broker', action: { kind: 'manual', label: '刷新' } },
      ],
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(brokerBody), { status: 200 }) as any,
    )

    vi.resetModules()
    const { skillCredentialsStatus } = await import('../../packages/server/src/controllers/auth')
    const ctx: any = { state: {}, query: {}, get: () => '' }
    await skillCredentialsStatus(ctx)

    expect(ctx.status).toBe(200)
    // It reached the broker's /connectors endpoint...
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('http://broker.test/api/run-broker/connectors'),
      expect.anything(),
    )
    // ...and served the broker's exp-decoded kep-cli needs_auth (NOT a local blind
    // 'authenticated'), and the broker gitlab row (detail proves it isn't local).
    expect(ctx.body.credentials.find((c: any) => c.id === 'kep-cli-online')?.status).toBe('needs_auth')
    expect(ctx.body.credentials.find((c: any) => c.id === 'gitlab')?.detail).toBe('from-broker')
    fetchSpy.mockRestore()
  })

  it('fails safe to error states when the broker is down — never the lying-local result', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-home-'))
    roots.push(hermesHome)
    process.env.HERMES_HOME = hermesHome
    process.env.HERMES_RUN_BROKER_URL = 'http://broker.test'
    mkdirSync(join(hermesHome, 'profiles', 'preview', 'workspace', 'credentials'), { recursive: true })
    writeFileSync(join(hermesHome, 'active_profile'), 'preview\n', 'utf-8')
    // Local gitlab token present → the LOCAL reader would say 'configured'. The
    // fail-safe must NOT fall back to it (that's the red line: never a stale truth).
    writeFileSync(join(hermesHome, 'profiles', 'preview', 'workspace', 'credentials', 'gitlab.token'), 'local-secret', 'utf-8')

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))

    vi.resetModules()
    const { skillCredentialsStatus } = await import('../../packages/server/src/controllers/auth')
    const ctx: any = { state: {}, query: {}, get: () => '' }
    await skillCredentialsStatus(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.credentials.length).toBeGreaterThan(0)
    // Every connector is the fail-safe error state — gitlab is 'error', NOT the
    // local reader's 'configured'. No fallback to a source that could lie.
    expect(ctx.body.credentials.every((c: any) => c.status === 'error')).toBe(true)
    expect(ctx.body.credentials.find((c: any) => c.id === 'gitlab')?.status).toBe('error')
    fetchSpy.mockRestore()
  })

  // --- Figma MCP：WebUI 只做代理，MT 才有授权链接 --------------------------
  //
  // 这一组盯死两条线：① 身份只从已验证会话来；② MT 说失败就失败，绝不在 WebUI
  // 侧把它翻译成一个空操作 200（ligaofeng 2026-08-06 的假「认证流程已启动」）。

  function figmaBrokerHome() {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-home-'))
    roots.push(hermesHome)
    process.env.HERMES_HOME = hermesHome
    process.env.HERMES_RUN_BROKER_URL = 'http://broker.test'
    mkdirSync(join(hermesHome, 'profiles', 'preview'), { recursive: true })
    writeFileSync(join(hermesHome, 'active_profile'), 'preview\n', 'utf-8')
    return hermesHome
  }

  function figmaStartCtx() {
    return {
      params: { id: 'figma' },
      query: { profile: 'preview' },
      request: { body: {} },
      state: { user: { profile: 'preview', openid: 'ou_owner_alice' } },
      origin: 'http://127.0.0.1:8648',
      get: () => '',
    } as any
  }

  it('starts Figma authorization by proxying the broker and returns its authorization_url', async () => {
    figmaBrokerHome()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        profile_name: 'preview',
        authorization_url: 'https://www.figma.com/oauth/mcp?state=abc&code_challenge=xyz',
        state: 'abc',
      }), { status: 202 }) as any,
    )

    vi.resetModules()
    const { skillCredentialStart } = await import('../../packages/server/src/controllers/auth')
    const ctx = figmaStartCtx()
    await skillCredentialStart(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({
      id: 'figma',
      verification_uri: 'https://www.figma.com/oauth/mcp?state=abc&code_challenge=xyz',
    })
    const [url, init] = fetchSpy.mock.calls[0] as [string, any]
    expect(url).toBe('http://broker.test/api/run-broker/credentials/figma')
    expect(init.method).toBe('POST')
    // 身份断言来自已验证会话，不是请求体。
    expect(init.headers['X-Hermes-Owner-Open-Id']).toBe('ou_owner_alice')
    fetchSpy.mockRestore()
  })

  it('passes the broker 503 (public origin unset) through instead of claiming a started flow', async () => {
    figmaBrokerHome()
    const message = 'HERMES_MCP_PUBLIC_ORIGIN 未配置，请管理员在 run-broker 上设置公网回调地址后再授权。'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: message }), { status: 503 }) as any,
    )

    vi.resetModules()
    const { skillCredentialStart } = await import('../../packages/server/src/controllers/auth')
    const ctx = figmaStartCtx()
    await skillCredentialStart(ctx)

    expect(ctx.status).toBe(503)
    expect(ctx.body).toEqual({ error: message })
    expect(JSON.stringify(ctx.body)).not.toContain('verification_uri')
    fetchSpy.mockRestore()
  })

  it('refuses a Figma start without a verified owner identity', async () => {
    figmaBrokerHome()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, authorization_url: 'https://www.figma.com/oauth/mcp' }), { status: 202 }) as any,
    )

    vi.resetModules()
    const { skillCredentialStart } = await import('../../packages/server/src/controllers/auth')
    const ctx = figmaStartCtx()
    ctx.state = {}
    await skillCredentialStart(ctx)

    expect(ctx.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(JSON.stringify(ctx.body)).not.toContain('figma.com')
    fetchSpy.mockRestore()
  })

  it('never hands the browser a non-https authorization_url', async () => {
    figmaBrokerHome()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, authorization_url: 'javascript:alert(1)' }), { status: 202 }) as any,
    )

    vi.resetModules()
    const { skillCredentialStart } = await import('../../packages/server/src/controllers/auth')
    const ctx = figmaStartCtx()
    await skillCredentialStart(ctx)

    expect(ctx.status).toBe(502)
    expect(JSON.stringify(ctx.body)).not.toContain('javascript:')
    fetchSpy.mockRestore()
  })

  it('keeps unknown connectors at 400 after the Figma branch was added', async () => {
    const { getSkillCredentialStartAction } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = makeProfile()
    for (const id of ['gitlab', 'no-such-connector']) {
      const err = await getSkillCredentialStartAction({
        id,
        profileName: 'feishu_user_a',
        profileDir,
        ownerOpenId: 'ou_owner_alice',
      }).then(() => null, (e: any) => e)
      expect(err, `${id} must not report a started flow`).toBeInstanceOf(Error)
      expect(err.status).toBe(400)
    }
  })

  it('revokes the caller own Figma authorization through the owner-bound broker route', async () => {
    figmaBrokerHome()
    process.env.HERMES_WEB_PLANE = 'chat'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 }) as any,
    )

    vi.resetModules()
    const { revokeFigmaCredential } = await import('../../packages/server/src/controllers/hermes/gitlab-credential')
    const ctx: any = {
      query: { profile: 'preview' },
      request: { body: {} },
      state: { user: { profile: 'preview', openid: 'ou_owner_alice' } },
      get: () => '',
    }
    await revokeFigmaCredential(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({ ok: true, revoked: true })
    const [url, init] = fetchSpy.mock.calls[0] as [string, any]
    expect(url).toBe('http://broker.test/api/run-broker/credentials/figma')
    expect(init.method).toBe('DELETE')
    expect(init.headers['X-Hermes-Owner-Open-Id']).toBe('ou_owner_alice')
    fetchSpy.mockRestore()
  })

  // 真机走查里弹窗撤销后不关（2026-09-21）：客户端只在 `ok` 为真时关弹窗，所以这条
  // 链上任何一环把 `ok` 丢了都会让员工对着一个点不动的确认框。下面两条把 WebUI 侧
  // 实际回给浏览器的 body 钉死。
  it('reports ok:true on an idempotent Figma revoke so the client closes its dialog', async () => {
    figmaBrokerHome()
    process.env.HERMES_WEB_PLANE = 'chat'
    // broker 对"本来就没授权"回 revoked:false —— 对员工同样是"现在没绑"，不是失败。
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, revoked: false }), { status: 200 }) as any,
    )

    vi.resetModules()
    const { revokeFigmaCredential } = await import('../../packages/server/src/controllers/hermes/gitlab-credential')
    const ctx: any = {
      query: { profile: 'preview' },
      request: { body: {} },
      state: { user: { profile: 'preview', openid: 'ou_owner_alice' } },
      get: () => '',
    }
    await revokeFigmaCredential(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({ ok: true, revoked: false })
    // 客户端的判据就是这一行（CredentialsView.confirmFigmaRevoke: `if (!result?.ok)`）。
    expect((ctx.body as any).ok).toBe(true)
    fetchSpy.mockRestore()
  })

  // 这颗撤销按钮由客户端在 status === 'authenticated' 时无条件渲染，而控制器只在
  // chat 面存在。非 chat 面（webPlane 默认 'both'，即 token 认证的运维面）上按钮点下去
  // 只会拿到 404，弹窗留在原地 —— 记在这里，免得下次又当成客户端 bug 查。
  it('refuses the Figma revoke outside the chat plane (button renders there anyway)', async () => {
    figmaBrokerHome()
    delete process.env.HERMES_WEB_PLANE
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    vi.resetModules()
    const { revokeFigmaCredential } = await import('../../packages/server/src/controllers/hermes/gitlab-credential')
    const ctx: any = {
      query: { profile: 'preview' },
      request: { body: {} },
      state: { user: { profile: 'preview', openid: 'ou_owner_alice' } },
      get: () => '',
    }
    await revokeFigmaCredential(ctx)

    expect(ctx.status).toBe(404)
    expect((ctx.body as any).ok).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('does not report a Figma revoke success when the broker rejects it', async () => {
    figmaBrokerHome()
    process.env.HERMES_WEB_PLANE = 'chat'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Figma 授权服务暂不可用，请稍后重试。' }), { status: 500 }) as any,
    )

    vi.resetModules()
    const { revokeFigmaCredential } = await import('../../packages/server/src/controllers/hermes/gitlab-credential')
    const ctx: any = {
      query: { profile: 'preview' },
      request: { body: {} },
      state: { user: { profile: 'preview', openid: 'ou_owner_alice' } },
      get: () => '',
    }
    await revokeFigmaCredential(ctx)

    expect(ctx.status).toBe(500)
    expect(ctx.body.ok).toBe(false)
    expect(ctx.body.error).toContain('Figma')
    fetchSpy.mockRestore()
  })

  // HTTP 200 不等于撤销成功。broker 的成功形状是 `{ok:true, revoked:<bool>}`；
  // 少了 `ok:true`、或者 body 根本解析不出来，都不能让员工看到「已撤销」。
  // codex review 2026-09-21, `revokefigmaauthorization:unvalidated-success`。
  it('does not report success when the broker answers HTTP 200 with ok:false', async () => {
    figmaBrokerHome()
    process.env.HERMES_WEB_PLANE = 'chat'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'Figma 授权服务暂不可用，请稍后重试。' }), { status: 200 }) as any,
    )

    vi.resetModules()
    const { revokeFigmaCredential } = await import('../../packages/server/src/controllers/hermes/gitlab-credential')
    const ctx: any = {
      query: { profile: 'preview' },
      request: { body: {} },
      state: { user: { profile: 'preview', openid: 'ou_owner_alice' } },
      get: () => '',
    }
    await revokeFigmaCredential(ctx)

    expect(ctx.status).toBe(502)
    expect(ctx.body.ok).toBe(false)
    expect(ctx.body.revoked).toBeUndefined()
    expect(ctx.body.error).toContain('Figma 授权服务暂不可用')
    fetchSpy.mockRestore()
  })

  it('does not report success when the broker body does not parse to the revoke shape', async () => {
    figmaBrokerHome()
    process.env.HERMES_WEB_PLANE = 'chat'
    // 网关塞了一页 HTML 回来：解析失败后旧链路会静默变成 revoked:false + ok:true。
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>502 Bad Gateway</html>', { status: 200 }) as any,
    )

    vi.resetModules()
    const { revokeFigmaCredential } = await import('../../packages/server/src/controllers/hermes/gitlab-credential')
    const ctx: any = {
      query: { profile: 'preview' },
      request: { body: {} },
      state: { user: { profile: 'preview', openid: 'ou_owner_alice' } },
      get: () => '',
    }
    await revokeFigmaCredential(ctx)

    expect(ctx.status).toBe(502)
    expect(ctx.body.ok).toBe(false)
    expect(ctx.body.revoked).toBeUndefined()
    fetchSpy.mockRestore()
  })

  // --- 目录 OAuth 回调：Figma 真的会带 iss ---------------------------------
  //
  // 回调的 query 闸是"只许出现列出的键"，所以 `iss` 不列进去的话，员工点完 Allow 回来
  // 拿到的是 400，连 MT 都到不了。列进去之后仍然只转"像样的 https issuer"。

  function catalogCallbackCtx(query: Record<string, string>) {
    return {
      query,
      request: { body: {} },
      state: {},
      redirect: vi.fn(),
      get: () => '',
    } as any
  }

  it('forwards the iss that Figma puts on the OAuth redirect', async () => {
    figmaBrokerHome()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }) as any,
    )

    vi.resetModules()
    const { connectorCatalogOAuthCallback } = await import('../../packages/server/src/controllers/auth')
    const ctx = catalogCallbackCtx({
      state: 'opaque-state',
      code: 'oauth-code',
      iss: 'https://api.figma.com',
    })
    await connectorCatalogOAuthCallback(ctx)

    // 闸没把带 iss 的回调拦下来。
    expect(ctx.status).not.toBe(400)
    expect(ctx.redirect).toHaveBeenCalledWith('/hermes/connectors?catalog_oauth=success')
    const [url, init] = fetchSpy.mock.calls[0] as [string, any]
    expect(url).toBe('http://broker.test/api/run-broker/connector-catalog/oauth/callback')
    expect(JSON.parse(init.body)).toEqual({
      state: 'opaque-state', code: 'oauth-code', iss: 'https://api.figma.com',
    })
    fetchSpy.mockRestore()
  })

  it('keeps the exact {state, code} body for a redirect without iss', async () => {
    figmaBrokerHome()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }) as any,
    )

    vi.resetModules()
    const { connectorCatalogOAuthCallback } = await import('../../packages/server/src/controllers/auth')
    const ctx = catalogCallbackCtx({ state: 'opaque-state', code: 'oauth-code' })
    await connectorCatalogOAuthCallback(ctx)

    expect(ctx.redirect).toHaveBeenCalled()
    const [, init] = fetchSpy.mock.calls[0] as [string, any]
    expect(JSON.parse(init.body)).toEqual({ state: 'opaque-state', code: 'oauth-code' })
    fetchSpy.mockRestore()
  })

  // 带了一个不合法的 iss 不是"没带"：静默丢掉会让 MT 把「错的签发方」当成
  // 「没有签发方」走兼容路径。400 当场断掉，broker 一个字节都收不到。
  // codex review 2026-09-21, `sanitizeoauthissuer:invalid-issuer-downgrade`。
  it('rejects an explicitly invalid iss with 400 and never calls the broker', async () => {
    figmaBrokerHome()

    for (const iss of ['javascript:alert(1)', 'http://api.figma.com', '', 'api.figma.com']) {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }) as any,
      )
      vi.resetModules()
      const { connectorCatalogOAuthCallback } = await import('../../packages/server/src/controllers/auth')
      const ctx = catalogCallbackCtx({ state: 'opaque-state', code: 'oauth-code', iss })
      await connectorCatalogOAuthCallback(ctx)

      expect(ctx.status, iss).toBe(400)
      expect(ctx.redirect, iss).not.toHaveBeenCalled()
      expect(fetchSpy, iss).not.toHaveBeenCalled()
      fetchSpy.mockRestore()
    }
  })

  it('rejects a repeated iss query key with 400 and never calls the broker', async () => {
    figmaBrokerHome()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }) as any,
    )

    vi.resetModules()
    const { connectorCatalogOAuthCallback } = await import('../../packages/server/src/controllers/auth')
    // Koa 对 `?iss=a&iss=b` 给数组 —— 两个签发方等于没法判定是哪个。
    const ctx = catalogCallbackCtx({
      state: 'opaque-state',
      code: 'oauth-code',
      iss: ['https://api.figma.com', 'https://evil.example'] as any,
    })
    await connectorCatalogOAuthCallback(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.redirect).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('still rejects a callback query key that is not state/code/iss', async () => {
    figmaBrokerHome()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    vi.resetModules()
    const { connectorCatalogOAuthCallback } = await import('../../packages/server/src/controllers/auth')
    const ctx = catalogCallbackCtx({ state: 'opaque-state', code: 'oauth-code', profile: 'preview' })
    await connectorCatalogOAuthCallback(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.redirect).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
