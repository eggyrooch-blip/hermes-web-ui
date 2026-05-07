// Provider logo helper — maps provider keys to a brand-colored badge.
// Used by ModelSelector to give the chat-input model picker a visual cue.

export interface ProviderLogo {
  bg: string
  fg: string
  label: string
}

const FALLBACK: ProviderLogo = { bg: '#6b7280', fg: '#fff', label: '?' }

const MAP: Record<string, ProviderLogo> = {
  anthropic: { bg: '#d97706', fg: '#fff', label: 'A' },
  gemini: { bg: '#4285f4', fg: '#fff', label: 'G' },
  deepseek: { bg: '#4d6bfe', fg: '#fff', label: 'D' },
  zai: { bg: '#06b6d4', fg: '#fff', label: 'Z' },
  'kimi-coding': { bg: '#1e1e1e', fg: '#fff', label: 'K' },
  'kimi-coding-cn': { bg: '#1e1e1e', fg: '#fff', label: 'K' },
  moonshot: { bg: '#1e1e1e', fg: '#fff', label: 'M' },
  xai: { bg: '#111111', fg: '#fff', label: 'X' },
  minimax: { bg: '#ef4444', fg: '#fff', label: 'Mx' },
  'minimax-cn': { bg: '#ef4444', fg: '#fff', label: 'Mx' },
  alibaba: { bg: '#ff7d00', fg: '#fff', label: 'Q' },
  'alibaba-coding-plan': { bg: '#ff7d00', fg: '#fff', label: 'Q' },
  huggingface: { bg: '#ffd21e', fg: '#000', label: 'HF' },
  xiaomi: { bg: '#ff6700', fg: '#fff', label: 'Mi' },
  kilocode: { bg: '#8b5cf6', fg: '#fff', label: 'Ki' },
  'ai-gateway': { bg: '#000000', fg: '#fff', label: 'V' },
  cliproxyapi: { bg: '#6b7280', fg: '#fff', label: 'CP' },
  'opencode-zen': { bg: '#0ea5e9', fg: '#fff', label: 'OZ' },
  'opencode-go': { bg: '#0ea5e9', fg: '#fff', label: 'OG' },
  'openai-codex': { bg: '#10a37f', fg: '#fff', label: 'O' },
  arcee: { bg: '#7c3aed', fg: '#fff', label: 'Ar' },
  openrouter: { bg: '#1e293b', fg: '#fff', label: 'OR' },
  copilot: { bg: '#24292e', fg: '#fff', label: 'GH' },
}

export function getProviderLogo(provider: string | undefined | null): ProviderLogo {
  if (!provider) return FALLBACK
  if (MAP[provider]) return MAP[provider]
  // Fuzzy fallbacks for unknown variants
  for (const key of Object.keys(MAP)) {
    if (provider.startsWith(key) || provider.includes(key)) return MAP[key]
  }
  return { ...FALLBACK, label: provider.slice(0, 2).toUpperCase() }
}
