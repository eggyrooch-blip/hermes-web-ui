import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const originalEnv = process.env
let baseDir = ''

function writeYaml(path: string, content: string) {
  writeFileSync(path, content.trimStart(), 'utf-8')
}

function mockCtx(overrides: Record<string, any> = {}) {
  return {
    path: '',
    method: 'GET',
    status: 200,
    body: undefined,
    query: {},
    params: {},
    request: { body: {} },
    state: {
      user: {
        openid: 'ou_test',
        profile: 'g41a5b5g',
        role: 'user',
      },
    },
    get: () => '',
    set: vi.fn(),
    ...overrides,
  } as any
}

async function invokeFileRoute(method: string, path: string, ctx: any) {
  const { fileRoutes } = await import('../../packages/server/src/routes/hermes/files')
  const layer = (fileRoutes as any).stack.find((item: any) => (
    item.path === path && item.methods.includes(method.toUpperCase())
  ))
  expect(layer, `${method} ${path}`).toBeTruthy()
  await layer.stack[layer.stack.length - 1](ctx, async () => {})
}

async function invokeDownloadRoute(ctx: any) {
  const { downloadRoutes } = await import('../../packages/server/src/routes/hermes/download')
  const layer = (downloadRoutes as any).stack.find((item: any) => (
    item.path === '/api/hermes/download' && item.methods.includes('GET')
  ))
  expect(layer, 'GET /api/hermes/download').toBeTruthy()
  await layer.stack[layer.stack.length - 1](ctx, async () => {})
}

