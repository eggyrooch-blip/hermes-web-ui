// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mapHermesMessages } from '../../packages/client/src/stores/hermes/chat'

describe('message source refs mapping', () => {
  it('maps source refs only when present and keeps old messages clean', () => {
    const messages = mapHermesMessages([
      { id: 1, session_id: 's', role: 'assistant', content: 'old', timestamp: 1, tool_call_id: null, tool_calls: null, tool_name: null, token_count: null, finish_reason: null, reasoning: null },
      { id: 2, session_id: 's', role: 'assistant', content: 'new', timestamp: 2, tool_call_id: null, tool_calls: null, tool_name: null, token_count: null, finish_reason: null, reasoning: null, run_id: 'r', source_refs: [{ id: 'web', type: 'web', label: 'Guide', uri: 'https://example.com/' }] },
    ])
    expect(messages[0].sourceRefs).toBeUndefined()
    expect(messages[1].sourceRefs).toEqual([{ id: 'web', type: 'web', label: 'Guide', uri: 'https://example.com/' }])
  })
})
