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
    delete process.env.HERMES_MULTITENANCY_DB
    delete process.env.HERMES_WEB_PLANE
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
      'kep-cli',
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
    expect(result.credentials.find(item => item.id === 'kep-cli')).toMatchObject({
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
      '  echo "Open https://project.feishu.cn/oauth/device?user_code=ABCD-1234" >&2',
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

  it('uses a Meegle profile without overriding HOME so macOS keychain can use the login keychain', async () => {
    const { startFeishuProjectAuth } = await import('../../packages/server/src/services/hermes/skill-credentials')
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-skill-credentials-meegle-keychain-home-'))
    roots.push(profileDir)
    const realHome = join(profileDir, 'real-home')
    mkdirSync(realHome, { recursive: true })
    const meegle = join(profileDir, 'fake-meegle')
    const invoked = join(profileDir, 'meegle-profile-home-args.txt')
    writeFileSync(meegle, [
      '#!/bin/sh',
      `test "$HOME" = "${realHome}" || { echo "bad HOME=$HOME" >&2; exit 12; }`,
      `printf '%s\\n' "$@" >> "${invoked}"`,
      'profile=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--profile" ]; then profile="$2"; shift 2; continue; fi',
      '  break',
      'done',
      'test "$profile" = "hermes_feishu_user_a" || { echo "bad profile=$profile" >&2; exit 11; }',
      'if [ "$1" = "config" ]; then exit 0; fi',
      'if [ "$1" = "auth" ] && [ "$2" = "login" ]; then',
      '  echo "Open https://project.feishu.cn/oauth/device?user_code=KEYCHAIN-1234"',
      '  sleep 0.2',
      '  exit 0',
      'fi',
      'exit 9',
    ].join('\n'), 'utf-8')
    chmodSync(meegle, 0o755)
    process.env.HERMES_MEEGLE_BIN = meegle
    process.env.HOME = realHome

    const result = await startFeishuProjectAuth({
      id: 'feishu-project',
      profileName: 'feishu_user_a',
      profileDir,
    })

    expect(result.verification_uri).toBe('https://project.feishu.cn/oauth/device?user_code=KEYCHAIN-1234')
    expect(readFileSync(invoked, 'utf-8')).toContain('--profile\nhermes_feishu_user_a')
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
    expect(result.credentials.find(item => item.id === 'kep-cli')).toMatchObject({
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
      text: 'Fetch proxy.cms.gotokeep.com APIs with kep-auth and KEP_PROFILE.',
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
      text: '分析 PRD 需求、任务、工作项和排期，并调用 proxy.cms.gotokeep.com。',
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
      text: 'Download SkillHub data from ark.gotokeep.com/aidock-cms, then write the result to a Feishu docx.',
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
      'Call proxy.cms.gotokeep.com through kep-auth to analyze PRD 需求、任务、工作项 and 排期.',
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
    expect(result.credentials.find(item => item.id === 'kep-cli')).toMatchObject({
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

    expect(result.credentials.find(item => item.id === 'kep-cli')).toMatchObject({
      installed: true,
      status: 'needs_auth',
    })
    expect(result.credentials.find(item => item.id === 'kep-cli')?.detail).not.toBe('No kep-cli backed skill is installed for this profile.')
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

    expect(result.credentials.find(item => item.id === 'kep-cli')).toMatchObject({
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

    expect(result.credentials.find(item => item.id === 'kep-cli')).toMatchObject({
      installed: true,
      status: 'needs_auth',
      required_by: ['daily-breaking'],
      detail: 'kep-auth status reports this profile is not logged in.',
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

    expect(result.credentials.find(item => item.id === 'kep-cli')).toMatchObject({
      status: 'needs_auth',
      detail: 'kep-auth status reports this profile is not logged in.',
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

    expect(result.credentials.find(item => item.id === 'kep-cli')).toMatchObject({
      status: 'authenticated',
      detail: 'kep-auth status verified this profile login.',
      account_hint: 'user_a',
    })
    expect(JSON.stringify(result)).not.toContain('user-a@example.com')
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
      id: 'kep-cli',
      profileName: 'feishu_user_a',
      profileDir,
    })

    expect(result).toMatchObject({
      id: 'kep-cli',
      status: 'auth_pending',
      verification_uri: 'https://auth.example.com/?response_url=http://localhost:52237&oauth2=1',
      action: {
        kind: 'oauth_url',
        label: '打开 kep-cli 认证',
      },
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
    })

    expect(result.credentials.find(item => item.id === 'lark-cli')).toMatchObject({
      status: 'authenticated',
      default_identity: 'user',
    })
    expect(JSON.stringify(result)).not.toContain('lark-secret-token')
    expect(JSON.stringify(result)).not.toContain('ou_user_a')
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

    const gitlab = await getSkillCredentialStartAction({
      id: 'gitlab',
      profileName: 'feishu_user_a',
      profileDir,
    })
    expect(JSON.stringify(gitlab)).not.toContain('gitlab-secret-token')
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

  it('loads credential status from an owner-scoped selected profile for a Feishu session', async () => {
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
})
