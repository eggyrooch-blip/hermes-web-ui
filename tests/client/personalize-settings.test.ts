// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'

const mockMessage = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
const mockStore = vi.hoisted(() => ({
  memory: {} as Record<string, unknown>,
  updateLocal: vi.fn(),
  saveSection: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => mockMessage,
  NSwitch: {
    props: ['value', 'disabled'],
    template: '<button class="n-switch" :disabled="disabled" @click="$emit(\'update:value\', !value)" />',
  },
  NInputNumber: {
    props: ['value', 'disabled'],
    template: '<input class="n-input-number" :disabled="disabled" />',
  },
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => mockStore,
}))

const PersonalizeSettings = (
  await import('@/components/hermes/settings/PersonalizeSettings.vue')
).default

function mountPane(canEdit = true) {
  return mount(PersonalizeSettings, { props: { canEdit } })
}

describe('PersonalizeSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStore.memory = reactive({})
    mockStore.saveSection.mockResolvedValue(undefined)
  })

  it('lists the six sections from the prototype', () => {
    const wrapper = mountPane()

    expect(wrapper.findAll('.kp-tabstrip__tab').map(tab => tab.text())).toEqual([
      'settings.personalize.sections.basic',
      'settings.personalize.sections.pref',
      'settings.personalize.sections.goal',
      'settings.personalize.sections.peer',
      'settings.personalize.sections.group',
      'settings.personalize.sections.cal',
    ])
  })

  it('shows the turn-it-on state instead of half-open sections while memory is off', async () => {
    const wrapper = mountPane()

    expect(wrapper.find('.kp-empty__title').text()).toBe('settings.personalize.offTitle')
    // No settings rows are reachable, on any section, until it is on.
    expect(wrapper.findAll('.setting-row')).toHaveLength(0)

    await wrapper.get('.kp-empty__action button').trigger('click')
    expect(mockStore.saveSection).toHaveBeenCalledWith('memory', { memory_enabled: true })
  })

  it('drives the master switch off the real memory setting, not a local flag', async () => {
    mockStore.memory.memory_enabled = true
    const wrapper = mountPane()

    expect(wrapper.get('[data-testid="personalize-master"]').classes()).toContain('is-on')

    await wrapper.get('[data-testid="personalize-master"]').trigger('click')
    expect(mockStore.saveSection).toHaveBeenCalledWith('memory', { memory_enabled: false })
  })

  it('gives 基础配置 the real memory rows once it is on', () => {
    mockStore.memory.memory_enabled = true
    const wrapper = mountPane()

    expect(wrapper.findAll('.setting-row').length).toBeGreaterThan(0)
    expect(wrapper.text()).toContain('settings.memory.userProfile')
  })

  it('says a section has no source rather than showing invented rows', async () => {
    mockStore.memory.memory_enabled = true
    const wrapper = mountPane()

    await wrapper.get('[data-testid="tabstrip-peer"]').trigger('click')

    expect(wrapper.find('.kp-empty__title').text()).toBe('settings.personalize.pending.peer')
    expect(wrapper.findAll('.setting-row')).toHaveLength(0)
  })

  it('leaves every control read-only for a user who cannot write config', () => {
    mockStore.memory.memory_enabled = true
    const wrapper = mountPane(false)

    expect(wrapper.get('[data-testid="personalize-master"]').attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('.n-switch').every(node => node.attributes('disabled') !== undefined)).toBe(true)
  })
})
