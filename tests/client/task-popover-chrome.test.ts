import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

// The new-task composer and the 新建自动化任务 dialog are the same control twice:
// agent pill, scope drop, model pill, "+" menu, usage pill. Their popovers had
// drifted into two chromes — some flat with a hairline ring, some with a
// notification drop shadow — so the identical menu looked like a different
// control depending on which surface you opened it from.
//
// The prototype settles it: across athand-shell/work/manage.jsx there is not a
// single drop shadow — every popover is `inset 0 0 0 0.5px var(--divider),
// 0 0 0 0.5px var(--divider)` — and §7.1 keeps these surfaces flat. These
// assertions keep the two surfaces on that one chrome.
const HAIRLINE = /box-shadow:\s*inset 0 0 0 0\.5px var\(--divider\),\s*0 0 0 0\.5px var\(--divider\)/

const SURFACES = {
  'ChatInput.vue': 'packages/client/src/components/hermes/chat/ChatInput.vue',
  'ChatPanel.vue': 'packages/client/src/components/hermes/chat/ChatPanel.vue',
  'AgentPicker.vue': 'packages/client/src/components/hermes/agents/AgentPicker.vue',
  'JobFormModal.vue': 'packages/client/src/components/hermes/jobs/JobFormModal.vue',
} as const

function source(file: keyof typeof SURFACES): string {
  return readFileSync(SURFACES[file], 'utf8')
}

/** The style block for one class, up to its closing brace at column 0. */
function block(src: string, selector: string): string {
  const start = src.indexOf(`\n${selector} {`)
  expect(start, `${selector} not found`).toBeGreaterThan(-1)
  const end = src.indexOf('\n}', start)
  return src.slice(start, end)
}

describe('task-surface popovers share one chrome', () => {
  const cases: Array<[keyof typeof SURFACES, string]> = [
    ['JobFormModal.vue', '.af-menu'], // automation dialog: agent / scope / repeat / model
    ['ChatInput.vue', '.add-menu'], // composer "+"
    ['ChatInput.vue', '.usage-popover'], // composer usage pill
    ['AgentPicker.vue', '.agent-dropdown'], // composer agent pill
    ['ChatPanel.vue', '.model-menu'], // composer model pill
  ]

  it.each(cases)('%s %s is flat with a double hairline ring', (file, selector) => {
    const css = block(source(file), selector)
    expect(css).toMatch(HAIRLINE)
    expect(css).not.toContain('--shadow-notification')
  })

  it('gives every menu row the prototype `.row` hover ground', () => {
    // --surface-3, not one file's --gray-f7 and another's --gray-fa.
    for (const [file, selector] of [
      ['JobFormModal.vue', '.af-menu-row'],
      ['JobFormModal.vue', '.af-agent-row'],
      ['JobFormModal.vue', '.af-drop-row'],
      ['AgentPicker.vue', '.agent-dropdown-item'],
      ['ChatInput.vue', '.add-menu__row'],
    ] as Array<[keyof typeof SURFACES, string]>) {
      const css = block(source(file), selector)
      expect(css, `${file} ${selector}`).toContain('background: var(--surface-3)')
    }
  })

  it('dims a disabled scope row whole, not just its label', () => {
    // A greyed label beside a full-strength icon reads as an enabled row.
    const css = block(source('JobFormModal.vue'), '.af-drop-row')
    expect(css).toMatch(/&:disabled \{[^}]*opacity: 0\.4/)
  })
})
