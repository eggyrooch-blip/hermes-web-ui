import { describe, expect, it } from 'vitest'
import {
  buildRunBrokerRequest,
  buildRunBrokerHeaders,
  mapRunBrokerFrameForChat,
  readSseFrames,
} from '../../packages/server/src/services/hermes/run-chat/handle-broker-run'

describe('run-chat broker compatibility module', () => {
  it('builds broker requests with owner identity, channel, session history and metadata', async () => {
    const request = await buildRunBrokerRequest({
      input: 'hello broker',
      profile: 'sunke',
      ownerOpenId: 'ou_owner',
      sessionId: 'session-broker',
      model: 'gpt-5.4',
      provider: 'openai',
      instructions: 'answer briefly',
      workspace: '/workspace/project',
      messages: [
        { id: 1, session_id: 'session-broker', role: 'user', content: 'old question', timestamp: 1 },
        { id: 2, session_id: 'session-broker', role: 'assistant', content: 'old answer', timestamp: 2 },
      ],
    })

    expect(request).toEqual(expect.objectContaining({
      channel: 'webui',
      profile_name: 'sunke',
      user_key: 'ou_owner',
      content: 'hello broker',
      session_id: 'session-broker',
      delivery_mode: 'socket',
      credential_subject: 'ou_owner',
      requires_host_tools: true,
    }))
    expect(request.messages).toEqual([
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'hello broker' },
    ])
    expect(request.metadata).toEqual(expect.objectContaining({
      source: 'hermes-web-ui',
      model: 'gpt-5.4',
      provider: 'openai',
      conversation: 'webui:session-broker',
    }))
    expect(request.metadata.instructions).toContain('[Current working directory: /workspace/project]')
    expect(request.metadata.instructions).toContain('answer briefly')
  })

  it('builds broker headers without leaking profile identity into owner identity', () => {
    expect(buildRunBrokerHeaders({
      runBrokerKey: 'secret',
      ownerOpenId: 'ou_owner',
    })).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret',
      'X-Hermes-Owner-Open-Id': 'ou_owner',
      'X-Hermes-Feishu-OpenId': 'ou_owner',
    })
  })

  it('maps broker tool frames and persists useful preview as arguments', () => {
    expect(mapRunBrokerFrameForChat({
      kind: 'tool_started',
      run_id: 'run-1',
      name: 'terminal',
      payload: { preview: "printf 'ok'" },
    })).toEqual(expect.objectContaining({
      type: 'emit',
      event: 'tool.started',
      payload: expect.objectContaining({
        tool_call_id: 'broker_tool_run-1_terminal',
        arguments: JSON.stringify({ cmd: "printf 'ok'" }),
      }),
    }))
  })

  it('parses multi-line SSE data frames', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: chunk\ndata: {"a":1}\ndata: {"b":2}\n\n'))
        controller.close()
      },
    })

    const frames = []
    for await (const frame of readSseFrames(stream)) frames.push(frame)

    expect(frames).toEqual([{ event: 'chunk', data: '{"a":1}\n{"b":2}' }])
  })
})
