export const CHAT_INPUT_HEIGHT_MIN = 48
export const CHAT_INPUT_HEIGHT_MAX = 400
export const CHAT_INPUT_HEIGHT_DEFAULT = 100
export const CHAT_INPUT_HEIGHT_MOBILE_QUERY = '(max-width: 768px)'

export function clampChatInputHeight(value: unknown): number {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN
  if (!Number.isFinite(numeric)) return CHAT_INPUT_HEIGHT_DEFAULT
  return Math.min(CHAT_INPUT_HEIGHT_MAX, Math.max(CHAT_INPUT_HEIGHT_MIN, Math.round(numeric)))
}

export function chatInputHeightStyle(
  configuredHeight: unknown,
  temporaryHeight: number | null,
  isMobile: boolean,
): Record<string, string> {
  if (isMobile) return {}
  return { height: `${temporaryHeight ?? clampChatInputHeight(configuredHeight)}px` }
}
