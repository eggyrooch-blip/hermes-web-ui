import { describe, expect, it } from 'vitest'
import { countTokens } from '../../packages/server/src/lib/context-compressor'
import { estimateUsageTokensFromMessages } from '../../packages/server/src/services/hermes/run-chat/usage'

/**
 * reasoning_content (DeepSeek/Kimi thinking mode) is echoed back to the provider
 * on later turns, so it must be counted toward context usage. Omitting it
 * undercounts full context and skips compression until the provider 400s.
 */
describe('context usage counts reasoning payloads', () => {
  it('counts assistant reasoning_content toward output tokens', () => {
    const reasoning = 'long thinking payload that providers echo back'
    const messages = [
      {
        role: 'assistant',
        content: 'final answer',
        reasoning_content: reasoning,
      },
    ]

    const usage = estimateUsageTokensFromMessages(messages)

    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(
      countTokens('final answer') + countTokens(reasoning),
    )
  })

  it('falls back to the `reasoning` alias when reasoning_content is absent', () => {
    const reasoning = 'alias thinking payload'
    const messages = [
      { role: 'assistant', content: 'answer', reasoning },
    ]

    const usage = estimateUsageTokensFromMessages(messages)

    expect(usage.outputTokens).toBe(countTokens('answer') + countTokens(reasoning))
  })

  it('prefers reasoning_content over the alias when both are present', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'answer',
        reasoning_content: 'canonical payload',
        reasoning: 'alias payload that must be ignored',
      },
    ]

    const usage = estimateUsageTokensFromMessages(messages)

    expect(usage.outputTokens).toBe(countTokens('answer') + countTokens('canonical payload'))
  })

  it('counts reasoning on tool messages too', () => {
    const messages = [
      { role: 'tool', content: 'tool result', reasoning_content: 'tool thinking' },
    ]

    const usage = estimateUsageTokensFromMessages(messages)

    expect(usage.outputTokens).toBe(countTokens('tool result') + countTokens('tool thinking'))
  })

  it('ignores reasoning on user messages (input side is unchanged)', () => {
    const messages = [
      { role: 'user', content: 'question', reasoning_content: 'should not count' },
    ]

    const usage = estimateUsageTokensFromMessages(messages)

    expect(usage.inputTokens).toBe(countTokens('question'))
    expect(usage.outputTokens).toBe(0)
  })

  it('leaves estimates unchanged when no reasoning payload is present', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]

    const usage = estimateUsageTokensFromMessages(messages)

    expect(usage.inputTokens).toBe(countTokens('hello'))
    expect(usage.outputTokens).toBe(countTokens('hi'))
  })
})

describe('group-chat room usage counts reasoning payloads', () => {
  /**
   * ChatStorage#estimateUsageTokensFromMessages is a private method; it only
   * touches `this.contentToUsageText`, so it can be invoked off the prototype
   * without constructing a storage instance (which would open the room DB).
   */
  async function roomEstimate(messages: unknown[]) {
    const { ChatStorage } = await import('../../packages/server/src/services/hermes/group-chat/index')
    const proto = ChatStorage.prototype as any
    const self = { contentToUsageText: proto.contentToUsageText }
    return proto.estimateUsageTokensFromMessages.call(self, messages) as {
      inputTokens: number
      outputTokens: number
    }
  }

  it('adds reasoning_content to the room output-token estimate', async () => {
    const usage = await roomEstimate([
      { role: 'assistant', content: 'answer', reasoning_content: 'room thinking' },
    ])

    expect(usage.outputTokens).toBe(countTokens('answer') + countTokens('room thinking'))
  })

  it('falls back to the `reasoning` alias in rooms too', async () => {
    const usage = await roomEstimate([
      { role: 'assistant', content: 'answer', reasoning: 'room alias thinking' },
    ])

    expect(usage.outputTokens).toBe(countTokens('answer') + countTokens('room alias thinking'))
  })

  it('leaves room estimates unchanged without a reasoning payload', async () => {
    const usage = await roomEstimate([
      { role: 'user', content: 'ask' },
      { role: 'assistant', content: 'reply' },
    ])

    expect(usage.inputTokens).toBe(countTokens('ask'))
    expect(usage.outputTokens).toBe(countTokens('reply'))
  })
})
