// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const approveMock = vi.hoisted(() => vi.fn())
const requestMock = vi.hoisted(() => vi.fn())
const navigateMock = vi.hoisted(() => vi.fn())
const routeQuery = vi.hoisted(() => ({ request_id: 'hma_request' as string | undefined }))

vi.mock('@/api/mcpOAuth', () => ({
  approveMcpOAuth: approveMock,
  getMcpOAuthRequest: requestMock,
  navigateToOAuthClient: navigateMock,
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: routeQuery }) }))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('naive-ui', () => ({
  NButton: { props: ['loading', 'disabled'], template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>' },
  NCard: { template: '<section><slot /></section>' },
  NResult: { props: ['status', 'title', 'description'], template: '<div><h1>{{ title }}</h1><p>{{ description }}</p><slot name="footer" /></div>' },
}))

describe('MCP OAuth approval page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    routeQuery.request_id = 'hma_request'
    requestMock.mockResolvedValue({
      client_id: 'cursor-local',
      client_name: 'Cursor',
      redirect_origin: 'http://127.0.0.1:7777',
      scopes: ['mcp:tools'],
    })
  })

  it('approves once and returns to the MCP client callback', async () => {
    approveMock.mockResolvedValue({
      ok: true,
      redirect_url: 'http://127.0.0.1:7777/callback?code=redacted',
    })
    const View = (await import('@/views/McpOAuthApprovalView.vue')).default
    const wrapper = mount(View)
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Cursor')
    expect(wrapper.text()).toContain('http://127.0.0.1:7777')
    expect(wrapper.text()).toContain('mcp:tools')
    await wrapper.get('[data-testid="mcp-oauth-approve"]').trigger('click')
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    expect(approveMock).toHaveBeenCalledWith('hma_request')
    expect(navigateMock).toHaveBeenCalledWith('http://127.0.0.1:7777/callback?code=redacted')
  })

  it('does not call the server for a missing request id', async () => {
    routeQuery.request_id = undefined
    const View = (await import('@/views/McpOAuthApprovalView.vue')).default
    const wrapper = mount(View)
    expect(wrapper.get('[data-testid="mcp-oauth-approve"]').attributes('disabled')).toBeDefined()
    expect(approveMock).not.toHaveBeenCalled()
  })

  it('keeps consent disabled when request metadata is unavailable', async () => {
    requestMock.mockRejectedValue(new Error('expired'))
    const View = (await import('@/views/McpOAuthApprovalView.vue')).default
    const wrapper = mount(View)
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="mcp-oauth-approve"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('expired')
  })
})
