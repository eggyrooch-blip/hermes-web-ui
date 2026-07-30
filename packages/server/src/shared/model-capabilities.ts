/**
 * Static model capability / model family table.
 *
 * This is the ONE place capabilities and families are defined. The BFF
 * annotates `model_meta[model].capabilities` on /api/hermes/available-models
 * responses from it, and the client imports `familyOf` /
 * `shouldNoticeFamilySwitch` from the same file so the two tiers can never
 * drift apart.
 *
 * ponytail: a static name-pattern table on purpose — matching model IDs is a
 * few lines and needs no network. Upgrade path: replace MODEL_CAPABILITY_RULES
 * with a lookup against litellm's `/model/info` once the gateway exposes
 * per-model capability flags; `modelCapabilities()` keeps its signature and
 * nothing downstream changes.
 */

export type ModelCapability = 'vision' | 'reasoning'

/**
 * Model IDs reach us prefixed in several shapes:
 *   custom:litellm-sre/tencent-sonnet-4-6, anthropic/claude-sonnet-5, glm-5v-turbo
 * Only the trailing segment names the model.
 */
function bareModelName(model: string): string {
  const id = String(model || '').trim().toLowerCase()
  const slash = id.lastIndexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}

/** First match wins. */
export const MODEL_CAPABILITY_RULES: ReadonlyArray<{
  pattern: RegExp
  capabilities: readonly ModelCapability[]
}> = [
  { pattern: /^claude/, capabilities: ['vision', 'reasoning'] },
  { pattern: /^gpt/, capabilities: ['reasoning'] },
  // glm-5v-turbo / glm-4v — the vision marker rides the version token, so only
  // that token is inspected. A looser /^glm-.*v/ would read `glm-4.6-preview`
  // as a vision model.
  { pattern: /^glm-[^-]*v/, capabilities: ['vision'] },
  { pattern: /^glm/, capabilities: ['reasoning'] },
]

/** Capabilities for a model ID. Unknown models get [] (= no badges). */
export function modelCapabilities(model: string): ModelCapability[] {
  const name = bareModelName(model)
  if (!name) return []
  const rule = MODEL_CAPABILITY_RULES.find(candidate => candidate.pattern.test(name))
  return rule ? [...rule.capabilities] : []
}

/** Model family = leading segment of the bare model ID (claude / gpt / glm / …). */
export function familyOf(model: string): string {
  return bareModelName(model).split(/[-_.]/)[0] || ''
}

/**
 * Display-only annotation: writes capabilities into `model_meta` and touches
 * nothing else on the group (no model/provider/routing field is rewritten).
 * Models that match no rule get no `model_meta` entry, so the payload only
 * grows for models that actually render a badge.
 */
export function withModelCapabilities<
  M extends { capabilities?: ModelCapability[] },
  G extends { models: string[]; model_meta?: Record<string, M> },
>(groups: G[]): G[] {
  return groups.map(group => {
    let meta: Record<string, M> | undefined
    for (const model of group.models) {
      const capabilities = modelCapabilities(model)
      if (capabilities.length === 0) continue
      if (!meta) meta = { ...(group.model_meta || {}) }
      meta[model] = { ...(meta[model] ?? ({} as M)), capabilities }
    }
    return meta ? { ...group, model_meta: meta } : group
  })
}

/** True when switching between two different model families. */
export function isCrossFamilySwitch(previousModel: string, nextModel: string): boolean {
  const previous = familyOf(previousModel)
  const next = familyOf(nextModel)
  return !!previous && !!next && previous !== next
}

/**
 * One-shot, non-blocking mid-conversation warning: only when the session
 * already has history, the family actually changed, and we have not warned
 * for this session yet.
 */
export function shouldNoticeFamilySwitch(input: {
  previousModel: string
  nextModel: string
  messageCount: number
  alreadyNoticed: boolean
}): boolean {
  if (input.alreadyNoticed) return false
  if (!(input.messageCount > 0)) return false
  return isCrossFamilySwitch(input.previousModel, input.nextModel)
}
