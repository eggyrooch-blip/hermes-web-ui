// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import McpManagerView from '@/views/hermes/McpManagerView.vue'

const mocks = vi.hoisted(() => ({
  fetchMcpServers: vi.fn(),
}))

vi.mock('@/api/hermes/mcp', () => ({
  fetchMcpServers: mocks.fetchMcpServers,
  fetchMcpTools: vi.fn(),
  mcpServerAdd: vi.fn(),
  mcpServerRemove: vi.fn(),
  mcpServerUpdate: vi.fn(),
  mcpServerTest: vi.fn(),
  mcpReload: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  isStoredSuperAdmin: () => false,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NAlert: { template: '<div class="n-alert"><slot /></div>' },
  NButton: { props: ['loading'], template: '<button class="n-button" :data-loading="String(!!loading)" @click="$emit(\'click\')"><slot /></button>' },
  NCheckbox: { template: '<input type="checkbox" />' },
  NEmpty: { props: ['description'], template: '<div class="n-empty">{{ description }}</div>' },
  NInput: { props: ['size'], template: '<input class="n-input" />' },
  NModal: { template: '<div><slot /></div>' },
  NRadioButton: { template: '<button><slot /></button>' },
  NRadioGroup: { template: '<div><slot /></div>' },
  NScrollbar: { template: '<div><slot /></div>' },
  NSpin: { template: '<div class="n-spin" />' },
  useMessage: () => ({
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}))

vi.mock('@/components/hermes/mcp/McpServerCard.vue', () => ({
  default: {
    props: ['server'],
    template: '<article class="mcp-server-card">{{ server.name }}</article>',
  },
}))

function disconnectedServer() {
  return {
    name: 'codegraph',
    transport: 'stdio',
    connected: false,
    tools: 0,
    tools_registered: 0,
    tool_names: [],
    tool_names_registered: [],
    tool_details: [],
    raw_config: { command: 'codegraph', enabled: true },
  }
}

describe('McpManagerView loading behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.fetchMcpServers.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not auto-retry disconnected MCP servers for ordinary read-only users', async () => {
    mocks.fetchMcpServers.mockResolvedValue({ ok: true, servers: [disconnectedServer()] })

    mount(McpManagerView)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(40_000)
    await flushPromises()

    expect(mocks.fetchMcpServers).toHaveBeenCalledTimes(1)
  })

  it('keeps the existing server list visible while a manual refresh is pending', async () => {
    let resolveRefresh: (value: unknown) => void = () => {}
    mocks.fetchMcpServers
      .mockResolvedValueOnce({ ok: true, servers: [disconnectedServer()] })
      .mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve }))

    const wrapper = mount(McpManagerView)
    await flushPromises()
    await wrapper.get('.n-button').trigger('click')
    await flushPromises()

    expect(wrapper.find('.n-spin').exists()).toBe(false)
    expect(wrapper.text()).toContain('codegraph')

    resolveRefresh({ ok: true, servers: [disconnectedServer()] })
    await flushPromises()
  })
})
