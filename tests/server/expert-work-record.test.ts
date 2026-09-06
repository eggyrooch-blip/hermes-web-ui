import { beforeEach, describe, expect, it, vi } from 'vitest'

const registry = vi.hoisted(() => ({
  catalog: vi.fn(),
  owner: vi.fn(),
}))
const sessions = vi.hoisted(() => ({
  list: vi.fn(),
  canAccess: vi.fn(),
  available: true,
}))
const feedback = vi.hoisted(() => ({
  list: vi.fn(),
}))
const jobs = vi.hoisted(() => ({ list: vi.fn() }))

vi.mock('../../packages/server/src/services/hermes/expert-registry-client', () => ({
  fetchExpertCatalog: registry.catalog,
  resolveExpertOwner: registry.owner,
  ExpertOwnerResolutionError: class ExpertOwnerResolutionError extends Error {},
}))

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  listSessions: sessions.list,
  isSessionStorageAvailable: () => sessions.available,
}))

vi.mock('../../packages/server/src/controllers/hermes/sessions', () => ({
  canAccessSessionAsync: sessions.canAccess,
}))

vi.mock('../../packages/server/src/db/hermes/feedback-store', () => ({
  listFeedback: feedback.list,
}))

vi.mock('../../packages/server/src/controllers/hermes/jobs', () => ({
  listJobsForWorkRecord: jobs.list,
}))

function makeCtx(openid: string, view?: 'maintainer') {
  return {
    state: { user: { openid, profile: `profile-${openid}` } },
    params: { expertId: 'expert-x' },
    query: view ? { view } : {},
    status: 200,
    body: undefined as any,
  } as any
}

