// @vitest-environment jsdom
import { shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/hermes/files/FileEditor.vue', () => ({
  default: { name: 'FileEditor', template: '<div data-testid="file-editor" />' },
}))

import FilesView from '@/views/hermes/FilesView.vue'
import FileEditor from '@/components/hermes/files/FileEditor.vue'
import { useFilesStore } from '@/stores/hermes/files'
import { useProfilesStore } from '@/stores/hermes/profiles'

describe('FilesView editor scope', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('does not render a chat session editor in a different profile files view', () => {
    const profilesStore = useProfilesStore()
    profilesStore.activeProfileName = 'profile-b'
    profilesStore.profiles = [{ name: 'profile-b' }] as any
    const filesStore = useFilesStore()
    vi.spyOn(filesStore, 'fetchEntries').mockResolvedValue(undefined)
    filesStore.editingFile = {
      path: 'a-secret.txt',
      content: 'dirty A',
      originalContent: 'clean A',
      language: 'plaintext',
      ownerScope: 'default:profile-a:session-a',
    }

    const wrapper = shallowMount(FilesView)

    expect(wrapper.findComponent(FileEditor).exists()).toBe(false)
    expect(wrapper.text()).not.toContain('dirty A')
  })
})
