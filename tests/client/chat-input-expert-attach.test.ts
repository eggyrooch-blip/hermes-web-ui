// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// Prototype parity: picking an expert from the "+" AddMenu does not stamp the
// session immediately. It becomes a removable pill in the composer (mirrors
// the prototype's generic `attachments` model: onAttach({type:"expert",...})
// consumed by onSend) and only takes effect once the message is sent.

const chatStoreMock = vi.hoisted(() => ({
  activeSession: { id: 's1', source: 'cli', profile: 'p1' } as any,
  activeSessionId: 's1',
  activeExpertId: null as string | null,
  isStreaming: false,
  isAborting: false,
  setActiveExpert: vi.fn(),
  setAutoPlaySpeech: vi.fn(),
  sendMessage: vi.fn(),
  stopStreaming: vi.fn(),
}))

const appStoreMock = vi.hoisted(() => ({
  selectedModel: 'default-model',
  selectedProvider: 'default-provider',
}))

const profilesStoreMock = vi.hoisted(() => ({
  activeProfileName: 'p1',
  profiles: [{ name: 'p1', active: true, model: '', alias: '' }] as any[],
  loading: false,
}))

const fetchExpertsMock = vi.hoisted(() => vi.fn())
const fetchSlashCommandsMock = vi.hoisted(() => vi.fn())
const fetchSkillsMock = vi.hoisted(() => vi.fn())

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => chatStoreMock,
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => appStoreMock,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStoreMock,
}))

vi.mock('@/api/hermes/experts', () => ({
  fetchExperts: fetchExpertsMock,
}))

vi.mock('@/api/hermes/sessions', () => ({
  fetchContextLength: vi.fn(() => Promise.resolve(200000)),
}))

vi.mock('@/api/hermes/model-context', () => ({
  setModelContext: vi.fn(),
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: fetchSkillsMock,
}))

vi.mock('@/api/hermes/slash', () => ({
  fetchSlashCommands: fetchSlashCommandsMock,
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
  NButton: {
    // `emits` must be declared: otherwise Vue treats the parent's `@click`
    // listener as a fallthrough attribute AND binds it as a native listener
    // on the root button, on top of this template's own `$emit('click')` —
    // so a single real click fires the parent handler twice (open, then
    // immediately close again for a toggle like the AddMenu button).
    emits: ['click'],
    template: '<button type="button" @click="$emit(\'click\', $event)"><slot /><slot name="icon" /></button>',
  },
  NTooltip: {
    template: '<span><slot name="trigger" /><slot /></span>',
  },
  NSwitch: {
    template: '<input type="checkbox" />',
  },
  NModal: {
    props: ['show'],
    template: '<div v-if="show"><slot /><slot name="footer" /></div>',
  },
  NInputNumber: {
    template: '<input />',
  },
  NPopselect: {
    props: ['value', 'options'],
    template: '<div><slot /></div>',
  },
  NPopover: {
    template: '<div class="n-popover-stub"><slot name="trigger" /><slot /></div>',
  },
  useMessage: () => ({
    error: vi.fn(),
    success: vi.fn(),
  }),
}))

import ChatInput from '@/components/hermes/chat/ChatInput.vue'

// The AddMenu (level-1 rows + expert flyout) renders via <Teleport to="body">,
// so it lands outside the mounted wrapper's own DOM tree — query real DOM.
function addMenuRows(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('.add-menu__row'))
}

async function openAddMenuAndHoverExpert(wrapper: ReturnType<typeof shallowMount>) {
  await wrapper.get('.add-menu-anchor .attach-button').trigger('click')
  await flushPromises()
  addMenuRows()[1].dispatchEvent(new Event('mouseenter', { bubbles: true }))
  await flushPromises()
}

function findExpertRow(): HTMLElement {
  const row = addMenuRows().find(el => el.textContent?.includes('合同审查专家'))
  if (!row) throw new Error('expert row not found in AddMenu flyout')
  return row
}

