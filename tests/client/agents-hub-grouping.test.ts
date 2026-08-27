import { describe, expect, it } from 'vitest'
import {
  agentDisplayName,
  agentGroupKey,
  agentKind,
  groupAgents,
  groupNameFromLabel,
  isUnnamedGroup,
} from '@/utils/hermes/agent-identity'

const OWNER = 'ou_7576020ac75436f4935892f6353567c7'

function profile(over: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'sunke',
    active: false,
    model: '-',
    alias: '',
    ...over,
  } as any
}

describe('agentKind', () => {
  it('uses the server kind when multitenancy metadata was merged', () => {
    expect(agentKind(profile({ name: 'sunke', kind: 'user' }))).toBe('user')
    expect(agentKind(profile({ name: 'feishu_group_abc_def', kind: 'group' }))).toBe('group')
    expect(agentKind(profile({ name: 'webui_x_coder_y', kind: 'agent' }))).toBe('agent')
  })

  // The token-login path (middleware/user-auth toAuthenticatedUser) carries no
  // openid, so the server cannot merge `kind`. Without this fallback every
  // profile would land in one section.
  it('falls back to the profile-name prefix when kind is missing', () => {
    expect(agentKind(profile({ name: 'feishu_group_8ec050fb3255_703fc51f7d272a1f' }))).toBe('group')
    expect(agentKind(profile({ name: 'webui_c84d5851f3c0_coder_c84a9e3ad1' }))).toBe('agent')
    expect(agentKind(profile({ name: 'sunke' }))).toBe('user')
  })

  // Prod shape (verified 2026-08-12 against both the prod and local
  // multitenancy DBs): group rows are kind='group'/provenance='group' and
  // webui agents are kind='agent'/provenance='webui-agent'. No row is ever
  // kind='agent' with a feishu_group_ name — but if one ever appears, the
  // reserved name must still win so a group cannot land under "mine" with an
  // openid-prefixed label showing.
  it('treats a feishu_group_ profile as a group even if kind says otherwise', () => {
    expect(agentKind(profile({ name: 'feishu_group_abc_def', kind: 'agent' }))).toBe('group')
    expect(agentKind(profile({ name: 'feishu_group_abc_def', kind: 'user' }))).toBe('group')
    const p = profile({ name: 'feishu_group_abc_def', kind: 'agent', displayLabel: `${OWNER}-群名` })
    expect(agentGroupKey(p)).toBe('group')
    expect(agentDisplayName(p)).toBe('群名')
    expect(agentDisplayName(p)).not.toContain(OWNER)
  })

  it('ignores blank and unknown kind values', () => {
    expect(agentKind(profile({ name: 'feishu_group_a_b', kind: '  ' }))).toBe('group')
    expect(agentKind(profile({ name: 'feishu_group_a_b', kind: 'wat' }))).toBe('group')
  })
})

describe('groupNameFromLabel', () => {
  it('strips the owner openid prefix the routing table stores', () => {
    expect(groupNameFromLabel(`${OWNER}-IT&SEC 安全共建群`)).toBe('IT&SEC 安全共建群')
  })

  it('keeps labels that carry no openid prefix', () => {
    expect(groupNameFromLabel('智能体先锋队')).toBe('智能体先锋队')
  })

  it('returns empty when the label is missing or fell back to the chat id', () => {
    expect(groupNameFromLabel(undefined)).toBe('')
    expect(groupNameFromLabel('   ')).toBe('')
    expect(groupNameFromLabel(`${OWNER}-oc_21034461c59426aaf0d10d55827ac0dc`)).toBe('')
    expect(groupNameFromLabel('oc_21034461c59426aaf0d10d55827ac0dc')).toBe('')
  })

  it('never leaks an identifier when the label carries no group name at all', () => {
    expect(groupNameFromLabel(OWNER)).toBe('')
    // Underscore-bearing ids must not defeat the prefix strip.
    expect(groupNameFromLabel('ou_user_a-oc_group_alpha')).toBe('')
    expect(groupNameFromLabel('ou_user_a-真群名')).toBe('真群名')
  })

  it('keeps a group genuinely named like a person or with a dash', () => {
    expect(groupNameFromLabel(`${OWNER}-孙可`)).toBe('孙可')
    expect(groupNameFromLabel(`${OWNER}-KippiesWork - 讨论`)).toBe('KippiesWork - 讨论')
  })
})

