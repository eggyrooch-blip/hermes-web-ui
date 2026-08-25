// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import SessionListItem from '@/components/hermes/chat/SessionListItem.vue'

const appStoreMocks = vi.hoisted(() => ({
  profileModelGroups: [] as any[],
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => appStoreMocks,
}))

vi.mock('vue-i18n', () => ({
  // `locale` is real here: the row formats its time with it.
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en-US' } }),
}))

vi.mock('naive-ui', () => ({
  NCheckbox: defineComponent({
    name: 'NCheckbox',
    props: ['checked'],
    emits: ['click'],
    template: '<input type="checkbox" :checked="checked" @click="$emit(\'click\')" />',
  }),
}))

const session = {
  id: 's1',
  title: 'Session One',
  model: 'gpt-test',
  provider: 'openai',
  createdAt: Date.now(),
  profile: 'kira',
}

function mountRow(props: Record<string, unknown> = {}) {
  return mount(SessionListItem, {
    props: {
      session,
      active: false,
      pinned: false,
      canDelete: true,
      ...props,
    },
  })
}

describe('SessionListItem', () => {
  beforeEach(() => {
    appStoreMocks.profileModelGroups = []
  })

  it('shows when the task was last active, formatted like the message list', () => {
    // 2024-06-18 10:15 local, with "now" the same day -> time only.
    const at = new Date(2024, 5, 18, 10, 15).getTime()
    const wrapper = mountRow({ session: { ...session, lastActiveAt: at } })

    const time = wrapper.get('.session-item-time').text()
    expect(time).toMatch(/10:15/)
  })

  it('falls back to updatedAt when the payload carries no lastActiveAt', () => {
    const at = new Date(2024, 5, 18, 9, 5).getTime()
    const wrapper = mountRow({ session: { ...session, updatedAt: at } })

    expect(wrapper.get('.session-item-time').text()).toMatch(/9:05|09:05/)
  })

  it('renders no time cell at all when the session has no timestamp', () => {
    // An empty cell would still hold its width and push the title's fade in.
    const wrapper = mountRow()
    expect(wrapper.find('.session-item-time').exists()).toBe(false)
  })

  it('renders normal mode as a link to the session route', () => {
    const wrapper = mountRow({ to: '/session/s1' })

    const link = wrapper.get('a.session-item')
    expect(link.attributes('href')).toBe('/session/s1')
    expect(wrapper.find('button.session-item').exists()).toBe(false)
  })

  it('renders selectable mode as a button and does not expose row href', () => {
    const wrapper = mountRow({ selectable: true, selected: false, to: '/session/s1' })

    expect(wrapper.find('button.session-item').exists()).toBe(true)
    expect(wrapper.find('a.session-item').exists()).toBe(false)
  })

  // Prototype task row: ONE line — dot + title + optional flag + "⋯". The old
  // second line (agent logo / user avatar / workspace) and the time stamp are
  // gone by design.
  it('renders the prototype single-line anatomy without metadata rows', () => {
    const wrapper = mountRow({
      session: { ...session, workspace: 'clients/acme' },
      to: '/session/s1',
    })

    expect(wrapper.find('.session-item-state-dot').exists()).toBe(true)
    expect(wrapper.get('.session-item-title').text()).toBe('Session One')
    expect(wrapper.find('.session-item-agent-logo').exists()).toBe(false)
    expect(wrapper.find('.session-item-workspace').exists()).toBe(false)
    expect(wrapper.find('.session-item-time').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('acme')
  })

  it('shows a neutral dot for idle rows and a pulsing green dot while running', () => {
    const idle = mountRow()
    const idleDot = idle.get('.session-item-state-dot')
    expect(idleDot.classes()).not.toContain('is-run')
    expect(idleDot.classes()).not.toContain('is-error')

    const running = mountRow({ streaming: true })
    const runDot = running.get('.session-item-state-dot')
    expect(runDot.classes()).toContain('is-run')
    expect(runDot.classes()).toContain('pulse')
  })

  it('shows a green dot for completed-unread rows', () => {
    const wrapper = mountRow({ completedUnread: true })
    expect(wrapper.get('.session-item-state-dot').classes()).toContain('is-unread')
  })

  it('turns the dot to danger and titles the row when the profile has no models', () => {
    appStoreMocks.profileModelGroups = [
      { profile: 'other', groups: [{ provider: 'openai', label: 'OpenAI', models: ['gpt'] }] },
    ]
    const wrapper = mountRow()

    expect(wrapper.get('.session-item-state-dot').classes()).toContain('is-error')
    expect(wrapper.get('.session-item').attributes('title')).toBe('chat.profileMissingModelsTip')
  })

  it('marks pinned rows with the prototype flag glyph after the title', () => {
    const wrapper = mountRow({ pinned: true })
    expect(wrapper.find('.session-item-state-flag').exists()).toBe(true)
  })

  it('does not select the row when clicking nested action controls', async () => {
    const wrapper = mountRow({ to: '/session/s1' })

    // The prototype's per-row "⋯" opens the row menu (contextmenu) and must
    // never select the row.
    await wrapper.get('button.session-item-menu').trigger('click')
    expect(wrapper.emitted('select')).toBeUndefined()
    expect(wrapper.emitted('contextmenu')).toBeTruthy()
  })

  it('does not hijack modified clicks on normal links', async () => {
    const wrapper = mountRow({ to: '/session/s1' })

    const link = wrapper.get('a.session-item')
    link.element.addEventListener('click', event => event.preventDefault())
    await link.trigger('click', { ctrlKey: true })
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  // The title is edited where it sits rather than in a dialog over the list.
  describe('renaming in place', () => {
    it('swaps the title for a field seeded from the current name', () => {
      const wrapper = mountRow({ renaming: true, to: '/session/s1' })

      const field = wrapper.get('input.session-item-rename')
      expect((field.element as HTMLInputElement).value).toBe('Session One')
      expect(wrapper.find('.session-item-title').exists()).toBe(false)
    })

    it('clears the rest of the row so nothing overlaps the field', () => {
      // The field stretches to the row's edges with negative margins, so a
      // control still holding its place sits on top of the pill's rounded end
      // and punches a hole through it. All three go, and the fix is emphatically
      // not to shorten the field to make room for them.
      const wrapper = mountRow({ renaming: true, pinned: true, to: '/session/s1' })

      expect(wrapper.find('.session-item-state-dot').exists()).toBe(false)
      expect(wrapper.find('.session-item-state-flag').exists()).toBe(false)
      expect(wrapper.find('.session-item-menu').exists()).toBe(false)
    })

    it('stops being a link so the field is not nested in interactive content', () => {
      // An <input> inside <a>/<button> is invalid, and clicking the field would
      // navigate to the session instead of placing the caret.
      const wrapper = mountRow({ renaming: true, to: '/session/s1' })

      expect(wrapper.find('a.session-item').exists()).toBe(false)
      expect(wrapper.find('button.session-item').exists()).toBe(false)
      expect(wrapper.get('.session-item').element.tagName).toBe('DIV')
      expect(wrapper.get('.session-item').attributes('href')).toBeUndefined()
    })

    it('commits the trimmed value on Enter', async () => {
      const wrapper = mountRow({ renaming: true, to: '/session/s1' })

      const field = wrapper.get('input.session-item-rename')
      await field.setValue('  Quarterly review  ')
      await field.trigger('keydown', { key: 'Enter' })

      expect(wrapper.emitted('rename-commit')).toEqual([['Quarterly review']])
    })

    it('treats an empty name as no change rather than deleting the title', async () => {
      const wrapper = mountRow({ renaming: true, to: '/session/s1' })

      const field = wrapper.get('input.session-item-rename')
      await field.setValue('   ')
      await field.trigger('keydown', { key: 'Enter' })

      expect(wrapper.emitted('rename-commit')).toBeUndefined()
      expect(wrapper.emitted('rename-cancel')).toBeTruthy()
    })

    it('commits on blur, which is how clicking away saves', async () => {
      const wrapper = mountRow({ renaming: true, to: '/session/s1' })

      const field = wrapper.get('input.session-item-rename')
      await field.setValue('Renamed by clicking away')
      await field.trigger('blur')

      expect(wrapper.emitted('rename-commit')).toEqual([['Renamed by clicking away']])
    })

    it('discards the draft on Escape even though blur follows', async () => {
      // Escape clears the row's editing state, and removing a focused field can
      // fire blur on the way out — which would commit the draft Escape just
      // discarded. Simulated here by firing blur straight after.
      const wrapper = mountRow({ renaming: true, to: '/session/s1' })

      const field = wrapper.get('input.session-item-rename')
      await field.setValue('Typed then abandoned')
      await field.trigger('keydown', { key: 'Escape' })
      expect(wrapper.emitted('rename-cancel')).toBeTruthy()

      await wrapper.setProps({ renaming: false })
      await field.trigger('blur')
      expect(wrapper.emitted('rename-commit')).toBeUndefined()
    })

    it('selects from the start without waiting for a focus event', async () => {
      // The focus is ours — we call it — so the follow-up work must not depend on
      // the resulting event being delivered. Two real cases where it is not:
      // focusing an already-focused element fires nothing, and a browser whose
      // document is not focused dispatches nothing either (which is how this was
      // found: measured in a backgrounded pane, the field opened scrolled to the
      // END of a long title with the opening words cut off).
      //
      // `focus` is stubbed to a no-op here so the event cannot fire at all.
      const focusSpy = vi
        .spyOn(HTMLInputElement.prototype, 'focus')
        .mockImplementation(() => {})
      try {
        const wrapper = mountRow({ renaming: true, to: '/session/s1' })
        await nextTick()
        await nextTick()

        const el = wrapper.get('input.session-item-rename').element as HTMLInputElement
        expect(focusSpy).toHaveBeenCalled()
        expect(el.selectionStart).toBe(0)
        expect(el.selectionEnd).toBe('Session One'.length)
        expect(el.scrollLeft).toBe(0)
      } finally {
        focusSpy.mockRestore()
      }
    })

    it('selects the whole name and scrolls back to its start on focus', async () => {
      // A title wider than the field otherwise focuses scrolled to the caret at
      // the end, showing the tail with the opening words cut off outside the box.
      // Setting the selection direction alone does not scroll — changing a
      // selection does not re-run the browser's scroll-into-view — so direction
      // and scroll are set separately.
      const wrapper = mountRow({ renaming: true, to: '/session/s1' })

      const field = wrapper.get('input.session-item-rename')
      const el = field.element as HTMLInputElement
      const setSelectionRange = vi.spyOn(el, 'setSelectionRange')
      el.scrollLeft = 43

      await field.trigger('focus')

      expect(setSelectionRange).toHaveBeenCalledWith(0, 'Session One'.length, 'backward')
      expect(el.scrollLeft).toBe(0)
    })
  })
})
