import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/services/logger', () => ({ logger: { warn: vi.fn() } }))

import { config } from '../../packages/server/src/config'
import { createProject, getProject, getSessionProject, listProjects, updateProject } from '../../packages/server/src/controllers/hermes/cowork'

function context(body: unknown = {}, params: Record<string, string> = {}, query: Record<string, string> = {}, actor = 'ou_actor_a') {
  return {
    state: { user: { openid: actor } }, request: { body }, params, query,
    get: vi.fn(() => ''), status: 200, body: undefined as unknown,
  }
}

describe('Project BFF trust boundary', () => {
  beforeEach(() => {
    config.runBrokerUrl = 'https://broker.invalid'
    config.runBrokerKey = 'broker-key'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })))
  })

  afterEach(() => vi.unstubAllGlobals())

  it('fails closed without verified actor or Run Broker', async () => {
    const noActor = context({}, {}, {}, '')
    await listProjects(noActor)
    expect(noActor.status).toBe(401)

    config.runBrokerUrl = ''
    const unavailable = context()
    await listProjects(unavailable)
    expect(unavailable).toMatchObject({ status: 503, body: { code: 'PROJECTS_UNAVAILABLE' } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('proxies Project APIs with the verified actor and broker credential', async () => {
    await createProject(context({ name: 'Project', primary_folder: 'team/a' }))
    await getSessionProject(context({}, { sessionId: 'session-a' }))

    expect(vi.mocked(fetch).mock.calls[0]).toMatchObject([
      'https://broker.invalid/api/run-broker/projects', { method: 'POST' },
    ])
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({
      'X-Hermes-Owner-Open-Id': 'ou_actor_a', Authorization: 'Bearer broker-key',
    })
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ name: 'Project', primary_folder: 'team/a' })
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe('https://broker.invalid/api/run-broker/sessions/session-a/project')
  })

  it('rejects unknown fields and invalid ids before Run Broker', async () => {
    const create = context({ name: 'Project', workspace: '/forged' })
    await createProject(create)
    expect(create.status).toBe(400)

    const update = context({ name: '' }, { projectId: 'project-a' })
    await updateProject(update)
    expect(update.status).toBe(400)

    const get = context({}, { projectId: '../admin' })
    await getProject(get)
    expect(get.status).toBe(404)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('redacts upstream identity details on denial', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ owner: 'ou_secret' }), { status: 404 }))
    const ctx = context({}, { projectId: 'project-a' })
    await getProject(ctx)
    expect(ctx).toMatchObject({ status: 404, body: { error: 'Not found' } })
    expect(JSON.stringify(ctx.body)).not.toContain('ou_secret')
  })
})
