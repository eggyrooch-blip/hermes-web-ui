const TRUSTED_AVATAR_HOST_SUFFIXES = [
  'feishucdn.com',
  'feishu.cn',
  'larksuitecdn.com',
  'larksuite.com',
]

export function safeShareAvatarUrl(value?: string): string {
  const raw = value?.trim()
  if (!raw) return ''
  const sameOrigin = typeof window === 'undefined' ? '' : window.location.origin

  try {
    const url = new URL(raw, sameOrigin || undefined)
    if (sameOrigin && url.origin === sameOrigin) return url.href
    if (url.protocol !== 'https:') return ''
    const host = url.hostname.toLowerCase()
    if (TRUSTED_AVATAR_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) {
      return url.href
    }
  } catch {
    return ''
  }
  return ''
}
