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

describe('ExpertDetailPanel 试试这样问我', () => {
  it('renders the author-written sample prompts verbatim and emits ask with the selected engine', async () => {
    const authored = {
      id: 'kep-expert-builder',
      name: '专家构建专家',
      title: '专家构建专家',
      display_tags: ['专家框架', '元专家'],
      skills: ['build-expert'],
      harness_available: true,
      sample_prompts: [
        '我想把我们组的业务做成一个专家，先带我看看要准备什么',
        '帮我给已发布的专家发个新版本，改动是更新了两个技能',
        '建专家和写普通 skill 有什么区别？我该选哪个',
      ],
    } as any

    const wrapper = mount(ExpertDetailPanel, { props: { expert: authored } })
    const rows = wrapper.findAll('.sample-row')
    expect(rows.map(row => row.find('.sample-text').text())).toEqual(authored.sample_prompts)
    expect(wrapper.text()).toContain('expert.detail.samplePrompts')

    await rows[0].trigger('click')
    expect(wrapper.emitted('ask')?.[0]).toEqual([authored.sample_prompts[0], 'hermes'])

    // the row is keyboard-operable, and it carries the engine picker's value
    await wrapper.find('input[value="harness"]').setValue(true)
    await rows[1].trigger('keydown.enter')
    expect(wrapper.emitted('ask')?.[1]).toEqual([authored.sample_prompts[1], 'harness'])

    // clicking a prompt never starts the chat on its own
    expect(wrapper.emitted('activate')).toBeUndefined()
    wrapper.unmount()
  })

  it('renders three generated prompts when the expert declares none', async () => {
    const wrapper = mount(ExpertDetailPanel, {
      props: {
        expert: { id: 'hr', name: '薪酬顾问', display_tags: [], skills: ['payroll'] } as any,
      },
    })

    const texts = wrapper.findAll('.sample-row').map(row => row.find('.sample-text').text())
    expect(texts).toHaveLength(3)
    expect(texts.every(line => line.includes('薪酬'))).toBe(true)
    expect(texts.some(line => line.includes('payroll'))).toBe(true)
    wrapper.unmount()
  })
})
