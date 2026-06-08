import { describe, expect, it, vi } from 'vitest'

// Mock the auth/base-url client so getDownloadUrl is testable in isolation.
vi.mock('@/api/client', () => ({
  getApiKey: () => 'test-token',
  getBaseUrlValue: () => 'https://hermes.example.com',
}))

import { getDownloadUrl } from '@/api/hermes/download'

describe('getDownloadUrl remote URL handling', () => {
  // Regression: AIGC image generation returns a remote Tencent VOD/CDN URL.
  // Wrapping it in the local /api/hermes/download proxy makes the server treat
  // the URL as a local file path → 404 → broken image (chenggaowei 2026-06-08).
  it('returns a remote https URL untouched instead of proxy-wrapping it', () => {
    const vod = 'https://251000800.vod2.myqcloud.com/abc/401d9a5/aigcImageGenFile.jpg'
    expect(getDownloadUrl(vod, 'aigcImageGenFile.jpg')).toBe(vod)
  })

  it('returns a remote http URL untouched', () => {
    const url = 'http://cdn.example.com/x.png'
    expect(getDownloadUrl(url)).toBe(url)
  })

  it('still proxy-wraps a local workspace-relative path', () => {
    const out = getDownloadUrl('Downloads/poster.jpg', 'poster.jpg')
    expect(out).toContain('/api/hermes/download?path=')
    expect(out).toContain('Downloads')
  })

  it('still proxy-wraps an absolute local path', () => {
    const out = getDownloadUrl('/tmp/a.png')
    expect(out).toContain('/api/hermes/download?path=')
  })
})
