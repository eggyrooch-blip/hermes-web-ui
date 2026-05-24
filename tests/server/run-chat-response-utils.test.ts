import { describe, expect, it } from 'vitest'
import {
  extractResponseText,
  responseFunctionCallToToolCall,
  summarizeToolArguments,
} from '../../packages/server/src/services/hermes/run-chat/response-utils'

describe('run-chat response utils', () => {
  it('normalizes response function calls into OpenAI-style tool calls', () => {
    expect(responseFunctionCallToToolCall({
      call_id: 'call-1',
      name: 'terminal',
      arguments: { cmd: "printf 'ok'" },
    })).toEqual({
      id: 'call-1',
      type: 'function',
      function: {
        name: 'terminal',
        arguments: JSON.stringify({ cmd: "printf 'ok'" }),
      },
    })
  })

  it('summarizes preferred argument fields for tool previews', () => {
    expect(summarizeToolArguments(JSON.stringify({
      cmd: "python - <<'PY'\nprint('hello')\nPY",
      ignored: 'value',
    }))).toBe("python - <<'PY' print('hello') PY")
  })

  it('extracts text from response output message parts with output_text fallback', () => {
    expect(extractResponseText({
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'hello ' }] },
        { type: 'message', content: [{ type: 'text', text: 'world' }] },
      ],
    })).toBe('hello world')

    expect(extractResponseText({ output_text: 'fallback' })).toBe('fallback')
  })
})
