// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const preview = vi.fn()
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/stores/hermes/files', () => ({ useFilesStore: () => ({ previewByDisplayPath: preview }) }))
import SourceRefs from '@/components/hermes/chat/SourceRefs.vue'

describe('SourceRefs', () => {
  beforeEach(() => { setActivePinia(createPinia()); preview.mockReset() })

  it('renders compact typed cards and opens workspace through the existing preview boundary', async () => {
    const wrapper = mount(SourceRefs, { props: { sessionId: 's1', refs: [
      { id: 'web', type: 'web', label: 'Guide', uri: 'https://example.com/' },
      { id: 'work', type: 'workspace', label: 'Report', open_path: '/workspace/reports/source.txt' },
    ] } })
    expect(wrapper.text()).toContain('chat.sources.title')
    expect(wrapper.findAll('button')).toHaveLength(2)
    await wrapper.findAll('button')[1].trigger('click')
    expect(preview).toHaveBeenCalledWith('/workspace/reports/source.txt', 'source.txt')
  })

  it('renders nothing without authorized refs', () => {
    expect(mount(SourceRefs, { props: { sessionId: 's1', refs: [] } }).html()).toBe('<!--v-if-->')
  })
})
