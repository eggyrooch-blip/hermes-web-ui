// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.hoisted(() => vi.fn())
const getWebPlaneMock = vi.hoisted(() => vi.fn(() => 'chat'))

vi.mock('@/api/client', () => ({
  request: requestMock,
  getWebPlane: getWebPlaneMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'chat.workspacePlaceholder': 'Enter project path, e.g. /home/user/project',
      'chat.workspaceCloudPlaceholder': 'Leave blank for the default workspace, or select a cloud folder',
      'chat.folderPickerDefault': 'Default workspace',
      'chat.folderPickerNoFolders': 'No workspace folders',
    }[key] || key),
  }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button"><slot /></button>' },
  NDropdown: { template: '<div><slot /></div>' },
  NInput: {
    inheritAttrs: false,
    props: ['value', 'placeholder', 'size', 'clearable'],
    emits: ['update:value'],
    template: '<input class="folder-path-input" :value="value" :placeholder="placeholder" />',
  },
  NModal: { template: '<div><slot /></div>' },
  NSpace: { template: '<div><slot /></div>' },
  NSpin: { template: '<span />' },
  useDialog: () => ({ warning: vi.fn() }),
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
}))

import FolderPicker from '@/components/hermes/chat/FolderPicker.vue'

describe('FolderPicker workspace semantics', () => {
  beforeEach(() => {
    requestMock.mockReset()
    requestMock.mockResolvedValue({ entries: [{ name: 'Downloads', isDir: true }] })
    getWebPlaneMock.mockReturnValue('chat')
  })

  it('presents a blank chat-plane selection as the default cloud workspace', async () => {
    const wrapper = mount(FolderPicker, { props: { modelValue: null } })
    await flushPromises()

    expect(wrapper.get('input').attributes('placeholder')).toBe(
      'Leave blank for the default workspace, or select a cloud folder',
    )
    expect(wrapper.text()).toContain('Default workspace')
    expect(wrapper.text()).toContain('Downloads')
  })

  it('preserves the host-path picker for the admin plane', async () => {
    getWebPlaneMock.mockReturnValue('both')
    requestMock.mockResolvedValue({ base: '/home/user', current: '', folders: [] })

    const wrapper = mount(FolderPicker, { props: { modelValue: null } })
    await flushPromises()

    expect(wrapper.get('input').attributes('placeholder')).toBe('Enter project path, e.g. /home/user/project')
    expect(wrapper.text()).not.toContain('Default workspace')
  })
})
