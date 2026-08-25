import { beforeEach, describe, expect, it, vi } from 'vitest'

// Integration-style: the REAL jobs controller is used (no listJobsForWorkRecord
// mock), so a regression that returns another principal's job to user A fails
// here. Only the upstream broker fetch is stubbed, and it answers per actor.

vi.mock('../../packages/server/src/services/gateway-bootstrap', () => ({
  getGatewayManagerInstance: () => ({
    getUpstream: () => 'http://127.0.0.1:8642',
    getApiKey: () => null,
  }),
}))

const registry = vi.hoisted(() => ({ catalog: vi.fn(), owner: vi.fn() }))
const sessions = vi.hoisted(() => ({ list: vi.fn(), canAccess: vi.fn(), available: true }))
const feedback = vi.hoisted(() => ({ list: vi.fn() }))

vi.mock('../../packages/server/src/services/hermes/expert-registry-client', () => ({
  fetchExpertCatalog: registry.catalog,
  resolveExpertOwner: registry.owner,
  ExpertOwnerResolutionError: class ExpertOwnerResolutionError extends Error {},
}))
vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  listSessions: sessions.list,
  isSessionStorageAvailable: () => sessions.available,
  getSession: vi.fn(() => null),
}))
vi.mock('../../packages/server/src/controllers/hermes/sessions', () => ({
  canAccessSessionAsync: sessions.canAccess,
}))
vi.mock('../../packages/server/src/db/hermes/feedback-store', () => ({
  listFeedback: feedback.list,
}))

const JOBS_BY_OWNER: Record<string, Array<Record<string, unknown>>> = {
  ou_a: [{ id: 'job-a1', job_id: 'job-a1', name: 'A private job', prompt: 'A prompt', expert_id: 'expert-x', state: 'active' }],
  ou_b: [{ id: 'job-b1', job_id: 'job-b1', name: 'B private job', prompt: 'B prompt', expert_id: 'expert-x', state: 'active' }],
}

function makeCtx(openid: string, view?: 'maintainer') {
  return {
    state: { user: { openid, profile: `profile-${openid}` } },
    params: { expertId: 'expert-x' },
    query: view ? { view } : {},
    request: { body: {} },
    req: { method: 'GET' },
    search: '',
    headers: {},
    status: 200,
    body: undefined as any,
    set: vi.fn(),
    get(name: string) {
      const hit = Object.entries(this.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())
      return (hit?.[1] as string) || ''
    },
  } as any
}

describe('expert work record — jobs isolation through the real jobs controller', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    sessions.available = true
    feedback.list.mockReturnValue([])
    registry.catalog.mockResolvedValue({ profile_name: 'profile-ou_a', experts: [{ id: 'expert-x', name: 'X' }] })
    sessions.canAccess.mockResolvedValue(true)
    // The upstream answers per ACTOR: each principal only ever sees its own job.
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: any) => {
      const actor = String(options?.headers?.['X-Hermes-Feishu-OpenId'] || options?.headers?.['X-Hermes-User-Key'] || '')
      const owned = JOBS_BY_OWNER[actor] || []
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ jobs: owned }),
      } as any
    }))
  })

  it('never returns another principal job to the requesting user (A/B cross-match = 0)', async () => {
    sessions.list.mockImplementation(() => [
      { id: 's-a', profile: 'profile-ou_a', user_id: 'ou_a', expert_id: 'expert-x', last_active: Math.floor(Date.now() / 1000) },
    ])
    const { workRecord } = await import('../../packages/server/src/controllers/hermes/experts')

    const ctxA = makeCtx('ou_a')
    await workRecord(ctxA)
    const bodyA = JSON.stringify(ctxA.body ?? {})

    const ctxB = makeCtx('ou_b')
    await workRecord(ctxB)
    const bodyB = JSON.stringify(ctxB.body ?? {})

    // No foreign job id, name or prompt may appear in either response.
    expect(bodyA).not.toContain('job-b1')
    expect(bodyA).not.toContain('B private job')
    expect(bodyA).not.toContain('B prompt')
    expect(bodyB).not.toContain('job-a1')
    expect(bodyB).not.toContain('A private job')
    expect(bodyB).not.toContain('A prompt')
  })

  it('labels the maintainer jobs partition with the scope it actually covers', async () => {
    registry.owner.mockResolvedValue({ subject: 'feishu:ou_a', profile: 'profile-ou_a' })
    sessions.list.mockImplementation(() => [
      { id: 's-a', profile: 'profile-ou_a', user_id: 'ou_a', expert_id: 'expert-x', last_active: Math.floor(Date.now() / 1000) },
    ])
    const { workRecord } = await import('../../packages/server/src/controllers/hermes/experts')

    const ctx = makeCtx('ou_a', 'maintainer')
    await workRecord(ctx)

    const jobsPartition = (ctx.body as any)?.partitions?.jobs
    if (jobsPartition?.status === 'available') {
      // The jobs authority is owner-scoped, so the count MUST declare that it
      // only covers principals seen in the session window — never presented as
      // an expert-wide total.
      expect(jobsPartition.scope).toBe('principals_with_sessions_in_window')
    } else {
      expect(jobsPartition?.status).toBe('unavailable')
    }
    // Aggregates only: no ids, names or prompts.
    const body = JSON.stringify(ctx.body ?? {})
    expect(body).not.toContain('job-a1')
    expect(body).not.toContain('A private job')
    expect(body).not.toContain('A prompt')
  })
})
