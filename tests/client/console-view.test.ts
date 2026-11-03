// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConsoleView from '../../packages/client/src/views/hermes/ConsoleView.vue'

function json(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
}

describe('ConsoleView developer fleet panel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('labels the owner fleet count and renders kind badges', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/me') {
        return json({ user: { name: 'sunke', openid: 'ou_self', consoleRole: 'developer' } })
      }
      if (url === '/api/console/dev/me') {
        return json({
          agents: [
            { name: 'sunke', profile: 'sunke', kind: 'user', active: 1 },
            { name: '自动化助手', profile: 'ag_auto', kind: 'agent', active: 1 },
            { name: '数据群', profile: 'grp_data', kind: 'group', active: 1 },
          ],
          api_catalog: [],
        })
      }
      return json({})
    }))

    const wrapper = mount(ConsoleView)
    await flushPromises()
    await flushPromises()

    expect(wrapper.text()).toContain('我名下全部')
    expect(wrapper.text()).toContain('档案 / Agent / 群')
    expect(wrapper.text()).toContain('3 个')
    expect(wrapper.findAll('.kind-badge').map(node => node.text())).toEqual(['档案', 'Agent', '群'])
    expect(wrapper.findAll('.cpanel table tr')).toHaveLength(4)
  })
})
