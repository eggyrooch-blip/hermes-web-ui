// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// request() imports the router for its 401 redirect path; stub it so the client
// module loads in isolation (mirrors tests/client/api.test.ts).
vi.mock('@/router', () => ({
  default: {
    currentRoute: { value: { name: 'hermes.chat' } },
    replace: vi.fn(),
  },
}))

import { fetchExperts } from '../../packages/client/src/api/hermes/experts'

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) }
}

describe('experts api client', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('maps the broker catalog response to ExpertsData', async () => {
    const experts = [
      { id: 'it-helpdesk', name: 'IT 助手', title: 'IT 服务台', featured: true, skills: ['hades'] },
      { id: 'hr', name: 'HR' },
    ]
    mockFetch.mockResolvedValue(jsonResponse({ experts, profile_name: 'sunke' }))

    const data = await fetchExperts('sunke')

    expect(data.experts).toEqual(experts)
    // persona (agent_md) is never part of the surfaced shape
    expect(data.experts.every(e => !('agent_md' in e))).toBe(true)
  })

  it('encodes the profile into the query string', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ experts: [] }))

    await fetchExperts('ou name/with spaces')

    const [url] = mockFetch.mock.calls[0]
    expect(url).toContain('/api/hermes/experts?profile=ou%20name%2Fwith%20spaces')
  })

  it('omits the profile query when none is given', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ experts: [] }))

    await fetchExperts()

    const [url] = mockFetch.mock.calls[0]
    expect(url).toMatch(/\/api\/hermes\/experts$/)
  })

  it('fail-safe: a non-array experts payload degrades to an empty list (never throws)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ experts: null }))

    await expect(fetchExperts('sunke')).resolves.toEqual({ experts: [] })
  })

  it('fail-safe: a missing experts field degrades to an empty list', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}))

    await expect(fetchExperts('sunke')).resolves.toEqual({ experts: [] })
  })

  it('propagates a broker/transport error so the caller can fall back to []', async () => {
    // request() throws on a non-ok response; callers (ChatInput / ExpertCatalogView)
    // catch it and reset experts to []. Assert the throw contract here.
    mockFetch.mockResolvedValue({ ok: false, status: 502, text: () => Promise.resolve('bad gateway') })

    await expect(fetchExperts('sunke')).rejects.toThrow('API Error 502')
  })
})