function makeLocalCtx(id: number) {
  return {
    state: { user: { id, role: 'super_admin' } },
    params: { expertId: 'expert-x' },
    query: { profile: 'profile-local' },
    get: (name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'profile-local' : '',
    status: 200,
    body: undefined as any,
  } as any
}

describe('expert work record', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-08-12T00:00:00Z'))
    vi.clearAllMocks()
    sessions.available = true
    registry.catalog.mockImplementation(async ({ profileName }: { profileName: string }) => ({
      profile_name: profileName,
      experts: [{ id: 'expert-x', name: 'Expert X' }],
    }))
    registry.owner.mockResolvedValue({ subject: 'feishu:ou_owner' })
    sessions.canAccess.mockResolvedValue(true)
    sessions.list.mockReturnValue([
      {
        id: 'session-a', expert_id: 'expert-x', user_id: 'ou_a', profile: 'profile-ou_a',
        title: 'A private work', last_active: 1786492790, ended_at: null,
      },
      {
        id: 'session-b', expert_id: 'expert-x', user_id: 'ou_b', profile: 'profile-ou_b',
        title: 'B private work', last_active: 1786492780, ended_at: 1786492781,
      },
      {
        id: 'ownerless', expert_id: 'expert-x', user_id: null, profile: 'profile-ou_a',
        title: 'Must not be claimed', last_active: 1786492795, ended_at: null,
      },
      {
        id: 'other-expert', expert_id: 'expert-y', user_id: 'ou_a', profile: 'profile-ou_a',
        title: 'Wrong expert', last_active: 1786492798, ended_at: null,
      },
    ])
    feedback.list.mockImplementation((subject: string, sessionId: string) => [{
      session_id: sessionId,
      run_id: subject.endsWith('ou_a') ? 'run-a' : 'run-b',
      expert_id: 'expert-x',
      rating: subject.endsWith('ou_a') ? 'up' : 'down',
      reason: subject.endsWith('ou_a') ? null : 'unresolved',
      created_at: 1786492700,
      updated_at: 1786492790,
    }])
    jobs.list.mockResolvedValue({ available: false, jobs: [] })
  })

  it('returns only the verified principal records and keeps two users cross-match free', async () => {
    const { workRecord } = await import('../../packages/server/src/controllers/hermes/experts')

    const a = makeCtx('ou_a')
    const b = makeCtx('ou_b')
    await workRecord(a)
    await workRecord(b)

    expect(a.body).toMatchObject({
      expert_id: 'expert-x',
      mode: 'user',
      partitions: {
        sessions: { status: 'available', items: [{ id: 'session-a', title: 'A private work' }] },
        jobs: { status: 'unavailable', items: [] },
        feedback: { status: 'available', items: [{ session_id: 'session-a', run_id: 'run-a', rating: 'up' }] },
      },
    })
    expect(b.body).toMatchObject({
      mode: 'user',
      partitions: {
        sessions: { status: 'available', items: [{ id: 'session-b', title: 'B private work' }] },
        feedback: { status: 'available', items: [{ session_id: 'session-b', run_id: 'run-b', rating: 'down' }] },
      },
    })

    const aIds = new Set([
      ...a.body.partitions.sessions.items.map((row: any) => row.id),
      ...a.body.partitions.feedback.items.map((row: any) => `${row.session_id}:${row.run_id}`),
    ])
    const bIds = new Set([
      ...b.body.partitions.sessions.items.map((row: any) => row.id),
      ...b.body.partitions.feedback.items.map((row: any) => `${row.session_id}:${row.run_id}`),
    ])
    expect([...aIds].filter(id => bIds.has(id))).toEqual([])
    expect(JSON.stringify(a.body)).not.toContain('ownerless')
    expect(JSON.stringify(a.body)).not.toContain('Wrong expert')
  })

  it('keeps an authenticated local WebUI account in its own namespaced scope', async () => {
    sessions.list.mockReturnValueOnce([{
      id: 'session-local', expert_id: 'expert-x', user_id: '7', profile: 'profile-local',
      title: 'Local work', last_active: 1786492790, ended_at: null,
    }])
    feedback.list.mockReturnValueOnce([])
    const { workRecord } = await import('../../packages/server/src/controllers/hermes/experts')
    const request = makeLocalCtx(7)

    await workRecord(request)

    expect(request.status).toBe(200)
    expect(registry.catalog).toHaveBeenCalledWith({ profileName: 'profile-local', userKey: '7' })
    expect(feedback.list).toHaveBeenCalledWith('webui:7', 'session-local')
    expect(request.body.partitions.sessions.items).toEqual([
      expect.objectContaining({ id: 'session-local', title: 'Local work' }),
    ])
  })

  it('gives only the unique registry owner identifier-free aggregates', async () => {
    const { workRecord } = await import('../../packages/server/src/controllers/hermes/experts')
    const owner = makeCtx('ou_owner', 'maintainer')
    await workRecord(owner)

    expect(owner.body).toEqual({
      expert_id: 'expert-x',
      mode: 'maintainer',
      window_days: 30,
      partitions: {
        sessions: { status: 'available', count: 2, active: 1, completed: 1 },
        jobs: { status: 'unavailable' },
        feedback: { status: 'available', count: 2, positive: 1, negative: 1, positive_rate: 0.5 },
      },
    })
    const serialized = JSON.stringify(owner.body)
    for (const forbidden of ['session-a', 'session-b', 'ou_a', 'ou_b', 'A private work', 'unresolved']) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('returns 404 to a non-owner maintainer request and fails closed on registry loss', async () => {
    const { workRecord } = await import('../../packages/server/src/controllers/hermes/experts')

    const other = makeCtx('ou_other', 'maintainer')
    await workRecord(other)
    expect(other.status).toBe(404)
    expect(other.body).toEqual({ error: 'not found' })
    expect(feedback.list).not.toHaveBeenCalled()

    registry.owner.mockRejectedValueOnce(new Error('registry unavailable'))
    const unavailable = makeCtx('ou_owner', 'maintainer')
    await workRecord(unavailable)
    expect(unavailable.status).toBe(503)
    expect(unavailable.body).toEqual({ error: 'expert maintainer unavailable' })
    expect(feedback.list).not.toHaveBeenCalled()
  })

  it('excludes same-id sessions owned by another profile maintainer', async () => {
    registry.owner.mockImplementation(async ({ profileName }: { profileName: string }) => ({
      subject: profileName === 'profile-ou_b' ? 'feishu:ou_other_owner' : 'feishu:ou_owner',
    }))
    const { workRecord } = await import('../../packages/server/src/controllers/hermes/experts')
    const owner = makeCtx('ou_owner', 'maintainer')
    await workRecord(owner)

    expect(owner.body.partitions.sessions).toEqual({ status: 'available', count: 1, active: 1, completed: 0 })
    expect(owner.body.partitions.feedback).toEqual({
      status: 'available', count: 1, positive: 1, negative: 0, positive_rate: 1,
    })
    expect(feedback.list).toHaveBeenCalledWith('feishu:ou_a', 'session-a')
    expect(feedback.list).not.toHaveBeenCalledWith('feishu:ou_b', 'session-b')
  })

  it('marks a failed source partition unavailable instead of fabricating zero', async () => {
    sessions.available = false
    const { workRecord } = await import('../../packages/server/src/controllers/hermes/experts')
    const request = makeCtx('ou_a')
    await workRecord(request)

    expect(request.status).toBe(200)
    expect(request.body.partitions.sessions).toEqual({ status: 'unavailable', items: [] })
    expect(request.body.partitions.feedback).toEqual({ status: 'unavailable', items: [] })
    expect(request.body.partitions.jobs).toEqual({ status: 'unavailable', items: [] })
  })

  it('keeps the work-record response usable when the reused jobs controller changes ctx', async () => {
    jobs.list.mockImplementationOnce(async (request: any) => {
      request.status = 503
      request.body = { error: 'jobs unavailable' }
      return { available: false, jobs: [] }
    })
    const { workRecord } = await import('../../packages/server/src/controllers/hermes/experts')
    const request = makeCtx('ou_a')
    await workRecord(request)

    expect(request.status).toBe(200)
    expect(request.body.partitions.sessions.status).toBe('available')
    expect(request.body.partitions.jobs).toEqual({ status: 'unavailable', items: [] })
  })

  it('reuses the current-user jobs authorization and exposes only bounded expert summaries', async () => {
    jobs.list.mockResolvedValueOnce({
      available: true,
      jobs: [
        { id: 'job-a', job_id: 'job-a', expert_id: 'expert-x', name: '每日投放', state: 'scheduled', schedule_display: '每天 09:00', prompt: 'private prompt' },
        { id: 'job-b', job_id: 'job-b', expert_id: 'expert-y', name: 'Other expert', state: 'scheduled', prompt: 'other private prompt' },
      ],
    })
    const { workRecord } = await import('../../packages/server/src/controllers/hermes/experts')
    const request = makeCtx('ou_a')
    await workRecord(request)

    expect(request.body.partitions.jobs).toEqual({
      status: 'available',
      items: [{ id: 'job-a', name: '每日投放', schedule: '每天 09:00', status: 'scheduled' }],
    })
    expect(JSON.stringify(request.body.partitions.jobs)).not.toContain('private prompt')
  })

  it('counts only authorized expert jobs for the maintainer without returning job details', async () => {
    jobs.list.mockImplementation(async (_ctx: any, actor?: { openid: string }) => ({
      available: true,
      jobs: actor?.openid === 'ou_a'
        ? [{ id: 'job-a', expert_id: 'expert-x', name: 'Secret A', state: 'scheduled', prompt: 'hidden A' }]
        : [
            { id: 'job-b', expert_id: 'expert-x', name: 'Secret B', state: 'paused', prompt: 'hidden B' },
            { id: 'job-c', expert_id: 'expert-y', name: 'Other', state: 'scheduled' },
          ],
    }))
    const { workRecord } = await import('../../packages/server/src/controllers/hermes/experts')
    const owner = makeCtx('ou_owner', 'maintainer')
    await workRecord(owner)

    expect(owner.body.partitions.jobs).toEqual({
      status: 'available',
      // Owner-scoped jobs authority: the count declares the scope it covers.
      scope: 'principals_with_sessions_in_window',
      count: 2,
      active: 1,
      paused: 1,
    })
    expect(JSON.stringify(owner.body.partitions.jobs)).not.toMatch(/job-a|Secret|hidden/)
    expect(jobs.list).toHaveBeenCalledWith(expect.anything(), { profile: 'profile-ou_a', openid: 'ou_a' })
    expect(jobs.list).toHaveBeenCalledWith(expect.anything(), { profile: 'profile-ou_b', openid: 'ou_b' })
  })
})
