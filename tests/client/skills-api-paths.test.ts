import { beforeEach, describe, expect, it, vi } from 'vitest'

// Port of upstream EKKOLearnAI/hermes-web-ui 32eaed6eb (#2845). Our skills API has
// no `target` selector, so the upstream `?target=` expectations are dropped.
const mockRequest = vi.hoisted(() => vi.fn())

vi.mock('../../packages/client/src/api/client', () => ({
  request: mockRequest,
  getApiKey: vi.fn(() => ''),
  getBaseUrlValue: vi.fn(() => ''),
  getActiveProfileName: vi.fn(() => null),
}))

import { fetchSkillContent, fetchSkillFiles } from '../../packages/client/src/api/hermes/skills'

describe('Skills API paths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('encodes reserved characters in skill content path segments', async () => {
    mockRequest.mockResolvedValue({ content: '# C# helper' })

    await expect(fetchSkillContent('languages/C#/SKILL.md')).resolves.toBe('# C# helper')

    expect(mockRequest).toHaveBeenCalledWith('/api/hermes/skills/languages/C%23/SKILL.md')
  })

  it('encodes nested file paths without encoding their separators', async () => {
    mockRequest.mockResolvedValue({ content: 'reference' })

    await fetchSkillContent('misc/why?/references/section#1.md')

    expect(mockRequest).toHaveBeenCalledWith(
      '/api/hermes/skills/misc/why%3F/references/section%231.md',
    )
  })

  it('encodes reserved characters in category and skill names when listing files', async () => {
    mockRequest.mockResolvedValue({ files: [] })

    await expect(fetchSkillFiles('language#tools', 'why?')).resolves.toEqual([])

    expect(mockRequest).toHaveBeenCalledWith('/api/hermes/skills/language%23tools/why%3F/files')
  })
})