describe('agentDisplayName', () => {
  it('shows the group name for group agents', () => {
    const p = profile({ name: 'feishu_group_8ec050fb3255_x', kind: 'group', displayLabel: `${OWNER}-IT&SEC 安全共建群` })
    expect(agentDisplayName(p)).toBe('IT&SEC 安全共建群')
  })

  it('never leaks a raw profile name or chat id for an unsynced group', () => {
    const p = profile({ name: 'feishu_group_21034461c594_x', kind: 'group', displayLabel: `${OWNER}-oc_21034461c59426aaf0d10d55827ac0dc` })
    const shown = agentDisplayName(p)
    expect(shown).toBe('未命名群聊')
    expect(shown).not.toContain('oc_')
    expect(shown).not.toContain('feishu_group_')
    expect(isUnnamedGroup(p)).toBe(true)
  })

  it('prefers displayLabel then profile name for non-group agents', () => {
    expect(agentDisplayName(profile({ name: 'webui_x_coder_y', kind: 'agent', displayLabel: 'coder' }))).toBe('coder')
    expect(agentDisplayName(profile({ name: 'sunke', kind: 'user' }))).toBe('sunke')
  })

  it('does not mark named groups as unnamed', () => {
    expect(isUnnamedGroup(profile({ name: 'feishu_group_a_b', kind: 'group', displayLabel: `${OWNER}-test` }))).toBe(false)
    expect(isUnnamedGroup(profile({ name: 'sunke', kind: 'user' }))).toBe(false)
  })
})

describe('agentGroupKey / groupAgents', () => {
  it('routes an active share to the shared section even for a group agent', () => {
    expect(agentGroupKey(profile({ name: 'feishu_group_a_b', kind: 'group', shareRole: 'viewer' }))).toBe('shared')
    expect(agentGroupKey(profile({ name: 'webui_x_y_z', kind: 'agent', shareRole: 'manager' }))).toBe('shared')
  })

  it('puts user and self-built agents under mine, groups under group', () => {
    expect(agentGroupKey(profile({ name: 'sunke', kind: 'user' }))).toBe('mine')
    expect(agentGroupKey(profile({ name: 'webui_x_y_z', kind: 'agent' }))).toBe('mine')
    expect(agentGroupKey(profile({ name: 'feishu_group_a_b', kind: 'group' }))).toBe('group')
  })

  // Done line: card count must equal the number of profiles the API returned.
  it('places every profile in exactly one section, preserving order', () => {
    const profiles = [
      profile({ name: 'sunke', kind: 'user' }),
      profile({ name: 'webui_x_coder_y', kind: 'agent', displayLabel: 'coder' }),
      profile({ name: 'feishu_group_a_b', kind: 'group', displayLabel: `${OWNER}-群一` }),
      profile({ name: 'webui_x_coder1_y', kind: 'agent', displayLabel: 'coder1' }),
      profile({ name: 'feishu_group_c_d', kind: 'group', displayLabel: `${OWNER}-群二` }),
      profile({ name: 'shared_one', kind: 'agent', shareRole: 'viewer' }),
    ]
    const sections = groupAgents(profiles)
    const total = sections.reduce((sum, section) => sum + section.items.length, 0)
    expect(total).toBe(profiles.length)

    const seen = sections.flatMap(section => section.items.map(item => item.name))
    expect(new Set(seen).size).toBe(profiles.length)

    expect(sections.map(s => s.key)).toEqual(['mine', 'group', 'shared'])
    expect(sections[0].items.map(i => i.name)).toEqual(['sunke', 'webui_x_coder_y', 'webui_x_coder1_y'])
    expect(sections[1].items.map(i => i.name)).toEqual(['feishu_group_a_b', 'feishu_group_c_d'])
    expect(sections[2].items.map(i => i.name)).toEqual(['shared_one'])
  })

  it('returns all three sections even when empty (shared is an empty state, not an error)', () => {
    const sections = groupAgents([profile({ name: 'sunke', kind: 'user' })])
    expect(sections).toHaveLength(3)
    expect(sections[2].items).toEqual([])
  })

  it('still groups correctly when the server merged no metadata at all', () => {
    const sections = groupAgents([
      profile({ name: 'sunke' }),
      profile({ name: 'feishu_group_8ec050fb3255_703fc51f7d272a1f' }),
      profile({ name: 'webui_c84d5851f3c0_coder_c84a9e3ad1' }),
    ])
    expect(sections[0].items.map(i => i.name)).toEqual(['sunke', 'webui_c84d5851f3c0_coder_c84a9e3ad1'])
    expect(sections[1].items.map(i => i.name)).toEqual(['feishu_group_8ec050fb3255_703fc51f7d272a1f'])
  })
})
