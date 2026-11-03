// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const socketMock = vi.hoisted(() => ({
  connected: false,
  on: vi.fn(),
  removeAllListeners: vi.fn(),
  disconnect: vi.fn(),
}))

const ioMock = vi.hoisted(() => vi.fn(() => socketMock))

vi.mock('socket.io-client', () => ({
  io: ioMock,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({
    activeProfileName: 'owned_agent_profile',
  }),
}))

vi.mock('@/router', () => ({
  default: {
    currentRoute: { value: { name: 'hermes.chat' } },
    replace: vi.fn(),
  },
}))

describe('chat API shared-agent socket connection', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('passes the selected shared agent id in the chat-run socket query', async () => {
    localStorage.setItem('hermes_active_profile_name', 'owned_agent_profile')
    localStorage.setItem('hermes_active_agent_id', 'agent-shared')
    const { connectChatRun } = await import('../../packages/client/src/api/hermes/chat')

    connectChatRun()

    expect(ioMock).toHaveBeenCalledWith('/chat-run', expect.objectContaining({
      query: {
        profile: 'owned_agent_profile',
        agent_id: 'agent-shared',
      },
    }))
  })
})
