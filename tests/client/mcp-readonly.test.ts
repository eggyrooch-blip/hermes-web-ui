// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import McpServerCard from '@/components/hermes/mcp/McpServerCard.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button><slot /></button>' },
  NPopconfirm: { template: '<div><slot name="trigger" /><slot /></div>' },
  NSwitch: { template: '<button class="mock-switch" />' },
}))

const server = {
  name: 'github',
  transport: 'stdio',
  connected: true,
  tools: 1,
  tools_registered: 1,
  tool_names: ['search'],
  tool_names_registered: ['search'],
  tool_details: [{ name: 'search', description: 'Search repositories' }],
  raw_config: { command: 'node', enabled: true },
} as any

describe('McpServerCard read-only mode', () => {
  it('hides mutating controls when ordinary users view MCP servers', () => {
    const wrapper = mount(McpServerCard, {
      props: {
        server,
        toolsByServer: { github: server.tool_details },
        canManage: false,
      },
    })

    expect(wrapper.text()).toContain('github')
    expect(wrapper.text()).toContain('search')
    expect(wrapper.text()).not.toContain('mcp.edit')
    expect(wrapper.text()).not.toContain('mcp.reload')
    expect(wrapper.find('.mock-switch').exists()).toBe(false)
  })
})
