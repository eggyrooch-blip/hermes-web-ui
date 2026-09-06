import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ request: requestMock }))

import { cardifyFeishuUrls, extractFeishuUrls, fetchLinkPreviews, restoreFeishuUrlSlots } from '@/api/hermes/link-previews'

describe('link preview client', () => {
  beforeEach(() => requestMock.mockReset())

  it('does not reuse preview metadata across callers', async () => {
    const url = 'https://tenant.feishu.cn/base/cache_test'
    const response = { previews: [{ kind: 'base', title: '数据大屏', type_label: '多维表格', url, status: 'resolved' }] }
    requestMock.mockResolvedValue(response)

    const [first, second] = await Promise.all([
      fetchLinkPreviews([url], 'profile-cache'),
      fetchLinkPreviews([url], 'profile-cache'),
    ])

    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(first).toEqual(response)
    expect(second).toEqual(response)
  })

  it('does not multiply a failed lookup past the three-second UI budget', async () => {
    const url = 'https://tenant.feishu.cn/base/retry_test'
    requestMock.mockRejectedValueOnce(new Error('fetch failed'))

    const result = fetchLinkPreviews([url], 'profile-retry')

    await expect(result).rejects.toThrow('fetch failed')
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it('stops a Feishu URL before Chinese punctuation', () => {
    const url = 'https://tenant.feishu.cn/base/token?table=tbl1'
    expect(extractFeishuUrls(`看看 ${url}。下一句`)).toEqual([url])
  })

  it('restores multiple URLs in document order even when resolved later at the front', () => {
    const firstUrl = 'https://tenant.feishu.cn/wiki/first'
    const secondUrl = 'https://tenant.feishu.cn/wiki/second'
    const first = cardifyFeishuUrls(`尾部 ${firstUrl}`, [firstUrl])
    const second = cardifyFeishuUrls(`${secondUrl} 前置 ${first.text}`, [secondUrl], first.slots)

    expect(restoreFeishuUrlSlots(second.text, second.slots)).toBe(`${secondUrl} 前置 尾部 ${firstUrl}`)
  })
})
