import { describe, expect, it } from 'vitest'
import { parseSseFrame, readSseFrames } from '../../packages/server/src/services/hermes/run-chat/sse-utils'

describe('run-chat SSE utils', () => {
  it('parses named multi-line SSE frames and skips comments', () => {
    expect(parseSseFrame(': comment\nevent: chunk\ndata: {\"a\":1}\ndata: {\"b\":2}\n')).toEqual({
      event: 'chunk',
      data: '{"a":1}\n{"b":2}',
    })
  })

  it('reads trailing frames without a final blank line', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: first\n\n'))
        controller.enqueue(encoder.encode('data: second'))
        controller.close()
      },
    })
    const frames = []
    for await (const frame of readSseFrames(stream)) frames.push(frame)

    expect(frames).toEqual([
      { data: 'first' },
      { data: 'second' },
    ])
  })
})
