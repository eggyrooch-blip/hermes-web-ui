// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  CHAT_INPUT_HEIGHT_DEFAULT,
  CHAT_INPUT_HEIGHT_MAX,
  CHAT_INPUT_HEIGHT_MIN,
  clampChatInputHeight,
} from '@/utils/chat-input-height'

describe('chat input height', () => {
  it('clamps below the minimum', () => {
    expect(clampChatInputHeight(CHAT_INPUT_HEIGHT_MIN - 20)).toBe(CHAT_INPUT_HEIGHT_MIN)
  })

  it('clamps above the maximum', () => {
    expect(clampChatInputHeight(CHAT_INPUT_HEIGHT_MAX + 20)).toBe(CHAT_INPUT_HEIGHT_MAX)
  })

  it('accepts valid values', () => {
    expect(clampChatInputHeight(160)).toBe(160)
  })

  it('returns the default for null or invalid values', () => {
    expect(clampChatInputHeight(null)).toBe(CHAT_INPUT_HEIGHT_DEFAULT)
    expect(clampChatInputHeight(Number.NaN)).toBe(CHAT_INPUT_HEIGHT_DEFAULT)
  })
})
