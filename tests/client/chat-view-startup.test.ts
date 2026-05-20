// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

const loadModelsMock = vi.hoisted(() => vi.fn())
const loadSessionsMock = vi.hoisted(() => vi.fn())
const fetchProfilesMock = vi.hoisted(() => vi.fn())
const fetchSettingsMock = vi.hoisted(() => vi.fn())

vi.mock('@/components/hermes/chat/ChatPanel.vue', () => ({
  default: { template: '<div data-test="chat-panel" />' },
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({
    loadModels: loadModelsMock,
  }),
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => ({
    loadSessions: loadSessionsMock,
  }),
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({
    fetchProfiles: fetchProfilesMock,
  }),
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => ({
    fetchSettings: fetchSettingsMock,
  }),
}))

import ChatView from '@/views/hermes/ChatView.vue'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(res => { resolve = res })
  return { promise, resolve }
}

describe('ChatView startup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadModelsMock.mockResolvedValue(undefined)
    loadSessionsMock.mockResolvedValue(undefined)
    fetchProfilesMock.mockResolvedValue(undefined)
    fetchSettingsMock.mockResolvedValue(undefined)
  })

  it('starts loading sessions without waiting for the slower profile list', async () => {
    const profiles = deferred()
    fetchProfilesMock.mockReturnValue(profiles.promise)
    fetchSettingsMock.mockResolvedValue(undefined)

    mount(ChatView)
    await nextTick()
    await Promise.resolve()

    expect(fetchProfilesMock).toHaveBeenCalled()
    expect(loadSessionsMock).toHaveBeenCalled()
  })
})
