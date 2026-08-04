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

  it('ignores a pre-v2 cache entry instead of resurrecting the empty-label sentinel', async () => {
    // 旧版把「无可执行操作」写成 {kind:'manual', label:''}。新 UI 按 action 是否存在渲染
    // 按钮，若读到这种旧条目，「GitLab（全局）」会冒出一颗「连接」按钮，且在刷新失败时
    // 一直留着（codex 评审 2026-08-04 抓到）。版本写在 key 里，旧条目必须读不到。
    const legacyKey = 'hermes:connector-status:feishu_g41a5b5g'
    localStorage.setItem(legacyKey, JSON.stringify({
      profile_name: 'feishu_g41a5b5g',
      credentials: [{
        id: 'gitlab', title: 'GitLab', provider: 'gitlab', installed: true,
        status: 'configured', action: { kind: 'manual', label: '' },
      }],
    }))

    const { readCachedConnectorStatus } = await import('@/utils/connector-status-cache')
    expect(readCachedConnectorStatus('feishu_g41a5b5g')).toBeNull()
    // 并且顺手清掉，别让每次 bump 都留一批永远读不到的垃圾
    expect(localStorage.getItem(legacyKey)).toBeNull()
  })

  it('round-trips an entry that has no action at all', async () => {
    const { readCachedConnectorStatus, writeCachedConnectorStatus } =
      await import('@/utils/connector-status-cache')
    writeCachedConnectorStatus('p2', {
      profile_name: 'p2',
      credentials: [{
        id: 'gitlab', title: 'GitLab（全局）', provider: 'gitlab', installed: true,
        status: 'configured',
      }],
    } as any)
    const back = readCachedConnectorStatus('p2')
    expect(back!.credentials[0].action).toBeUndefined()
  })
})
