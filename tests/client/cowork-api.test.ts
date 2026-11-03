// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/client', () => ({ request: vi.fn() }))

import { request } from '@/api/client'
import { createCoworkProject, getSessionProjectReceipt, listCoworkProjectSessions, listCoworkProjects } from '@/api/hermes/cowork'

const project = {
  id: 'project-a', name: 'Alpha', description: 'Quarterly report', instructions: '', icon: '', color: '',
  primary_folder: 'reports', status: 'active' as const, created_at: 1, updated_at: 1,
}

describe('Project API', () => {
  beforeEach(() => vi.mocked(request).mockReset())

  it('filters the authoritative list locally', async () => {
    vi.mocked(request).mockResolvedValue({ items: [project, { ...project, id: 'project-b', name: 'Beta', description: '' }] })
    expect(await listCoworkProjects('quarterly')).toEqual([project])
    expect(request).toHaveBeenCalledWith('/api/hermes/cowork/projects')
  })

  it('creates Projects and reads the frozen session receipt', async () => {
    vi.mocked(request)
      .mockResolvedValueOnce({ project })
      .mockResolvedValueOnce({ receipt: { session_id: 'session-a', project_id: 'project-a' } })
    expect(await createCoworkProject({ name: 'Alpha', primary_folder: 'reports' })).toEqual(project)
    expect(request).toHaveBeenNthCalledWith(1, '/api/hermes/cowork/projects', {
      method: 'POST', body: JSON.stringify({ name: 'Alpha', primary_folder: 'reports' }),
    })
    expect(await getSessionProjectReceipt('session-a')).toMatchObject({ project_id: 'project-a' })
    expect(request).toHaveBeenNthCalledWith(2, '/api/hermes/cowork/sessions/session-a/project')
  })

  it('lists the tasks bound to a Project', async () => {
    vi.mocked(request).mockResolvedValue({ items: [{ session_id: 'session-a', created_at: 10 }] })
    expect(await listCoworkProjectSessions('project-a')).toEqual([{ session_id: 'session-a', created_at: 10 }])
    expect(request).toHaveBeenCalledWith('/api/hermes/cowork/projects/project-a/sessions')
  })
})