function multipartBody(filename: string, content: string): { body: Buffer; contentType: string } {
  const boundary = '----hermes-web-ui-test-boundary'
  const body = Buffer.from([
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    'Content-Type: text/plain',
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n'))
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

function mockUploadCtx(body: Buffer, contentType: string) {
  const ctx = mockCtx({
    req: {
      async *[Symbol.asyncIterator]() {
        yield body
      },
    },
    get: (header: string) => header.toLowerCase() === 'content-type' ? contentType : '',
  })
  return ctx
}

async function writeStateDb(profileDir: string, rows: Array<{
  id: string
  model: string
  input_tokens: number
  output_tokens: number
  actual_cost_usd: number
  api_call_count: number
}>) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(profileDir, 'state.db'))
  try {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT,
        model TEXT,
        started_at INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        reasoning_tokens INTEGER,
        estimated_cost_usd REAL,
        actual_cost_usd REAL,
        api_call_count INTEGER
      )
    `)
    const insert = db.prepare(`
      INSERT INTO sessions (
        id, source, model, started_at, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens,
        estimated_cost_usd, actual_cost_usd, api_call_count
      ) VALUES (?, 'chat', ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)
    `)
    const now = Math.floor(Date.now() / 1000)
    for (const row of rows) {
      insert.run(row.id, row.model, now, row.input_tokens, row.output_tokens, row.actual_cost_usd, row.actual_cost_usd, row.api_call_count)
    }
  } finally {
    db.close()
  }
}

describe('chat plane user-mode controllers', () => {
  beforeEach(() => {
    vi.resetModules()
    baseDir = mkdtempSync(join(tmpdir(), 'hermes-web-ui-user-mode-'))
    mkdirSync(join(baseDir, 'profiles', 'g41a5b5g', 'memories'), { recursive: true })
    writeYaml(join(baseDir, 'config.yaml'), `
display:
  compact: false
platforms:
  feishu:
    extra:
      app_secret: root-secret
model:
  default: root-model
`)
    writeYaml(join(baseDir, 'profiles', 'g41a5b5g', 'config.yaml'), `
display:
  compact: true
agent:
  max_turns: 8
platforms:
  feishu:
    extra:
      app_secret: profile-secret
model:
  default: profile-model
custom_providers:
  - name: secret-provider
    api_key: provider-secret
`)
    process.env = {
      ...originalEnv,
      HERMES_HOME: baseDir,
      HERMES_WEB_PLANE: 'chat',
    }
  })

  afterEach(() => {
    process.env = originalEnv
    if (baseDir) rmSync(baseDir, { recursive: true, force: true })
  })

  it('serves only safe settings from the bound profile in chat plane', async () => {
    const { getConfig } = await import('../../packages/server/src/controllers/hermes/config')
    const ctx = mockCtx()

    await getConfig(ctx)

    expect(ctx.body).toEqual({
      display: { compact: true },
      agent: { max_turns: 8 },
      memory: {},
      session_reset: {},
      privacy: {},
      approvals: {},
    })
  })

  it('writes only safe settings sections to the bound profile in chat plane', async () => {
    const { updateConfig } = await import('../../packages/server/src/controllers/hermes/config')
    const ctx = mockCtx({
      request: { body: { section: 'display', values: { show_reasoning: true } } },
    })

    await updateConfig(ctx)

    const updated = readFileSync(join(baseDir, 'profiles', 'g41a5b5g', 'config.yaml'), 'utf-8')
    expect(ctx.body).toEqual({ success: true })
    expect(updated).toContain('show_reasoning')
    expect(updated).toContain('true')
  })

  it('rejects platform and credential settings in chat plane', async () => {
    const { updateConfig, updateCredentials } = await import('../../packages/server/src/controllers/hermes/config')
    const platformCtx = mockCtx({
      request: { body: { section: 'feishu', values: { extra: { app_secret: 'leak' } } } },
    })
    const credentialsCtx = mockCtx({
      request: { body: { platform: 'feishu', values: { extra: { app_secret: 'leak' } } } },
    })

    await updateConfig(platformCtx)
    await updateCredentials(credentialsCtx)

    expect(platformCtx.status).toBe(403)
    expect(credentialsCtx.status).toBe(403)
  })

  it('rejects default model config writes in chat plane', async () => {
    const { setConfigModel } = await import('../../packages/server/src/controllers/hermes/models')
    const ctx = mockCtx({
      method: 'PUT',
      request: { body: { default: 'root-model', provider: 'secret-provider' } },
    })

    await setConfigModel(ctx)

    expect(ctx.status).toBe(403)
    const updated = readFileSync(join(baseDir, 'profiles', 'g41a5b5g', 'config.yaml'), 'utf-8')
    expect(updated).toContain('default: profile-model')
    expect(updated).not.toContain('root-model')
  })

  it('reads and writes profile memory and SOUL in chat plane', async () => {
    const { get, save } = await import('../../packages/server/src/controllers/hermes/memory')
    writeFileSync(join(baseDir, 'profiles', 'g41a5b5g', 'memories', 'MEMORY.md'), 'profile memory', 'utf-8')
    writeFileSync(join(baseDir, 'profiles', 'g41a5b5g', 'SOUL.md'), 'profile soul', 'utf-8')
    writeFileSync(join(baseDir, 'SOUL.md'), 'root soul', 'utf-8')

    const getCtx = mockCtx()
    await get(getCtx)

    expect(getCtx.body.memory).toBe('profile memory')
    expect(getCtx.body.soul).toBe('profile soul')

    const saveCtx = mockCtx({
      request: { body: { section: 'memory', content: 'updated memory' } },
    })
    await save(saveCtx)
    expect(readFileSync(join(baseDir, 'profiles', 'g41a5b5g', 'memories', 'MEMORY.md'), 'utf-8')).toBe('updated memory')

    const soulCtx = mockCtx({
      request: { body: { section: 'soul', content: 'new system prompt' } },
    })
    await save(soulCtx)
    expect(soulCtx.status).toBe(200)
    expect(readFileSync(join(baseDir, 'profiles', 'g41a5b5g', 'SOUL.md'), 'utf-8')).toBe('new system prompt')
    expect(readFileSync(join(baseDir, 'SOUL.md'), 'utf-8')).not.toBe('new system prompt')
  })

  it('serves usage stats from the bound profile without cost or api-call details in chat plane', async () => {
    await writeStateDb(baseDir, [{
      id: 'root-session',
      model: 'root-model',
      input_tokens: 1000,
      output_tokens: 500,
      actual_cost_usd: 12.34,
      api_call_count: 9,
    }])
    await writeStateDb(join(baseDir, 'profiles', 'g41a5b5g'), [{
      id: 'profile-session',
      model: 'profile-model',
      input_tokens: 20,
      output_tokens: 7,
      actual_cost_usd: 2.5,
      api_call_count: 4,
    }])

    const { usageStats } = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx = mockCtx({ query: { days: '30' } })

    await usageStats(ctx)

    expect(ctx.body.total_input_tokens).toBe(20)
    expect(ctx.body.total_output_tokens).toBe(7)
    expect(ctx.body.total_cost).toBe(0)
    expect(ctx.body.total_api_calls).toBeUndefined()
    expect(ctx.body.model_usage).toEqual([
      expect.objectContaining({ model: 'profile-model', input_tokens: 20, output_tokens: 7 }),
    ])
    expect(ctx.body.model_usage).not.toEqual([
      expect.objectContaining({ model: 'root-model' }),
    ])
    expect(ctx.body.daily_usage.every((row: { cost: number }) => row.cost === 0)).toBe(true)
  })

  it('lists skills from the bound profile without admin-only modified checks in chat plane', async () => {
    const rootSkillDir = join(baseDir, 'skills', 'root-cat', 'root-skill')
    const profileSkillDir = join(baseDir, 'profiles', 'g41a5b5g', 'skills', 'profile-cat', 'profile-skill')
    mkdirSync(rootSkillDir, { recursive: true })
    mkdirSync(profileSkillDir, { recursive: true })
    writeFileSync(join(rootSkillDir, 'SKILL.md'), '# Root\n\nroot only', 'utf-8')
    writeFileSync(join(profileSkillDir, 'SKILL.md'), '# Profile\n\nprofile only', 'utf-8')
    writeFileSync(join(baseDir, 'profiles', 'g41a5b5g', 'skills', '.bundled_manifest'), 'profile-skill: stale-hash\n', 'utf-8')

    const { list } = await import('../../packages/server/src/controllers/hermes/skills')
    const ctx = mockCtx()

    await list(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.categories).toEqual([
      {
        name: 'profile-cat',
        description: '',
        skills: [
          expect.objectContaining({
            name: 'profile-skill',
            description: 'profile only',
            source: 'builtin',
            modified: undefined,
          }),
        ],
      },
    ])
  })

  it('proxies jobs through the bound profile and strips caller profile selectors in chat plane', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jobs: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    vi.doMock('../../packages/server/src/services/gateway-bootstrap', () => ({
      getGatewayManagerInstance: () => ({
        getUpstream: (profile: string) => `http://upstream.test/${profile}`,
        getApiKey: (profile: string) => `key-${profile}`,
      }),
    }))

    const { list } = await import('../../packages/server/src/controllers/hermes/jobs')
    const ctx = mockCtx({ search: '?profile=other&token=secret&limit=5', method: 'GET', req: { method: 'GET' } })

    await list(ctx)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://upstream.test/g41a5b5g/api/jobs?limit=5',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer key-g41a5b5g' }),
      }),
    )
  })

  it('returns an unavailable marker for chat-plane job lists when the bound gateway is not ready', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    vi.stubGlobal('fetch', fetchMock)
    vi.doMock('../../packages/server/src/services/gateway-bootstrap', () => ({
      getGatewayManagerInstance: () => ({
        getUpstream: (profile: string) => `http://upstream.test/${profile}`,
        getApiKey: (profile: string) => `key-${profile}`,
      }),
    }))

    const { list } = await import('../../packages/server/src/controllers/hermes/jobs')
    const ctx = mockCtx({ method: 'GET', req: { method: 'GET' } })

    await list(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({
      jobs: [],
      gateway_unavailable: true,
      error: { message: 'Proxy error: ECONNREFUSED' },
    })
  })

  it('wakes only the API runtime for the bound profile in chat plane', async () => {
    const startApiOnly = vi.fn().mockResolvedValue({
      profile: 'g41a5b5g',
      running: true,
      url: 'http://upstream.test/g41a5b5g',
    })
    const start = vi.fn()
    vi.doMock('../../packages/server/src/services/gateway-bootstrap', () => ({
      getGatewayManagerInstance: () => ({
        detectStatus: vi.fn().mockResolvedValue({
          profile: 'g41a5b5g',
          running: false,
          url: 'http://upstream.test/g41a5b5g',
        }),
        startApiOnly,
        start,
      }),
    }))

    const { wake } = await import('../../packages/server/src/controllers/hermes/jobs')
    const ctx = mockCtx({ method: 'POST', req: { method: 'POST' } })

    await wake(ctx)

    expect(startApiOnly).toHaveBeenCalledWith('g41a5b5g')
    expect(start).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({
      profile: 'g41a5b5g',
      running: true,
      status: 'ready',
      url: 'http://upstream.test/g41a5b5g',
    })
  })

  it('sleeps only the API runtime for the bound profile in chat plane', async () => {
    const stopApiOnly = vi.fn().mockResolvedValue({
      profile: 'g41a5b5g',
      running: false,
      status: 'stopped',
    })
    const stop = vi.fn()
    vi.doMock('../../packages/server/src/services/gateway-bootstrap', () => ({
      getGatewayManagerInstance: () => ({
        stopApiOnly,
        stop,
      }),
    }))

    const { sleep } = await import('../../packages/server/src/controllers/hermes/jobs')
    const ctx = mockCtx({ method: 'POST', req: { method: 'POST' } })

    await sleep(ctx)

    expect(stopApiOnly).toHaveBeenCalledWith('g41a5b5g')
    expect(stop).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({
      profile: 'g41a5b5g',
      running: false,
      status: 'stopped',
    })
  })

  it('strips caller profile selectors and credential fields from chat-plane job bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job: { id: 'job-1' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    vi.doMock('../../packages/server/src/services/gateway-bootstrap', () => ({
      getGatewayManagerInstance: () => ({
        getUpstream: (profile: string) => `http://upstream.test/${profile}`,
        getApiKey: (profile: string) => `key-${profile}`,
      }),
    }))

    const { create } = await import('../../packages/server/src/controllers/hermes/jobs')
    const ctx = mockCtx({
      method: 'POST',
      req: { method: 'POST' },
      request: {
        body: {
          name: 'job',
          prompt: 'run safely',
          profile: 'root',
          token: 'secret-token',
          'x-hermes-profile': 'root',
          provider: 'secret-provider',
          base_url: 'https://secret.example',
          api_key: 'provider-key',
          apiKey: 'provider-key-2',
        },
      },
    })

    await create(ctx)

    const forwarded = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(forwarded).toEqual({
      name: 'job',
      prompt: 'run safely',
    })
  })

  it('serves files only from the bound profile workspace in chat plane', async () => {
    const rootWorkspace = join(baseDir, 'workspace')
    const profileWorkspace = join(baseDir, 'profiles', 'g41a5b5g', 'workspace')
    mkdirSync(rootWorkspace, { recursive: true })
    mkdirSync(profileWorkspace, { recursive: true })
    writeFileSync(join(rootWorkspace, 'root-only.txt'), 'root workspace', 'utf-8')
    writeFileSync(join(profileWorkspace, 'profile.txt'), 'profile workspace', 'utf-8')

    const listCtx = mockCtx({ query: { path: '' } })
    await invokeFileRoute('GET', '/api/hermes/files/list', listCtx)

    expect(listCtx.body.entries.map((entry: { name: string }) => entry.name)).toEqual(['profile.txt'])

    const readCtx = mockCtx({ query: { path: 'profile.txt' } })
    await invokeFileRoute('GET', '/api/hermes/files/read', readCtx)

    expect(readCtx.body).toMatchObject({
      content: 'profile workspace',
      path: 'profile.txt',
    })
  })

  it('writes files only into the bound profile workspace in chat plane', async () => {
    const profileWorkspace = join(baseDir, 'profiles', 'g41a5b5g', 'workspace')
    mkdirSync(profileWorkspace, { recursive: true })
    const ctx = mockCtx({
      method: 'PUT',
      request: { body: { path: 'todo.md', content: 'sandbox note' } },
    })

    await invokeFileRoute('PUT', '/api/hermes/files/write', ctx)

    expect(ctx.body).toEqual({ ok: true, path: 'todo.md' })
    expect(readFileSync(join(profileWorkspace, 'todo.md'), 'utf-8')).toBe('sandbox note')
    expect(existsSync(join(baseDir, 'todo.md'))).toBe(false)
  })

  it('does not expose profile or root config through the chat-plane files workspace', async () => {
    const profileWorkspace = join(baseDir, 'profiles', 'g41a5b5g', 'workspace')
    mkdirSync(profileWorkspace, { recursive: true })
    const ctx = mockCtx({ query: { path: 'config.yaml' } })

    await invokeFileRoute('GET', '/api/hermes/files/read', ctx)

    expect(ctx.status).toBe(404)
    expect(ctx.body.content).toBeUndefined()
  })

  it('deletes chat-plane workspace files from query params when DELETE bodies are not parsed', async () => {
    const profileWorkspace = join(baseDir, 'profiles', 'g41a5b5g', 'workspace')
    mkdirSync(profileWorkspace, { recursive: true })
    writeFileSync(join(profileWorkspace, 'probe.txt'), 'probe', 'utf-8')
    const ctx = mockCtx({
      method: 'DELETE',
      query: { path: 'probe.txt' },
      request: {},
    })

    await invokeFileRoute('DELETE', '/api/hermes/files/delete', ctx)

    expect(ctx.body).toEqual({ ok: true })
    expect(existsSync(join(profileWorkspace, 'probe.txt'))).toBe(false)
  })

  it('downloads files only from the bound profile workspace in chat plane', async () => {
    const rootWorkspace = join(baseDir, 'workspace')
    const profileWorkspace = join(baseDir, 'profiles', 'g41a5b5g', 'workspace')
    mkdirSync(rootWorkspace, { recursive: true })
    mkdirSync(profileWorkspace, { recursive: true })
    writeFileSync(join(rootWorkspace, 'artifact.txt'), 'root artifact', 'utf-8')
    writeFileSync(join(profileWorkspace, 'artifact.txt'), 'profile artifact', 'utf-8')

    const ctx = mockCtx({ query: { path: 'artifact.txt' } })

    await invokeDownloadRoute(ctx)

    expect(Buffer.isBuffer(ctx.body)).toBe(true)
    expect(ctx.body.toString('utf-8')).toBe('profile artifact')
  })

  it('does not download profile or root config through chat-plane download paths', async () => {
    const profileWorkspace = join(baseDir, 'profiles', 'g41a5b5g', 'workspace')
    mkdirSync(profileWorkspace, { recursive: true })

    const relativeCtx = mockCtx({ query: { path: 'config.yaml' } })
    await invokeDownloadRoute(relativeCtx)

    expect(relativeCtx.status).toBe(404)

    const absoluteCtx = mockCtx({ query: { path: join(baseDir, 'config.yaml') } })
    await invokeDownloadRoute(absoluteCtx)

    expect(absoluteCtx.status).toBe(400)
    expect(absoluteCtx.body.code).toBe('invalid_path')
  })

  it('serves cron run history from the bound profile in chat plane', async () => {
    const rootOutput = join(baseDir, 'cron', 'output', 'root-job')
    const profileOutput = join(baseDir, 'profiles', 'g41a5b5g', 'cron', 'output', 'profile-job')
    mkdirSync(rootOutput, { recursive: true })
    mkdirSync(profileOutput, { recursive: true })
    writeFileSync(join(rootOutput, '2026-05-06T01-00-00.000000+00-00.md'), '# root\n', 'utf-8')
    writeFileSync(join(profileOutput, '2026-05-06T02-00-00.000000+00-00.md'), '# profile\n', 'utf-8')

    const { listRuns, readRun } = await import('../../packages/server/src/controllers/hermes/cron-history')
    const listCtx = mockCtx()

    await listRuns(listCtx)

    expect(listCtx.body.runs).toEqual([
      expect.objectContaining({
        jobId: 'profile-job',
        fileName: '2026-05-06T02-00-00.000000+00-00.md',
      }),
    ])

    const readCtx = mockCtx({
      params: {
        jobId: 'profile-job',
        fileName: '2026-05-06T02-00-00.000000+00-00.md',
      },
    })
    await readRun(readCtx)

    expect(readCtx.body.content).toBe('# profile\n')
  })

  it('does not read root cron history through chat-plane job history requests', async () => {
    const rootOutput = join(baseDir, 'cron', 'output', 'root-job')
    mkdirSync(rootOutput, { recursive: true })
    writeFileSync(join(rootOutput, '2026-05-06T01-00-00.000000+00-00.md'), '# root\n', 'utf-8')

    const { listRuns, readRun } = await import('../../packages/server/src/controllers/hermes/cron-history')
    const listCtx = mockCtx({ query: { jobId: 'root-job' } })

    await listRuns(listCtx)

    expect(listCtx.body).toEqual({ runs: [] })

    const readCtx = mockCtx({
      params: {
        jobId: 'root-job',
        fileName: '2026-05-06T01-00-00.000000+00-00.md',
      },
    })
    await readRun(readCtx)

    expect(readCtx.status).toBe(404)
  })

  it('stores chat attachments in the bound profile workspace and returns a relative path', async () => {
    const { handleUpload } = await import('../../packages/server/src/controllers/upload')
    const { body, contentType } = multipartBody('note.txt', 'profile attachment')
    const ctx = mockUploadCtx(body, contentType)

    await handleUpload(ctx)

    const uploaded = ctx.body.files[0]
    expect(uploaded.name).toBe('note.txt')
    expect(uploaded.path).toMatch(/^uploads\/[a-f0-9]{16}\.txt$/)
    expect(uploaded.path.startsWith('/')).toBe(false)
    expect(readFileSync(join(baseDir, 'profiles', 'g41a5b5g', 'workspace', uploaded.path), 'utf-8')).toBe('profile attachment')
    expect(existsSync(join(baseDir, 'upload'))).toBe(false)
  })
})
