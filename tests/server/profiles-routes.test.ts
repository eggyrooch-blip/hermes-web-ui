import { existsSync, readFileSync } from 'fs'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const agentBridgeMocks = vi.hoisted(() => ({
  destroyAll: vi.fn(),
  destroyProfile: vi.fn(),
}))

const skillInjectorMocks = vi.hoisted(() => ({
  injectMissingSkills: vi.fn(),
  resolveTargetDirForProfile: vi.fn(),
}))

const sessionDeleterMocks = vi.hoisted(() => ({
  switchProfile: vi.fn(),
}))

const usersStoreMocks = vi.hoisted(() => ({
  listUserProfiles: vi.fn(),
}))

const gatewayAutostartMocks = vi.hoisted(() => ({
  getGatewayRuntimeStatusForProfile: vi.fn(),
  prepareGatewayForProfileDelete: vi.fn(),
  restartGatewayForProfile: vi.fn(),
}))

// Mock hermes-cli
vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  listProfiles: vi.fn(),
  getProfile: vi.fn(),
  createProfile: vi.fn(),
  deleteProfile: vi.fn(),
  renameProfile: vi.fn(),
  useProfile: vi.fn(),
  stopGateway: vi.fn(),
  startGateway: vi.fn(),
  startGatewayBackground: vi.fn(),
  setupReset: vi.fn(),
  exportProfile: vi.fn(),
  importProfile: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/agent-bridge', () => ({
  AgentBridgeClient: vi.fn(() => ({
    destroyAll: agentBridgeMocks.destroyAll,
    destroyProfile: agentBridgeMocks.destroyProfile,
  })),
}))

vi.mock('../../packages/server/src/services/hermes/skill-injector', () => {
  const HermesSkillInjector = vi.fn(() => ({
    injectMissingSkills: skillInjectorMocks.injectMissingSkills,
  })) as any
  HermesSkillInjector.resolveTargetDirForProfile = skillInjectorMocks.resolveTargetDirForProfile
  return { HermesSkillInjector }
})

vi.mock('../../packages/server/src/services/hermes/session-deleter', () => ({
  SessionDeleter: {
    getInstance: vi.fn(() => sessionDeleterMocks),
  },
}))

vi.mock('../../packages/server/src/db/hermes/users-store', () => ({
  listUserProfiles: usersStoreMocks.listUserProfiles,
}))

vi.mock('../../packages/server/src/services/hermes/gateway-autostart', () => ({
  getGatewayRuntimeStatusForProfile: gatewayAutostartMocks.getGatewayRuntimeStatusForProfile,
  prepareGatewayForProfileDelete: gatewayAutostartMocks.prepareGatewayForProfileDelete,
  restartGatewayForProfile: gatewayAutostartMocks.restartGatewayForProfile,
}))

import * as hermesCli from '../../packages/server/src/services/hermes/hermes-cli'