describe('ChatInput "+" expert attachment (prototype parity)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    localStorage.clear()
    chatStoreMock.activeSession = { id: 's1', source: 'cli', profile: 'p1' }
    chatStoreMock.activeSessionId = 's1'
    chatStoreMock.activeExpertId = null
    fetchExpertsMock.mockResolvedValue({
      experts: [{ id: 'e1', name: '合同审查专家', title: '合同审查专家' }],
    })
    fetchSlashCommandsMock.mockResolvedValue({ ok: true, commands: [] })
    fetchSkillsMock.mockResolvedValue({ categories: [] })
  })

  // The menus render into document.body and `addMenuRows()` queries it
  // globally, so a wrapper left mounted keeps its rows in the DOM. Without
  // this, a failure in one case makes the NEXT case click a dead row from the
  // previous one and fail for a reason that has nothing to do with it.
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('shows a removable pill and does NOT stamp the session when an expert is picked', async () => {
    const wrapper = mount(ChatInput)
    await flushPromises()

    await openAddMenuAndHoverExpert(wrapper)
    findExpertRow().dispatchEvent(new Event('click', { bubbles: true }))
    await flushPromises()

    expect(chatStoreMock.setActiveExpert).not.toHaveBeenCalled()
    expect(wrapper.find('.expert-chip').exists()).toBe(true)
    expect(wrapper.get('.expert-chip').text()).toContain('合同审查专家')
  })

  it('commits the pending expert and clears the pill only when the message is sent', async () => {
    const wrapper = mount(ChatInput)
    await flushPromises()

    await openAddMenuAndHoverExpert(wrapper)
    findExpertRow().dispatchEvent(new Event('click', { bubbles: true }))
    await flushPromises()

    expect(chatStoreMock.setActiveExpert).not.toHaveBeenCalled()

    await wrapper.get('textarea').setValue('帮我看看这份合同')
    await wrapper.get('.send-button').trigger('click')

    expect(chatStoreMock.setActiveExpert).toHaveBeenCalledWith('e1', expect.objectContaining({ label: '合同审查专家' }))
    expect(chatStoreMock.sendMessage).toHaveBeenCalledWith('帮我看看这份合同', undefined)
    expect(wrapper.find('.expert-chip').exists()).toBe(false)
  })

  it('a picked skill becomes a pill and its slash command is prepended on send', async () => {
    // The 技能 flyout lists SKILLS (fetchSkills), not the broker's slash
    // registry. Slash commands are deliberately left non-empty here: if the
    // flyout ever reads them again, the row lookup below finds the wrong text.
    fetchSkillsMock.mockResolvedValue({
      categories: [
        { name: 'growth', skills: [{ name: 'strategy', description: '投放策略', enabled: true }] },
      ],
    })
    fetchSlashCommandsMock.mockResolvedValue({
      ok: true,
      commands: [
        { name: 'clear-broker', slash: '/clear-broker', title: '', description: "Clear this profile's broker context.", source: 'broker', type: 'command', category: '' },
      ],
    })
    const wrapper = mount(ChatInput)
    await flushPromises()

    // Open "+", hover 技能 (row index 2), pick the skill from the flyout.
    await wrapper.get('.add-menu-anchor .attach-button').trigger('click')
    await flushPromises()
    addMenuRows()[2].dispatchEvent(new Event('mouseenter', { bubbles: true }))
    await flushPromises()

    // The row is labelled with the skill's NAME, never its description and
    // never a broker command.
    const flyoutText = addMenuRows().map(el => el.textContent ?? '').join(' | ')
    expect(flyoutText).toContain('strategy')
    expect(flyoutText).not.toContain('投放策略')
    expect(flyoutText).not.toContain('Clear this profile')

    const skillRow = addMenuRows().find(el => el.textContent?.includes('strategy'))
    if (!skillRow) throw new Error('skill row not found in AddMenu flyout')
    skillRow.dispatchEvent(new Event('click', { bubbles: true }))
    await flushPromises()

    // Pill shown; nothing sent or inserted into the textarea yet.
    expect(wrapper.find('[data-testid="skill-chip"]').exists()).toBe(true)
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('')
    expect(chatStoreMock.sendMessage).not.toHaveBeenCalled()

    await wrapper.get('textarea').setValue('对比各大区营收')
    await wrapper.get('.send-button').trigger('click')

    expect(chatStoreMock.sendMessage).toHaveBeenCalledWith('/strategy 对比各大区营收', undefined)
    expect(wrapper.find('[data-testid="skill-chip"]').exists()).toBe(false)
  })

  it('removing the pill clears the pending pick without ever stamping the session', async () => {
    const wrapper = mount(ChatInput)
    await flushPromises()

    await openAddMenuAndHoverExpert(wrapper)
    findExpertRow().dispatchEvent(new Event('click', { bubbles: true }))
    await flushPromises()

    expect(wrapper.find('.expert-chip').exists()).toBe(true)
    await wrapper.get('.expert-chip__remove').trigger('click')

    expect(wrapper.find('.expert-chip').exists()).toBe(false)
    expect(chatStoreMock.setActiveExpert).not.toHaveBeenCalled()
  })
})
