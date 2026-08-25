import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

// There are two composer implementations — the main one (ChatInput) and group
// chat's (GroupChatInput) — because they are wired to different stores and carry
// different controls. What they must NOT differ in is the box: the aurora frame,
// the section order and the insets.
//
// That box used to be written twice, which is exactly how group chat drifted
// onto the pre-Keep look (own border, grey field, tool row above the field, send
// inside the field) and had to be dragged back by hand. It now lives once, in
// ComposerBox, and these assertions keep it that way: the hosts must USE it and
// must not re-declare what it owns.
const BOX = readFileSync('packages/client/src/components/hermes/chat/ComposerBox.vue', 'utf8')
const CHAT_INPUT = readFileSync('packages/client/src/components/hermes/chat/ChatInput.vue', 'utf8')
const GROUP_INPUT = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatInput.vue', 'utf8')
const JOB_FORM = readFileSync('packages/client/src/components/hermes/jobs/JobFormModal.vue', 'utf8')
// The chat composer's model pill is injected by ChatPanel through ChatInput's
// #model slot, so that is where its markup lives.
const CHAT_PANEL_MODEL_PILL = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

// Three surfaces render a composer: the chat one, group chat's, and the prompt
// box inside 新建自动化任务. All three root on the same box.
const HOSTS: Array<[string, string]> = [
  ['ChatInput', CHAT_INPUT],
  ['GroupChatInput', GROUP_INPUT],
  ['JobFormModal', JOB_FORM],
]

/** All style blocks declared for `selector` in `src`. */
function blocks(src: string, selector: string): string[] {
  const found: string[] = []
  let at = src.indexOf(`\n${selector} {`)
  while (at > -1) {
    found.push(src.slice(at, src.indexOf('\n}', at)))
    at = src.indexOf(`\n${selector} {`, at + 1)
  }
  return found
}

