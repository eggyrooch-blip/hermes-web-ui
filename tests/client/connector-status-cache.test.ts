// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('@/api/skillCredentials', () => ({ fetchSkillCredentials: fetchMock }))

describe('connector-status-cache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    try { localStorage.clear() } catch { /* jsdom */ }
    vi.resetModules()  // reset the module-level dedupe state between tests
  })

  it('read/write round-trips the cached status; unknown profile is null', async () => {
    const { writeCachedConnectorStatus, readCachedConnectorStatus } = await import('@/utils/connector-status-cache')
    const data = { profile_name: 'p', credentials: [{ id: 'kep-cli', status: 'authenticated' }] } as any
    writeCachedConnectorStatus('p', data)
    expect(readCachedConnectorStatus('p')).toEqual(data)
    expect(readCachedConnectorStatus('other')).toBeNull()
  })

  it('prewarm fetches the profile and writes its cache', async () => {
    const data = { profile_name: 'p', credentials: [{ id: 'kep-cli', status: 'authenticated' }] }
    fetchMock.mockResolvedValue(data)
    const { prewarmConnectorStatus, readCachedConnectorStatus } = await import('@/utils/connector-status-cache')
    prewarmConnectorStatus('p')
    await new Promise(r => setTimeout(r, 0))
    expect(fetchMock).toHaveBeenCalledWith('p')
    expect(readCachedConnectorStatus('p')).toEqual(data)
  })

  it('dedupes consecutive same-profile prewarms', async () => {
    fetchMock.mockResolvedValue({ profile_name: 'p', credentials: [] })
    const { prewarmConnectorStatus } = await import('@/utils/connector-status-cache')
    prewarmConnectorStatus('p')
    prewarmConnectorStatus('p')
    await new Promise(r => setTimeout(r, 0))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not fetch for an empty/missing profile', async () => {
    const { prewarmConnectorStatus } = await import('@/utils/connector-status-cache')
    prewarmConnectorStatus('')
    prewarmConnectorStatus(null)
    prewarmConnectorStatus(undefined)
    await new Promise(r => setTimeout(r, 0))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
