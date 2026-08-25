// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: defineComponent({
    emits: ['click'],
    template: '<button class="schedule-button" @click="$emit(\'click\')"><slot /></button>',
  }),
}))

vi.mock('@/components/hermes/jobs/JobFormModal.vue', () => ({
  default: defineComponent({
    name: 'JobFormModal',
    props: [
      'jobId',
      'initialName',
      'initialPrompt',
      'initialSkills',
      'sourceSessionId',
      'expertId',
      'idempotencyKey',
    ],
    emits: ['close', 'saved'],
    template: '<div class="job-form-modal" />',
  }),
}))

import JobFormModal from '@/components/hermes/jobs/JobFormModal.vue'
import ChatScheduledEntry from '@/components/hermes/chat/ChatScheduledEntry.vue'

describe('ChatScheduledEntry', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'schedule-key-1') })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('opens the existing form with the bound session intent and closes without submitting', async () => {
    const wrapper = mount(ChatScheduledEntry, {
      props: {
        sessionId: 'session-expert',
        expertId: 'keep-resource-delivery',
        expertLabel: '资源投放专家',
        initialName: '资源投放工作',
        initialPrompt: '每天检查投放队列',
        initialSkills: ['Campaign planning'],
      },
    })

    expect(wrapper.findComponent(JobFormModal).exists()).toBe(false)
    await wrapper.get('.schedule-button').trigger('click')

    const modal = wrapper.getComponent(JobFormModal)
    expect(modal.props()).toMatchObject({
      jobId: null,
      initialName: '资源投放工作',
      initialPrompt: '每天检查投放队列',
      initialSkills: ['Campaign planning'],
      sourceSessionId: 'session-expert',
      expertId: 'keep-resource-delivery',
      idempotencyKey: 'schedule-key-1',
    })

    await modal.vm.$emit('close')
    expect(wrapper.findComponent(JobFormModal).exists()).toBe(false)
  })
})
