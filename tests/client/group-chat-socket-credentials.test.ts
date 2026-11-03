// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Client half of `groupchat-socket-feishu-auth`: the /group-chat socket must be
// opened with `withCredentials: true` so the httpOnly `hermes_feishu_session`
// cookie rides the same-origin WebSocket handshake. Without it, Feishu/
// server-session users (whose getApiKey() is '') sent an empty token and the
// server rejected the connection with `connect_error: Unauthorized`.

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(() => ({ connected: false, disconnect: vi.fn() })),
}))

vi.mock('socket.io-client', () => ({ io: mockIo }))

import { connectGroupChat, disconnectGroupChat } from '@/api/hermes/group-chat'

describe('connectGroupChat handshake', () => {
  beforeEach(() => {
    mockIo.mockClear()
    disconnectGroupChat()
    localStorage.clear()
  })

  it('opens the socket with withCredentials so the Feishu cookie is sent', () => {
    connectGroupChat({ userId: 'u1' })

    expect(mockIo).toHaveBeenCalledTimes(1)
    const [namespace, opts] = mockIo.mock.calls[0] as [string, Record<string, unknown>]
    expect(namespace).toBe('/group-chat')
    expect(opts).toMatchObject({ withCredentials: true })
  })

  it('still sends withCredentials in Feishu/server-session mode (no JS-readable JWT)', () => {
    // server-session mode → getApiKey() returns '' → token is undefined; the
    // cookie is the only credential, so withCredentials is what makes it work.
    localStorage.setItem('hermes_auth_mode', 'trusted-feishu')

    connectGroupChat({ userId: 'u2' })

    const [, opts] = mockIo.mock.calls[0] as [string, Record<string, unknown>]
    expect(opts).toMatchObject({ withCredentials: true })
    expect((opts.auth as { token?: unknown }).token).toBeUndefined()
  })
})