describe('the composer box lives in one place', () => {
  it('ComposerBox owns the frame', () => {
    expect(BOX).toContain('class="chat-input-area beam"')
    // All three aurora layers, in one template.
    expect(BOX).toContain('class="beamfill"')
    expect(BOX).toContain('class="beamedge"')
    expect(BOX).toContain('class="beamring"')

    const box = blocks(BOX, '.chat-input-area')[0]
    expect(box).toContain('padding: 1px')
    expect(box).toContain('border-radius: var(--r-sheet)')
    // Referenced by token: --shadow-toast IS 0 4px 16px rgba(0,0,0,.08), and the
    // handoff forbids hand-written shadow values.
    expect(box).toContain('box-shadow: var(--shadow-toast)')
    expect(box).toContain('border-top: 0')
  })

  it('ComposerBox owns the section order and insets', () => {
    // Reached through :deep() because the sections are slotted content — the
    // hosts keep their refs, handlers and host-specific styling.
    const field = blocks(BOX, ':deep(.input-wrapper)')[0]
    const tools = blocks(BOX, ':deep(.input-top-bar)')[0]
    const strip = blocks(BOX, ':deep(.attachment-previews)')[0]

    expect(field).toContain('order: 1')
    expect(field).toContain('padding: 20px 24px 0')
    // The frame IS the beam layers; a ground here would cover them.
    expect(field).toContain('background-color: transparent')
    expect(tools).toContain('order: 2')
    // 16 all round, not 8 on top: the 16 underneath is the row's distance to the
    // hairline over the scope row, so the row moves down by growing the top
    // inset rather than by spending the bottom one.
    expect(tools).toContain('padding: 16px')
    expect(strip).toContain('padding: 12px 20px 0')

    // .beamfill is an opaque z0 layer, so every static section has to be lifted
    // above it. This is not theoretical — it is how slash pills once vanished.
    for (const [name, block] of [['field', field], ['tools', tools], ['strip', strip]]) {
      expect(block, `${name} needs z-index 5`).toContain('z-index: 5')
    }
  })

  it.each(HOSTS)('%s roots on ComposerBox rather than its own box', (_name, src) => {
    expect(src).toMatch(/import ComposerBox from/)
    expect(src).toMatch(/<ComposerBox[\s>]/)
    // No second copy of the frame anywhere in the host.
    expect(src).not.toContain('class="chat-input-area beam"')
    expect(src).not.toContain('class="beamfill"')
    expect(blocks(src, '.chat-input-area')).toHaveLength(0)
  })

  it.each(HOSTS)('%s does not re-declare what the box owns', (_name, src) => {
    for (const selector of ['.input-wrapper', '.input-top-bar', '.attachment-previews']) {
      const declared = blocks(src, selector).join('\n')
      for (const prop of ['order:', 'z-index: 5', 'padding: 20px 24px', 'padding: 16px;', 'padding: 12px 20px 0']) {
        expect(declared, `${selector} should leave ${prop} to ComposerBox`).not.toContain(prop)
      }
    }
  })

  it('keeps the follow-up (is-run) form a prop of the shared box', () => {
    // The demoted follow-up field is a variant of the one box, not a fork of it.
    expect(BOX).toContain("'is-run': run")
    expect(BOX).toMatch(/\.chat-input-area\.is-run \{/)
    expect(CHAT_INPUT).toMatch(/<ComposerBox :run="isRunState">/)
    // Group chat has no home state, so it never demotes its composer.
    expect(GROUP_INPUT).toMatch(/<ComposerBox>/)
  })

  it.each([['ChatInput', CHAT_INPUT], ['GroupChatInput', GROUP_INPUT]] as Array<[string, string]>)(
    '%s tool row is attach → spacer → send', (_name, src) => {
    const toolRow = src.slice(src.indexOf('class="input-top-bar"'), src.indexOf('class="attachment-previews"'))
    expect(toolRow).toContain('class="attach-button"')
    expect(toolRow).toContain('class="tool-row-spacer"')
    expect(toolRow).toContain('class="send-button"')
  })

  it.each([['ChatInput', CHAT_INPUT], ['GroupChatInput', GROUP_INPUT]] as Array<[string, string]>)(
    '%s send key is grounded in --gray-33, like every other main button', (_name, src) => {
    // This ground has been three colours and keeps drifting back, so it is
    // pinned here. Green is the STATUS colour (running/succeeded) — on a button
    // it reads as a status badge. Purple is the SELECTION colour, and it left
    // this key as the only purple control in the product. `--gray-33` is what
    // create-agent / new-automation / custom-expert already use.
    const send = blocks(src, '.send-button')[0]
    expect(send).toContain('background-color: var(--gray-33)')
    expect(send).not.toContain('var(--action)')
    expect(send).not.toContain('var(--hue-purple)')
    // Hover/press are the §9.1 overlay at two depths, not a second ground.
    expect(send).toContain('&:hover::after')
    expect(send).toContain('&:active::after')
  })

  it('gives the automation dialog the same tool-row and scope-row slots', () => {
    // No send button there (the sheet's 创建 submits), but the same spacer slot
    // and the same section classes, so the box's insets apply to it too.
    expect(JOB_FORM).toContain('class="input-wrapper af-beam-field"')
    expect(JOB_FORM).toContain('class="input-top-bar"')
    expect(JOB_FORM).toContain('class="input-pillbar af-ctxbar"')
    expect(JOB_FORM).toContain('class="tool-row-spacer"')
    // The hand-rolled inner wrapper and its own beam shell are gone.
    expect(JOB_FORM).not.toContain('af-beam-inner')
    expect(JOB_FORM).not.toContain('af-toolrow')
  })

  it('keeps 推理强度 off every model pill', () => {
    // Reasoning effort follows the model's own config; it is not a user choice,
    // so no composer surface may show or offer it.
    for (const [name, src] of HOSTS) {
      expect(src, `${name} model pill`).not.toContain('effortMedium')
      expect(src, `${name} model pill`).not.toContain('reasoningEffort')
    }
  })

  it('uses the Keep spark glyph on the model pill, never a Unicode character', () => {
    // The handoff forbids substituting characters for icons; the dialog shipped
    // a literal ✦ while the composer used the glyph.
    expect(JOB_FORM).not.toContain('✦')
    expect(JOB_FORM).toContain('name="full_star_ai"')
    expect(CHAT_PANEL_MODEL_PILL).toContain('name="full_star_ai"')
  })

  it('leaves no inline display toggles in the group-chat tool row', () => {
    // Both live in 设置 → 显示 (DisplaySettings) — same key, same composable —
    // which is the call ChatInput already made.
    expect(GROUP_INPUT).not.toContain('auto-play-speech-switch')
    expect(GROUP_INPUT).not.toContain('tool-trace-toggle')
    expect(GROUP_INPUT).not.toContain('NSwitch')
  })

  it('grows the group-chat wrapper by the field inset like the main composer', () => {
    // Without this the configured height (设置 → 显示) lands on the wrapper and
    // the visible textarea comes out 40px shorter.
    expect(GROUP_INPUT).toContain('const FIELD_INSET = 40')
    expect(GROUP_INPUT).toMatch(/Number\.parseInt\(style\.height, 10\) \+ FIELD_INSET/)
    expect(GROUP_INPUT).toMatch(/inputWrapperRef\.value\.clientHeight - FIELD_INSET/)
  })
})
