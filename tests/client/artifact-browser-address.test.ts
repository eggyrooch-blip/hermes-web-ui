// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

// The embedded browser's address bar must NEVER display the auth token (it's a
// bearer credential — a visible/screenshot-able super-admin JWT is a leak).
// getFilePreviewUrl returns a URL WITH the token; the address bar must strip it
// while the iframe src keeps it for auth.

vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>()
  return { ...actual }
})

vi.mock('@/api/hermes/files', () => ({
  getFilePreviewUrl: vi.fn((rel: string, name?: string) =>
    `/api/hermes/preview?path=${encodeURIComponent(rel)}&name=${encodeURIComponent(name || '')}&profile=feishu_g41a5b5g&token=SECRET.JWT.VALUE`),
}))

vi.mock('@/stores/hermes/files', () => ({
  decodeDisplayPathSegments: (p: string) => p,
}))

import ArtifactBrowser from '@/components/hermes/chat/ArtifactBrowser.vue'

describe('ArtifactBrowser address bar', () => {
  it('renders the iframe at the real preview URL (with token) but hides the token in the address bar', async () => {
    const wrapper = mount(ArtifactBrowser)
    ;(wrapper.vm as any).load({ name: 'ostrich-bike.html', path: '/workspace/ostrich-bike.html' })
    await wrapper.vm.$nextTick()

    const iframeSrc = wrapper.find('iframe').attributes('src') || ''
    const addressValue = (wrapper.find('input.artifact-browser-address').element as HTMLInputElement).value

    // iframe keeps the token (needed for auth)
    expect(iframeSrc).toContain('token=SECRET.JWT.VALUE')
    // address bar must NOT show the token
    expect(addressValue).not.toContain('token')
    expect(addressValue).not.toContain('SECRET.JWT.VALUE')
    // but still shows the real preview path
    expect(addressValue).toContain('/api/hermes/preview?path=')
    expect(addressValue).toContain('ostrich-bike.html')
  })
})
