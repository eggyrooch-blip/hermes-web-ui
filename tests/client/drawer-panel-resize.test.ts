import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

describe('ChatPanel tool drawer resizing support', () => {
  it('persists and clamps the live chat tool panel width while keeping mobile full width', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('class="chat-tool-panel"')
    expect(source).toContain('const TOOL_PANEL_STORAGE_KEY = "hermes.chat.toolPanelWidth"')
    expect(source).toContain('function clampToolPanelWidth')
    expect(source).toContain('Math.floor(available * 0.88)')
    expect(source).toContain('window.localStorage.setItem(TOOL_PANEL_STORAGE_KEY')
    expect(source).toContain('window.addEventListener("resize", handleToolPanelViewportResize)')
    expect(source).toContain('watch(showToolPanel')
    expect(source).toContain('width: 100% !important;')
  })

  it('lazy-mounts the tool panel once and only hides it after collapse', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('const toolPanelMounted = ref(false)')
    expect(source).toContain('if (visible) toolPanelMounted.value = true')
    expect(source).toContain('v-if="toolPanelMounted && !chatSidebarSurface"')
    expect(source).toContain('v-show="showToolPanel"')
    expect(source).not.toContain('v-if="showToolPanel && !chatSidebarSurface"')
  })
})
