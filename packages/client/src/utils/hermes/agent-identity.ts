import type { HermesProfile } from '@/api/hermes/profiles'

/**
 * Agent identity/grouping for the agents hub.
 *
 * Everything here is derived from what `/api/hermes/profiles` already returns —
 * no new endpoint, no direct DB read. The server merges `kind`/`displayLabel`/
 * `agentId` from multitenancy_routing, but ONLY when the request carries a Feishu
 * openid (chat plane). On the token-login path those fields are absent, so every
 * reader below degrades to the profile-name prefix instead of mis-grouping.
 */

export type AgentKind = 'user' | 'agent' | 'group'
export type AgentGroupKey = 'mine' | 'group' | 'shared'

const GROUP_PROFILE_PREFIX = 'feishu_group_'
const WEBUI_AGENT_PROFILE_PREFIX = 'webui_'
/** display_label for group rows is stored as `<owner_open_id>-<群名>`. */
const OPEN_ID_PREFIX_RE = /^(ou_[0-9a-zA-Z_]+?)-/
/** A label that is really just the chat id carries no human-readable group name. */
const CHAT_ID_ONLY_RE = /^oc_[0-9a-zA-Z_]+$/
/** A label that is nothing but an openid carries no group name either. */
const OPEN_ID_ONLY_RE = /^ou_[0-9a-zA-Z_]+$/

/**
 * `kind` from the server when present; otherwise inferred from the profile name.
 * The fallback matters: the token-login path never merges multitenancy metadata,
 * and without it every profile would collapse into one group.
 */
export function agentKind(profile: Pick<HermesProfile, 'name' | 'kind'>): AgentKind {
  // The reserved group-profile name wins over `kind`. Prod only ever emits
  // kind='group' for these, but a mislabelled row must not put a group under
  // "mine" — that would also surface its raw `<owner_open_id>-` label.
  if (profile.name.startsWith(GROUP_PROFILE_PREFIX)) return 'group'
  const kind = profile.kind?.trim()
  if (kind === 'user' || kind === 'agent' || kind === 'group') return kind
  if (profile.name.startsWith(WEBUI_AGENT_PROFILE_PREFIX)) return 'agent'
  return 'user'
}

/**
 * Strip the `<owner_open_id>-` prefix the routing table stores in front of group
 * names. Returns '' when nothing human-readable survives (label missing, or it
 * fell back to the bare chat id) so callers can show a placeholder instead of
 * leaking an `oc_...` string at the user.
 */
export function groupNameFromLabel(displayLabel?: string): string {
  const label = displayLabel?.trim()
  if (!label) return ''
  const name = label.replace(OPEN_ID_PREFIX_RE, '').trim()
  if (!name || CHAT_ID_ONLY_RE.test(name) || OPEN_ID_ONLY_RE.test(name)) return ''
  return name
}

/** True when a group agent has no synced group name — render the placeholder. */
export function isUnnamedGroup(profile: Pick<HermesProfile, 'name' | 'kind' | 'displayLabel'>): boolean {
  return agentKind(profile) === 'group' && !groupNameFromLabel(profile.displayLabel)
}

/**
 * What to call this agent in the UI. Group agents show the Feishu group name;
 * everything else prefers displayLabel and falls back to the profile name, which
 * always exists.
 */
export function agentDisplayName(
  profile: Pick<HermesProfile, 'name' | 'kind' | 'displayLabel'>,
  unnamedGroupLabel = '未命名群聊',
): string {
  if (agentKind(profile) === 'group') {
    return groupNameFromLabel(profile.displayLabel) || unnamedGroupLabel
  }
  return profile.displayLabel?.trim() || profile.name
}

/**
 * Which section a profile belongs to. An active share wins over `kind`: an agent
 * someone granted to me belongs under 「共享给我的」 even though it is a group or
 * webui agent on the owner's side.
 */
export function agentGroupKey(profile: Pick<HermesProfile, 'name' | 'kind' | 'shareRole'>): AgentGroupKey {
  if (profile.shareRole?.trim()) return 'shared'
  return agentKind(profile) === 'group' ? 'group' : 'mine'
}

export interface AgentSection<T> {
  key: AgentGroupKey
  items: T[]
}

/**
 * Partition into mine / group / shared, preserving server order within each
 * section. Every input lands in exactly one section — the hub's card count must
 * equal the number of profiles the API returned.
 */
export function groupAgents<T extends Pick<HermesProfile, 'name' | 'kind' | 'shareRole'>>(
  profiles: T[],
): AgentSection<T>[] {
  const sections: Record<AgentGroupKey, T[]> = { mine: [], group: [], shared: [] }
  for (const profile of profiles) {
    sections[agentGroupKey(profile)].push(profile)
  }
  return [
    { key: 'mine', items: sections.mine },
    { key: 'group', items: sections.group },
    { key: 'shared', items: sections.shared },
  ]
}
