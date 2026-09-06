// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key === 'expert.detail.engineHarness' ? 'Codex' : key }),
}))
vi.mock('@/components/hermes/expert/ExpertWorkRecord.vue', () => ({
  default: { template: '<div />' },
}))

import ExpertDetailPanel from '@/components/hermes/expert/ExpertDetailPanel.vue'

const expert = { id: 'server-dev', name: 'Server Dev', skills: [], harness_available: true } as any

describe('ExpertDetailPanel Codex engine selection', () => {
  it('defaults to Hermes and emits the internal harness value for Codex', async () => {
    const wrapper = mount(ExpertDetailPanel, { props: { expert } })
    expect((wrapper.find('input[value="hermes"]').element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.text()).toContain('Codex')
    expect(wrapper.text()).not.toContain('Harness')

    await wrapper.find('input[value="harness"]').setValue(true)
    await wrapper.find('button.action-primary').trigger('click')

    expect(wrapper.emitted('activate')?.[0]).toEqual([expert, 'harness'])
    wrapper.unmount()
  })

  it('does not offer Codex when the server capability is off', () => {
    const wrapper = mount(ExpertDetailPanel, {
      props: { expert: { ...expert, harness_available: false } },
    })

    expect(wrapper.find('input[value="harness"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
