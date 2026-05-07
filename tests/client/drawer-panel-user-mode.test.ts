// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const isUserModeMock = vi.hoisted(() => vi.fn(() => false))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/api/client', () => ({
  isUserMode: isUserModeMock,
}))

vi.mock('@/components/hermes/chat/TerminalPanel.vue', () => ({
  default: {
    template: '<div data-testid="terminal-panel">terminal</div>',
  },
}))

vi.mock('@/components/hermes/chat/FilesPanel.vue', () => ({
  default: {
    template: '<div data-testid="files-panel">files</div>',
  },
}))

import DrawerPanel from '@/components/hermes/chat/DrawerPanel.vue'

describe('DrawerPanel user mode', () => {
  beforeEach(() => {
    isUserModeMock.mockReturnValue(false)
    document.body.innerHTML = ''
  })

  it('hides the terminal tab and panel in user mode', () => {
    isUserModeMock.mockReturnValue(true)

    const wrapper = mount(DrawerPanel, {
      props: {
        show: true,
        activeTab: 'terminal',
      },
      attachTo: document.body,
    })

    expect(document.body.textContent).toContain('drawer.files')
    expect(document.body.textContent).not.toContain('drawer.terminal')
    expect(document.body.querySelector('[data-testid="files-panel"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="terminal-panel"]')).toBeFalsy()
  })
})
