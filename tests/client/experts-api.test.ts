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

import { expertSamplePrompts, fetchExperts, isAiHubExpert } from '../../packages/client/src/api/hermes/experts'

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

    expect(data.experts).toEqual(experts.map(expert => ({
      ...expert,
      harness_available: false,
    })))
    // persona (agent_md) is never part of the surfaced shape
    expect(data.experts.every(e => !('agent_md' in e))).toBe(true)
  })

  it('offers Harness to every returned expert for a non-allowlisted profile', async () => {
    const experts = [{ id: 'server-dev', name: 'Server Dev' }, { id: 'hr', name: 'HR' }]
    mockFetch.mockResolvedValue(jsonResponse({ experts, profile_name: 'zhaozhiguang', harness_enabled: true }))

    const data = await fetchExperts('zhaozhiguang')

    expect(data.experts.map(expert => expert.harness_available)).toEqual([true, true])
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

describe('isAiHubExpert', () => {
  it('is true when source is aihub', () => {
    expect(isAiHubExpert({ source: 'aihub' })).toBe(true)
  })

  it('is true when the from_aihub flag is set', () => {
    expect(isAiHubExpert({ from_aihub: true })).toBe(true)
  })

  it('is false for local / unknown / absent sources', () => {
    expect(isAiHubExpert({ source: 'local' })).toBe(false)
    expect(isAiHubExpert({ source: 'something-else' })).toBe(false)
    expect(isAiHubExpert({})).toBe(false)
    expect(isAiHubExpert({ from_aihub: false })).toBe(false)
  })
})

describe('expertSamplePrompts', () => {
  it('uses the author-written sample_prompts verbatim, trimmed and capped at five', () => {
    expect(
      expertSamplePrompts({
        name: '专家构建专家',
        sample_prompts: ['  我想把我们组的业务做成一个专家  ', '', '建专家和写普通 skill 有什么区别'],
      }),
    ).toEqual(['我想把我们组的业务做成一个专家', '建专家和写普通 skill 有什么区别'])

    expect(
      expertSamplePrompts({ name: 'x', sample_prompts: ['1', '2', '3', '4', '5', '6'] }),
    ).toEqual(['1', '2', '3', '4', '5'])
  })

  it('falls back to three lines built from this expert own tags, name and skills', () => {
    const tagged = expertSamplePrompts({
      name: '财务分析专家',
      display_tags: ['做月度对账', '集团口径', '数据脱敏'],
      skills: ['close-books'],
    })
    expect(tagged).toHaveLength(3)
    expect(tagged[0]).toBe('帮我做月度对账，先列清你需要我提供哪些材料')
    expect(tagged[1]).toBe('按集团口径的口径整理一版，直接给结论和依据')
    expect(tagged[2]).toBe('这件事在数据脱敏上有哪些坑，挑最关键的三条')

    // no tags: the name domain word (suffix stripped) and the first skill carry it
    const bare = expertSamplePrompts({ name: '财务分析专家', skills: ['close-books'] })
    expect(bare[0]).toBe('帮我做一次「财务分析」的任务，先列清你需要我提供哪些材料')
    expect(bare[1]).toBe('从「close-books」开始，带我把「财务分析」的流程走一遍')
    expect(bare[2]).toBe('用「财务分析」干活最容易踩哪些坑？挑最关键的三条')

    // neither tags nor skills still yields three sendable lines, never a blank
    const minimal = expertSamplePrompts({ name: 'HR' })
    expect(minimal).toHaveLength(3)
    expect(minimal.every(line => line.includes('HR'))).toBe(true)

    // two different experts never share a line
    expect(new Set([...bare, ...minimal]).size).toBe(6)
  })

  it('prefers title over name for the generated domain word', () => {
    const [first] = expertSamplePrompts({ name: 'kep-expert-builder', title: '专家构建顾问' })
    expect(first).toBe('帮我做一次「专家构建」的任务，先列清你需要我提供哪些材料')
  })
})
