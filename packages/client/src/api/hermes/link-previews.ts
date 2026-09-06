import { request } from '../client'

export interface FeishuLinkPreview {
  kind: string
  title: string
  type_label: string
  url: string
  status: 'resolved' | 'forbidden' | 'generic'
}

export const LINK_PREVIEW_SLOT = '\u2063'
const NEW_LINK_PREVIEW_SLOT = '\u2064'
const FEISHU_URL_PATTERN = /https:\/\/[^\s<>"'，。；！？、）】}]+/gi

function normalizeFeishuUrl(raw: string): string | null {
  const url = raw.replace(/[),.;\]}]+$/, '')
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '')
    return ['feishu.cn', 'larksuite.com'].some(root => host === root || host.endsWith(`.${root}`)) ? url : null
  } catch {
    return null
  }
}

export function extractFeishuUrls(text: string): string[] {
  const urls = [...text.matchAll(FEISHU_URL_PATTERN)]
    .map(match => normalizeFeishuUrl(match[0]))
    .filter((url): url is string => Boolean(url))
  return [...new Set(urls)].slice(0, 10)
}

export function cardifyFeishuUrls(text: string, urls: string[], existingSlots: string[] = []): { text: string; slots: string[] } {
  const allowed = new Set(urls)
  const addedSlots: string[] = []
  const withAddedSlots = text.replace(FEISHU_URL_PATTERN, (raw) => {
    const url = normalizeFeishuUrl(raw)
    if (!url || !allowed.has(url)) return raw
    addedSlots.push(url)
    return `${NEW_LINK_PREVIEW_SLOT}${raw.slice(url.length)}`
  })
  let existingIndex = 0
  let addedIndex = 0
  const slots: string[] = []
  const normalizedText = withAddedSlots.replace(/[\u2063\u2064]/g, marker => {
    const url = marker === LINK_PREVIEW_SLOT ? existingSlots[existingIndex++] : addedSlots[addedIndex++]
    if (url) slots.push(url)
    return url ? LINK_PREVIEW_SLOT : ''
  })
  return { text: normalizedText, slots }
}

export function restoreFeishuUrlSlots(text: string, slots: string[]): string {
  let index = 0
  return text.replaceAll(LINK_PREVIEW_SLOT, () => slots[index++] || '')
}

export function revealCardifiedUrl(text: string, slots: string[], target: string): { text: string; slots: string[] } {
  let index = 0
  const remaining: string[] = []
  return {
    text: text.replaceAll(LINK_PREVIEW_SLOT, () => {
      const url = slots[index++] || ''
      if (url === target) return url
      if (url) remaining.push(url)
      return url ? LINK_PREVIEW_SLOT : ''
    }),
    slots: remaining,
  }
}

export function stripCardifiedFeishuUrls(text: string, urls: string[]): string {
  const allowed = new Set(urls)
  return text.replace(FEISHU_URL_PATTERN, (raw, offset: number) => {
    const url = normalizeFeishuUrl(raw)
    if (!url || !allowed.has(url) || text.slice(Math.max(0, offset - 2), offset) === '](') return raw
    return raw.slice(url.length)
  }).trim()
}

async function requestPreviews(urls: string[], profile?: string): Promise<{ previews: FeishuLinkPreview[] }> {
  return request('/api/hermes/link-previews', {
    method: 'POST',
    body: JSON.stringify({ urls, ...(profile ? { profile_name: profile } : {}) }),
  })
}

export async function fetchLinkPreviews(urls: string[], profile?: string): Promise<{ previews: FeishuLinkPreview[] }> {
  return requestPreviews(urls, profile)
}