describe('Profile Routes', () => {
  const originalHermesHome = process.env.HERMES_HOME
  const originalWebUiHome = process.env.HERMES_WEB_UI_HOME
  const originalMultitenancyDb = process.env.HERMES_MULTITENANCY_DB
  const originalRunBrokerUrl = process.env.HERMES_RUN_BROKER_URL
  const originalRunBrokerKey = process.env.HERMES_RUN_BROKER_KEY
  const originalAuthMode = process.env.HERMES_AUTH_MODE
  const originalWebPlane = process.env.HERMES_WEB_PLANE
  const tempHomes: string[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    agentBridgeMocks.destroyProfile.mockResolvedValue({ destroyed: 0 })
    gatewayAutostartMocks.prepareGatewayForProfileDelete.mockResolvedValue(undefined)
    skillInjectorMocks.injectMissingSkills.mockResolvedValue({ targets: [] })
    skillInjectorMocks.resolveTargetDirForProfile.mockImplementation((name: string) => join('/tmp/hermes-skills', name))
    usersStoreMocks.listUserProfiles.mockReturnValue([])
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
    else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
    if (originalMultitenancyDb === undefined) delete process.env.HERMES_MULTITENANCY_DB
    else process.env.HERMES_MULTITENANCY_DB = originalMultitenancyDb
    if (originalRunBrokerUrl === undefined) delete process.env.HERMES_RUN_BROKER_URL
    else process.env.HERMES_RUN_BROKER_URL = originalRunBrokerUrl
    if (originalRunBrokerKey === undefined) delete process.env.HERMES_RUN_BROKER_KEY
    else process.env.HERMES_RUN_BROKER_KEY = originalRunBrokerKey
    if (originalAuthMode === undefined) delete process.env.HERMES_AUTH_MODE
    else process.env.HERMES_AUTH_MODE = originalAuthMode
    if (originalWebPlane === undefined) delete process.env.HERMES_WEB_PLANE
    else process.env.HERMES_WEB_PLANE = originalWebPlane
    vi.doUnmock('../../packages/server/src/services/hermes/agent-ownership')
    vi.resetModules()
    await Promise.all(tempHomes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  describe('hermes-cli wrapper', () => {
    it('listProfiles returns array', async () => {
      const mockProfiles = [{ name: 'default', active: true }]
      vi.mocked(hermesCli.listProfiles).mockResolvedValue(mockProfiles as any)

      const result = await hermesCli.listProfiles()
      expect(result).toEqual(mockProfiles)
    })

    it('getProfile returns profile detail', async () => {
      const mockDetail = { name: 'default', path: '/tmp/default' }
      vi.mocked(hermesCli.getProfile).mockResolvedValue(mockDetail as any)

      const result = await hermesCli.getProfile('default')
      expect(result).toEqual(mockDetail)
      expect(hermesCli.getProfile).toHaveBeenCalledWith('default')
    })

    it('createProfile calls CLI with name and clone flag', async () => {
      vi.mocked(hermesCli.createProfile).mockResolvedValue('Profile created')

      await hermesCli.createProfile('test', true)

      expect(hermesCli.createProfile).toHaveBeenCalledWith('test', true)
    })

    it('clone creation copies only the configured model provider auth for the new profile', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-clone-auth-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      await writeFile(join(hermesHome, 'active_profile'), 'default\n', 'utf-8')
      await writeFile(join(hermesHome, 'auth.json'), JSON.stringify({
        providers: {
          'openai-codex': { access_token: 'codex-provider-token' },
          anthropic: { access_token: 'anthropic-provider-token' },
        },
        credential_pool: {
          'openai-codex': [{ access_token: 'codex-pool-token' }],
          anthropic: [{ access_token: 'anthropic-pool-token' }],
        },
      }, null, 2), 'utf-8')
      vi.mocked(hermesCli.createProfile).mockImplementation(async (name: string) => {
        const profileDir = join(hermesHome, 'profiles', name)
        await mkdir(profileDir, { recursive: true })
        await writeFile(join(profileDir, 'config.yaml'), [
          'model:',
          '  provider: openai-codex',
          '  default: gpt-5.5',
          '',
        ].join('\n'), 'utf-8')
        return 'Profile created'
      })
      const { create } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = {
        request: { body: { name: 'cloned', clone: true } },
        status: 200,
        body: undefined,
      }

      await create(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.copiedAuthProviders).toEqual(['openai-codex'])
      const clonedAuth = JSON.parse(readFileSync(join(hermesHome, 'profiles', 'cloned', 'auth.json'), 'utf-8'))
      expect(clonedAuth.providers['openai-codex']).toEqual({ access_token: 'codex-provider-token' })
      expect(clonedAuth.credential_pool['openai-codex']).toEqual([{ access_token: 'codex-pool-token' }])
      expect(clonedAuth.providers.anthropic).toBeUndefined()
      expect(clonedAuth.credential_pool.anthropic).toBeUndefined()
    })

    it('deleteProfile calls CLI with name', async () => {
      vi.mocked(hermesCli.deleteProfile).mockResolvedValue(true)

      await hermesCli.deleteProfile('test')

      expect(hermesCli.deleteProfile).toHaveBeenCalledWith('test')
    })

    it('renameProfile calls CLI with old and new name', async () => {
      vi.mocked(hermesCli.renameProfile).mockResolvedValue(true)

      await hermesCli.renameProfile('old', 'new')

      expect(hermesCli.renameProfile).toHaveBeenCalledWith('old', 'new')
    })
  })

  describe('profile listing', () => {
    it('lists ordinary user profiles from the authorized profile set without running slow Hermes CLI list', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-fast-list-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      await mkdir(join(hermesHome, 'profiles', 'feishu_user_a'), { recursive: true })
      await writeFile(join(hermesHome, 'profiles', 'feishu_user_a', 'config.yaml'), 'model:\n  default: personal-model\n', 'utf-8')
      await mkdir(join(hermesHome, 'profiles', 'group_agent_a'), { recursive: true })
      await writeFile(join(hermesHome, 'profiles', 'group_agent_a', 'config.yaml'), 'model:\n  default: group-model\n', 'utf-8')
      await writeFile(join(hermesHome, 'active_profile'), 'feishu_user_a\n', 'utf-8')
      usersStoreMocks.listUserProfiles.mockReturnValue([
        { user_id: 7, profile_name: 'feishu_user_a', is_default: 1, created_at: 1 },
        { user_id: 7, profile_name: 'group_agent_a', is_default: 0, created_at: 1 },
      ])
      vi.mocked(hermesCli.listProfiles).mockRejectedValue(new Error('slow profile list should not run'))
      const { list } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = {
        state: {
          user: { id: 7, role: 'user' },
          profile: { name: 'group_agent_a' },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await list(ctx)

      expect(hermesCli.listProfiles).not.toHaveBeenCalled()
      expect(ctx.status).toBe(200)
      expect(ctx.body.profiles.map((profile: any) => profile.name)).toEqual(['feishu_user_a', 'group_agent_a'])
      expect(ctx.body.profiles.find((profile: any) => profile.name === 'group_agent_a')?.active).toBe(true)
    })

    it('appends broker shared agents for Feishu users without adding them to user_profiles', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-shared-agents-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      process.env.HERMES_RUN_BROKER_URL = 'http://broker.test'
      process.env.HERMES_RUN_BROKER_KEY = 'broker-key'
      await mkdir(join(hermesHome, 'profiles', 'feishu_user_a'), { recursive: true })
      await writeFile(join(hermesHome, 'profiles', 'feishu_user_a', 'config.yaml'), 'model:\n  default: personal-model\n', 'utf-8')
      await writeFile(join(hermesHome, 'active_profile'), 'feishu_user_a\n', 'utf-8')
      usersStoreMocks.listUserProfiles.mockReturnValue([
        { user_id: 7, profile_name: 'feishu_user_a', is_default: 1, created_at: 1 },
      ])
      vi.stubGlobal('fetch', vi.fn(async (url: string, options: any) => {
        expect(url).toBe('http://broker.test/api/run-broker/agents/shared')
        expect(options.headers.Authorization).toBe('Bearer broker-key')
        expect(options.headers['X-Hermes-Owner-Open-Id']).toBe('ou_viewer')
        return new Response(JSON.stringify({
          agents: [{
            agent_id: 'agent-shared',
            profile_name: 'owned_agent_profile',
            owner_open_id: 'ou_owner',
            display_label: 'Shared analyst',
            role: 'editor',
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }))
      vi.resetModules()
      const { list } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = {
        state: {
          user: { id: 7, role: 'user', openid: 'ou_viewer' },
          profile: { name: 'feishu_user_a' },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await list(ctx)

      expect(ctx.body.profiles.map((profile: any) => profile.name)).toEqual(['feishu_user_a', 'owned_agent_profile'])
      expect(ctx.body.profiles[1]).toEqual(expect.objectContaining({
        name: 'owned_agent_profile',
        kind: 'agent',
        agentId: 'agent-shared',
        ownerOpenId: 'ou_owner',
        shareRole: 'editor',
        displayLabel: 'Shared analyst',
      }))
      expect(usersStoreMocks.listUserProfiles).toHaveBeenCalled()
    })

    it('merges owned agent metadata into the authorized profile list', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-owned-agent-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      const dbPath = join(hermesHome, 'multitenancy.db')
      process.env.HERMES_MULTITENANCY_DB = dbPath
      await mkdir(join(hermesHome, 'profiles', 'owned_agent_profile'), { recursive: true })
      await writeFile(join(hermesHome, 'profiles', 'owned_agent_profile', 'config.yaml'), 'model:\n  default: shared-model\n', 'utf-8')
      await writeFile(join(hermesHome, 'active_profile'), 'owned_agent_profile\n', 'utf-8')
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(dbPath)
      try {
        db.exec(`
          CREATE TABLE multitenancy_routing (
            user_id TEXT PRIMARY KEY,
            profile_name TEXT NOT NULL,
            open_id TEXT,
            active INTEGER NOT NULL DEFAULT 1,
            kind TEXT,
            owner_open_id TEXT,
            display_label TEXT,
            agent_id TEXT
          )
        `)
        db.prepare(`
          INSERT INTO multitenancy_routing (user_id, profile_name, open_id, active, kind, owner_open_id, display_label, agent_id)
          VALUES (?, ?, ?, 1, 'agent', ?, ?, ?)
        `).run('webui:ou_owner:owned_agent_profile', 'owned_agent_profile', 'webui:ou_owner:owned_agent_profile', 'ou_owner', 'Owner agent', 'agent-owned')
      } finally {
        db.close()
      }
      usersStoreMocks.listUserProfiles.mockReturnValue([
        { user_id: 7, profile_name: 'owned_agent_profile', is_default: 1, created_at: 1 },
      ])
      vi.mocked(hermesCli.listProfiles).mockRejectedValue(new Error('slow profile list should not run'))
      vi.resetModules()
      const { list } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = {
        state: {
          user: { id: 7, role: 'user', openid: 'ou_owner' },
          profile: { name: 'owned_agent_profile' },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await list(ctx)

      expect(ctx.body.profiles[0]).toEqual(expect.objectContaining({
        name: 'owned_agent_profile',
        kind: 'agent',
        agentId: 'agent-owned',
        ownerOpenId: 'ou_owner',
        displayLabel: 'Owner agent',
      }))
    })

    it('lets ordinary Feishu users create, list, and switch to their owner-scoped agent profile', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-create-agent-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      process.env.HERMES_AUTH_MODE = 'trusted-feishu'
      delete process.env.HERMES_WEB_PLANE
      const dbPath = join(hermesHome, 'multitenancy.db')
      process.env.HERMES_MULTITENANCY_DB = dbPath
      const userProfileDir = join(hermesHome, 'profiles', 'feishu_user_a')
      await mkdir(userProfileDir, { recursive: true })
      await writeFile(join(userProfileDir, 'config.yaml'), 'model:\n  default: personal-model\n', 'utf-8')
      await writeFile(join(hermesHome, 'active_profile'), 'feishu_user_a\n', 'utf-8')
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(dbPath)
      try {
        db.exec(`
          CREATE TABLE multitenancy_routing (
            user_id TEXT PRIMARY KEY,
            profile_name TEXT NOT NULL,
            open_id TEXT,
            active INTEGER NOT NULL DEFAULT 1,
            kind TEXT,
            owner_open_id TEXT,
            provenance TEXT,
            display_label TEXT,
            agent_id TEXT,
            upstream_profile TEXT
          )
        `)
      } finally {
        db.close()
      }
      usersStoreMocks.listUserProfiles.mockReturnValue([
        { user_id: 7, profile_name: 'feishu_user_a', is_default: 1, created_at: 1 },
      ])
      vi.mocked(hermesCli.createProfile).mockImplementation(async (name: string) => {
        const profileDir = join(hermesHome, 'profiles', name)
        await mkdir(profileDir, { recursive: true })
        await writeFile(join(profileDir, 'config.yaml'), 'model:\n  default: web-agent-model\n', 'utf-8')
        return `Profile ${name} created`
      })
      vi.mocked(hermesCli.useProfile).mockImplementation(async (name: string) => {
        await writeFile(join(hermesHome, 'active_profile'), `${name}\n`, 'utf-8')
        return `Switched to profile ${name}`
      })
      vi.mocked(hermesCli.getProfile).mockImplementation(async (name: string) => ({
        name,
        path: join(hermesHome, 'profiles', name),
        model: 'web-agent-model',
        provider: 'test',
        skills: 0,
        hasEnv: false,
        hasSoulMd: false,
      }) as any)
      vi.resetModules()
      const { create, list, switchProfile } = await import('../../packages/server/src/controllers/hermes/profiles')
      const user = {
        id: 7,
        role: 'user',
        openid: 'ou_user_a',
        profile: 'feishu_user_a',
        profiles: ['feishu_user_a'],
      }

      const createCtx: any = {
        state: { user, profile: { name: 'feishu_user_a' } },
        request: { body: { name: 'web_agent', clone: true } },
        status: 200,
        body: undefined,
      }
      await create(createCtx)

      expect(createCtx.status).toBe(200)
      expect(hermesCli.createProfile).toHaveBeenCalledWith('web_agent', false)
      const rowDb = new DatabaseSync(dbPath, { readOnly: true })
      try {
        expect(rowDb.prepare(`
          SELECT profile_name, kind, owner_open_id, provenance, display_label, agent_id, upstream_profile
          FROM multitenancy_routing
          WHERE user_id = ?
        `).get('webui:ou_user_a:web_agent')).toEqual({
          profile_name: 'web_agent',
          kind: 'agent',
          owner_open_id: 'ou_user_a',
          provenance: 'webui-agent',
          display_label: 'web_agent',
          agent_id: 'webui:ou_user_a:web_agent',
          upstream_profile: 'feishu_user_a',
        })
      } finally {
        rowDb.close()
      }

      const listCtx: any = {
        state: { user, profile: { name: 'feishu_user_a' } },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }
      await list(listCtx)

      expect(listCtx.status).toBe(200)
      expect(listCtx.body.profiles.map((profile: any) => profile.name)).toEqual(['feishu_user_a', 'web_agent'])
      expect(listCtx.body.profiles.find((profile: any) => profile.name === 'web_agent')).toEqual(expect.objectContaining({
        kind: 'agent',
        agentId: 'webui:ou_user_a:web_agent',
        ownerOpenId: 'ou_user_a',
        displayLabel: 'web_agent',
      }))

      const switchCtx: any = {
        state: { user, profile: { name: 'feishu_user_a' } },
        request: { body: { name: 'web_agent' } },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }
      await switchProfile(switchCtx)

      expect(switchCtx.status).toBe(200)
      expect(switchCtx.body).toMatchObject({ success: true, active: 'web_agent' })
      expect(sessionDeleterMocks.switchProfile).toHaveBeenCalledWith('web_agent')
    })

    it('does not report chat-plane create success when owner registration cannot be persisted', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-create-agent-unregistered-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      process.env.HERMES_AUTH_MODE = 'trusted-feishu'
      delete process.env.HERMES_WEB_PLANE
      const dbPath = join(hermesHome, 'multitenancy.db')
      process.env.HERMES_MULTITENANCY_DB = dbPath
      await writeFile(join(hermesHome, 'active_profile'), 'feishu_user_a\n', 'utf-8')
      vi.mocked(hermesCli.createProfile).mockImplementation(async (name: string) => {
        const profileDir = join(hermesHome, 'profiles', name)
        await mkdir(profileDir, { recursive: true })
        await writeFile(join(profileDir, 'config.yaml'), 'model:\n  default: web-agent-model\n', 'utf-8')
        return `Profile ${name} created`
      })
      vi.mocked(hermesCli.deleteProfile).mockResolvedValue(true)
      vi.doMock('../../packages/server/src/services/hermes/agent-ownership', () => ({
        listOwnedProfileMetadata: vi.fn(() => new Map()),
        registerOwnedProfile: vi.fn(() => false),
      }))
      vi.resetModules()
      const { create } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = {
        state: {
          user: {
            id: 7,
            role: 'user',
            openid: 'ou_user_a',
            profile: 'feishu_user_a',
            profiles: ['feishu_user_a'],
          },
          profile: { name: 'feishu_user_a' },
        },
        request: { body: { name: 'unregistered_agent', clone: true } },
        status: 200,
        body: undefined,
      }

      await create(ctx)

      expect(hermesCli.createProfile).toHaveBeenCalledWith('unregistered_agent', false)
      expect(hermesCli.deleteProfile).toHaveBeenCalledWith('unregistered_agent')
      expect(ctx.status).toBe(500)
      expect(ctx.body).toEqual({ error: 'Failed to register created profile ownership' })
    })
  })

  describe('profile rename validation', () => {
    it('rejects reserved profile names before calling Hermes CLI', async () => {
      vi.mocked(hermesCli.renameProfile).mockResolvedValue(true)
      const { rename } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = {
        params: { name: 'work' },
        request: { body: { new_name: 'hermes' } },
        status: 200,
        body: undefined,
      }

      await rename(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body).toEqual({ error: "Profile name 'hermes' is reserved and cannot be used" })
      expect(hermesCli.renameProfile).not.toHaveBeenCalled()
    })
  })

  describe('profile deletion fallback', () => {
    it('prepares the profile gateway for deletion before calling Hermes CLI delete', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-delete-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      const profileDir = join(hermesHome, 'profiles', 'work')
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(profileDir, 'config.yaml'), 'model:\n  default: test\n', 'utf-8')

      gatewayAutostartMocks.prepareGatewayForProfileDelete.mockImplementation(async () => {
        await rm(profileDir, { recursive: true, force: true })
      })
      vi.mocked(hermesCli.deleteProfile).mockResolvedValue(true)
      const { remove } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = { params: { name: 'work' }, status: 200, body: undefined }

      await remove(ctx)

      expect(gatewayAutostartMocks.prepareGatewayForProfileDelete).toHaveBeenCalledWith('work')
      expect(hermesCli.deleteProfile).toHaveBeenCalledWith('work')
      expect(ctx.status).toBe(200)
      expect(ctx.body).toEqual({ success: true })
    })

    it('does not return success when Hermes CLI reports delete success but the profile directory remains', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-delete-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      const profileDir = join(hermesHome, 'profiles', 'work')
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(profileDir, 'config.yaml'), 'model:\n  default: test\n', 'utf-8')
      vi.mocked(hermesCli.deleteProfile).mockResolvedValue(true)
      const { remove } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = { params: { name: 'work' }, status: 200, body: undefined }

      await remove(ctx)

      expect(ctx.status).toBe(500)
      expect(ctx.body).toEqual({ error: 'Failed to delete profile: profile directory still exists' })
      expect(existsSync(profileDir)).toBe(true)
    })

    it('removes a reserved profile directory when Hermes CLI refuses to delete it', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-delete-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      const badProfileDir = join(hermesHome, 'profiles', 'hermes')
      await mkdir(badProfileDir, { recursive: true })
      await writeFile(join(badProfileDir, 'config.yaml'), 'model:\n  default: bad\n', 'utf-8')
      await writeFile(join(hermesHome, 'active_profile'), 'hermes\n', 'utf-8')
      vi.mocked(hermesCli.deleteProfile).mockResolvedValue(false)
      const { remove } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = { params: { name: 'hermes' }, status: 200, body: undefined }

      await remove(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toEqual({ success: true, fallback: 'removed_reserved_profile_from_disk' })
      expect(existsSync(badProfileDir)).toBe(false)
      expect(readFileSync(join(hermesHome, 'active_profile'), 'utf-8')).toBe('default\n')
    })

    it('does not bypass Hermes CLI failures for normal profile names', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-delete-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      const profileDir = join(hermesHome, 'profiles', 'work')
      await mkdir(profileDir, { recursive: true })
      vi.mocked(hermesCli.deleteProfile).mockResolvedValue(false)
      const { remove } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = { params: { name: 'work' }, status: 200, body: undefined }

      await remove(ctx)

      expect(ctx.status).toBe(500)
      expect(ctx.body).toEqual({ error: 'Failed to delete profile' })
      expect(existsSync(profileDir)).toBe(true)
    })
  })

  describe('Hermes CLI active profile switch', () => {
    it('only destroys bridge sessions for the target profile', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-switch-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      const profileDir = join(hermesHome, 'profiles', 'work')
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(profileDir, 'config.yaml'), 'model:\n  default: gpt-test\n', 'utf-8')
      await writeFile(join(hermesHome, 'active_profile'), 'work\n', 'utf-8')
      vi.mocked(hermesCli.useProfile).mockResolvedValue('Switched to work')
      vi.mocked(hermesCli.getProfile).mockResolvedValue({
        name: 'work',
        path: profileDir,
        model: 'gpt-test',
        provider: 'test',
        skills: 0,
        hasEnv: false,
        hasSoulMd: false,
      } as any)
      agentBridgeMocks.destroyProfile.mockResolvedValue({ destroyed: 2 })
      const { switchProfile } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = {
        request: { body: { name: 'work' } },
        status: 200,
        body: undefined,
      }

      await switchProfile(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toMatchObject({ success: true, active: 'work' })
      expect(agentBridgeMocks.destroyProfile).toHaveBeenCalledWith('work')
      expect(agentBridgeMocks.destroyAll).not.toHaveBeenCalled()
      expect(sessionDeleterMocks.switchProfile).toHaveBeenCalledWith('work')
    })
  })

  describe('profile avatars', () => {
    it('uses the authenticated Feishu user avatar for the matching user profile when no custom avatar exists', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-feishu-user-avatar-'))
      const webUiHome = await mkdtemp(join(tmpdir(), 'hermes-web-ui-avatar-'))
      tempHomes.push(hermesHome, webUiHome)
      process.env.HERMES_HOME = hermesHome
      process.env.HERMES_WEB_UI_HOME = webUiHome
      await mkdir(join(hermesHome, 'profiles', 'feishu_user_a'), { recursive: true })
      await writeFile(join(hermesHome, 'profiles', 'feishu_user_a', 'config.yaml'), 'model:\n  default: personal-model\n', 'utf-8')
      await writeFile(join(hermesHome, 'active_profile'), 'feishu_user_a\n', 'utf-8')
      usersStoreMocks.listUserProfiles.mockReturnValue([
        { user_id: 7, profile_name: 'feishu_user_a', is_default: 1, created_at: 1 },
      ])
      vi.mocked(hermesCli.listProfiles).mockRejectedValue(new Error('slow profile list should not run'))
      const { list } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = {
        state: {
          user: {
            id: 7,
            role: 'admin',
            openid: 'ou_user_a',
            profile: 'feishu_user_a',
            avatarUrl: 'https://example.com/user-avatar.png',
            profiles: ['feishu_user_a'],
          },
          profile: { name: 'feishu_user_a' },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await list(ctx)

      expect(hermesCli.listProfiles).not.toHaveBeenCalled()
      expect(ctx.status).toBe(200)
      expect(ctx.body.profiles).toHaveLength(1)
      expect(ctx.body.profiles[0].avatar).toEqual({
        type: 'url',
        url: 'https://example.com/user-avatar.png',
        source: 'feishu_user',
      })
    })

    it('uses Feishu Open Platform chat avatar for group profiles when no custom avatar exists', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-feishu-group-avatar-'))
      const webUiHome = await mkdtemp(join(tmpdir(), 'hermes-web-ui-avatar-'))
      tempHomes.push(hermesHome, webUiHome)
      process.env.HERMES_HOME = hermesHome
      process.env.HERMES_WEB_UI_HOME = webUiHome
      const profileDir = join(hermesHome, 'profiles', 'feishu_group_alpha')
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(hermesHome, 'active_profile'), 'feishu_group_alpha\n', 'utf-8')
      await writeFile(join(profileDir, 'group_profile.json'), JSON.stringify({
        kind: 'group',
        chat_id: 'oc_group_alpha',
        owner_open_id: 'ou_user_a',
        display_label: 'Owner-Alpha',
      }), 'utf-8')
      await writeFile(join(profileDir, 'config.yaml'), [
        'model:',
        '  default: group-model',
        'platforms:',
        '  feishu:',
        '    enabled: true',
        '    extra:',
        '      app_id: cli_fake_app',
        '      app_secret: fake-secret',
        '',
      ].join('\n'), 'utf-8')
      usersStoreMocks.listUserProfiles.mockReturnValue([
        { user_id: 7, profile_name: 'feishu_group_alpha', is_default: 1, created_at: 1 },
      ])
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/open-apis/auth/v3/tenant_access_token/internal')) {
          expect(init?.method).toBe('POST')
          expect(String(init?.body)).toContain('cli_fake_app')
          return new Response(JSON.stringify({
            code: 0,
            tenant_access_token: 'tenant-token',
            expire: 7200,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (url.includes('/open-apis/im/v1/chats/oc_group_alpha')) {
          expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tenant-token')
          return new Response(JSON.stringify({
            code: 0,
            data: {
              avatar: 'https://example.com/group-avatar.png',
              name: 'Alpha',
            },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        throw new Error(`unexpected fetch ${url}`)
      })
      vi.stubGlobal('fetch', fetchMock)
      vi.mocked(hermesCli.listProfiles).mockRejectedValue(new Error('slow profile list should not run'))
      const { list } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = {
        state: {
          user: {
            id: 7,
            role: 'admin',
            openid: 'ou_user_a',
            profile: 'feishu_user_a',
            avatarUrl: 'https://example.com/user-avatar.png',
            profiles: ['feishu_group_alpha'],
          },
          profile: { name: 'feishu_group_alpha' },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await list(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.profiles).toHaveLength(1)
      expect(ctx.body.profiles[0].avatar).toEqual({
        type: 'url',
        url: 'https://example.com/group-avatar.png',
        source: 'feishu_group',
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(JSON.stringify(ctx.body)).not.toContain('fake-secret')
      expect(JSON.stringify(ctx.body)).not.toContain('tenant-token')
    })

    it('falls back to no explicit avatar when Feishu Open Platform chat avatar lookup fails', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-feishu-group-avatar-fail-'))
      const webUiHome = await mkdtemp(join(tmpdir(), 'hermes-web-ui-avatar-'))
      tempHomes.push(hermesHome, webUiHome)
      process.env.HERMES_HOME = hermesHome
      process.env.HERMES_WEB_UI_HOME = webUiHome
      const profileDir = join(hermesHome, 'profiles', 'feishu_group_lookup_fail')
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(hermesHome, 'active_profile'), 'feishu_group_lookup_fail\n', 'utf-8')
      await writeFile(join(profileDir, 'group_profile.json'), JSON.stringify({
        kind: 'group',
        chat_id: 'oc_group_lookup_fail',
      }), 'utf-8')
      await writeFile(join(profileDir, 'config.yaml'), [
        'model:',
        '  default: group-model',
        'platforms:',
        '  feishu:',
        '    enabled: true',
        '    extra:',
        '      app_id: cli_fake_fail_app',
        '      app_secret: fake-fail-secret',
        '',
      ].join('\n'), 'utf-8')
      usersStoreMocks.listUserProfiles.mockReturnValue([
        { user_id: 7, profile_name: 'feishu_group_lookup_fail', is_default: 1, created_at: 1 },
      ])
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes('/open-apis/auth/v3/tenant_access_token/internal')) {
          return new Response(JSON.stringify({
            code: 0,
            tenant_access_token: 'tenant-token-fail',
            expire: 7200,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (url.includes('/open-apis/im/v1/chats/oc_group_lookup_fail')) {
          return new Response(JSON.stringify({
            code: 230001,
            msg: 'chat not found',
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        throw new Error(`unexpected fetch ${url}`)
      })
      vi.stubGlobal('fetch', fetchMock)
      vi.mocked(hermesCli.listProfiles).mockRejectedValue(new Error('slow profile list should not run'))
      const { list } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = {
        state: {
          user: {
            id: 7,
            role: 'admin',
            openid: 'ou_user_a',
            profile: 'feishu_user_a',
            profiles: ['feishu_group_lookup_fail'],
          },
          profile: { name: 'feishu_group_lookup_fail' },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await list(ctx)
      await list(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.profiles[0].avatar).toBeNull()
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(JSON.stringify(ctx.body)).not.toContain('fake-fail-secret')
      expect(JSON.stringify(ctx.body)).not.toContain('tenant-token-fail')
    })

    it('keeps a custom avatar ahead of Feishu group avatar lookup', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-custom-avatar-priority-'))
      const webUiHome = await mkdtemp(join(tmpdir(), 'hermes-web-ui-avatar-'))
      tempHomes.push(hermesHome, webUiHome)
      process.env.HERMES_HOME = hermesHome
      process.env.HERMES_WEB_UI_HOME = webUiHome
      const profileName = 'feishu_group_custom_avatar'
      const profileDir = join(hermesHome, 'profiles', profileName)
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(hermesHome, 'active_profile'), `${profileName}\n`, 'utf-8')
      await writeFile(join(profileDir, 'group_profile.json'), JSON.stringify({
        kind: 'group',
        chat_id: 'oc_group_custom_avatar',
      }), 'utf-8')
      await writeFile(join(profileDir, 'config.yaml'), [
        'model:',
        '  default: group-model',
        'platforms:',
        '  feishu:',
        '    enabled: true',
        '    extra:',
        '      app_id: cli_fake_custom_app',
        '      app_secret: fake-custom-secret',
        '',
      ].join('\n'), 'utf-8')
      const metadataDir = join(webUiHome, 'profile-metadata', Buffer.from(profileName, 'utf-8').toString('base64url'))
      await mkdir(metadataDir, { recursive: true })
      await writeFile(join(metadataDir, 'avatar.json'), JSON.stringify({
        type: 'generated',
        seed: 'custom-seed',
        updatedAt: 123,
      }), 'utf-8')
      usersStoreMocks.listUserProfiles.mockReturnValue([
        { user_id: 7, profile_name: profileName, is_default: 1, created_at: 1 },
      ])
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      vi.mocked(hermesCli.listProfiles).mockRejectedValue(new Error('slow profile list should not run'))
      const { list } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = {
        state: {
          user: {
            id: 7,
            role: 'admin',
            openid: 'ou_user_a',
            profile: 'feishu_user_a',
            profiles: [profileName],
          },
          profile: { name: profileName },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await list(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.profiles[0].avatar).toEqual({
        type: 'generated',
        seed: 'custom-seed',
        updatedAt: 123,
      })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('stores generated avatar metadata under the Web UI home', async () => {
      const webUiHome = await mkdtemp(join(tmpdir(), 'hermes-web-ui-avatar-'))
      tempHomes.push(webUiHome)
      process.env.HERMES_WEB_UI_HOME = webUiHome
      const { updateAvatar } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = {
        params: { name: 'work' },
        request: { body: { type: 'generated', seed: 'custom-seed' } },
        status: 200,
        body: undefined,
      }

      await updateAvatar(ctx)

      const metaPath = join(webUiHome, 'profile-metadata', Buffer.from('work', 'utf-8').toString('base64url'), 'avatar.json')
      expect(ctx.status).toBe(200)
      expect(ctx.body.avatar).toMatchObject({ type: 'generated', seed: 'custom-seed' })
      expect(JSON.parse(readFileSync(metaPath, 'utf-8'))).toMatchObject({
        type: 'generated',
        seed: 'custom-seed',
      })
    })

    it('stores uploaded image avatars and returns a data URL', async () => {
      const webUiHome = await mkdtemp(join(tmpdir(), 'hermes-web-ui-avatar-'))
      tempHomes.push(webUiHome)
      process.env.HERMES_WEB_UI_HOME = webUiHome
      const dataUrl = `data:image/png;base64,${Buffer.from('avatar-png').toString('base64')}`
      const { updateAvatar } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = {
        params: { name: 'work' },
        request: { body: { type: 'image', dataUrl } },
        status: 200,
        body: undefined,
      }

      await updateAvatar(ctx)

      const dir = join(webUiHome, 'profile-metadata', Buffer.from('work', 'utf-8').toString('base64url'))
      const meta = JSON.parse(readFileSync(join(dir, 'avatar.json'), 'utf-8'))
      expect(ctx.status).toBe(200)
      expect(ctx.body.avatar).toMatchObject({ type: 'image', dataUrl })
      expect(meta).toMatchObject({ type: 'image', file: 'avatar.bin', mime: 'image/png' })
      expect(readFileSync(join(dir, 'avatar.bin')).toString()).toBe('avatar-png')
    })

    it('deletes profile avatar metadata', async () => {
      const webUiHome = await mkdtemp(join(tmpdir(), 'hermes-web-ui-avatar-'))
      tempHomes.push(webUiHome)
      process.env.HERMES_WEB_UI_HOME = webUiHome
      const metadataDir = join(webUiHome, 'profile-metadata', Buffer.from('work', 'utf-8').toString('base64url'))
      await mkdir(metadataDir, { recursive: true })
      await writeFile(join(metadataDir, 'avatar.json'), '{"type":"generated"}\n', 'utf-8')
      const { deleteAvatar } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = { params: { name: 'work' }, status: 200, body: undefined }

      await deleteAvatar(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toEqual({ success: true })
      expect(existsSync(metadataDir)).toBe(false)
    })
  })
})
