import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock config so we control runBroker url/key without env wiring.
vi.mock('../../packages/server/src/config', () => ({
  config: { runBrokerUrl: 'http://broker.test', runBrokerKey: 'k-test' },
}))
// Mock logger to capture redacted shadow output.
const logWarn = vi.fn()
const logInfo = vi.fn()
vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { warn: logWarn, info: logInfo, debug: vi.fn(), error: vi.fn() },
}))

const MODULE = '../../packages/server/src/services/hermes/connector-registry-client'

function brokerConnector(over: Record<string, any> = {}) {
  return {
    id: 'keep-record',
    title: 'Keep-record',
    provider: 'keep',
    installed: true,
    status: 'authenticated',
    // additive control-plane fields that MUST be dropped by the mapping:
    profile: 'p1',
    scope: 'profile',
    acting_identity: 'user',
    credential_owner: 'p1',
    runtime_policy_owner: 'connector_driver',
    kind: 'internal',
    stale: false,
    expires_at: 123456789,
    account_hint: 'owner',
    detail: 'ok',
    required_by: ['skill-b', 'skill-a'],
    action: { kind: 'skill_flow', label: '扫码', command: '/keep-record auth' },
    ...over,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  logWarn.mockClear()
  logInfo.mockClear()
})

describe('mapConnectorToEntry', () => {
  it('keeps legacy SkillCredentialEntry fields and DROPS additive control-plane fields', async () => {
    const { mapConnectorToEntry } = await import(MODULE)
    const e = mapConnectorToEntry(brokerConnector())
    expect(e).toEqual({
      id: 'keep-record',
      title: 'Keep-record',
      provider: 'keep',
      installed: true,
      status: 'authenticated',
      account_hint: 'owner',
      detail: 'ok',
      required_by: ['skill-b', 'skill-a'],
      action: { kind: 'skill_flow', label: '扫码', command: '/keep-record auth' },
    })
    // additive fields must not leak through
    for (const k of ['scope', 'profile', 'acting_identity', 'credential_owner',
      'runtime_policy_owner', 'kind', 'stale', 'expires_at']) {
      expect(e).not.toHaveProperty(k)
    }
  })

  it('coerces an unknown status to unknown and unknown action kind to manual', async () => {
    const { mapConnectorToEntry } = await import(MODULE)
    const e = mapConnectorToEntry(brokerConnector({ status: 'bogus', action: { kind: 'weird', label: 'x' } }))
    expect(e.status).toBe('unknown')
    expect(e.action.kind).toBe('manual')
  })

  it('preserves connector action env so WebUI starts the intended kep-cli environment', async () => {
    const { mapConnectorToEntry } = await import(MODULE)
    const e = mapConnectorToEntry(brokerConnector({
      id: 'kep-cli-pre',
      action: { kind: 'oauth_url', label: '认证 pre', env: 'pre' },
    }))
    expect(e.action).toMatchObject({ kind: 'oauth_url', label: '认证 pre', env: 'pre' })
  })

  it('drops the action entirely when the broker says there is none', async () => {
    // broker 对「管理员运维、员工无可执行操作」的卡送 action: null（见 hermes-multitenancy
    // ConnectorStatus.to_dict）。以前这里会造一个 {kind:'manual', label:''}，把缺省抹成
    // "有操作但没标签"，逼客户端拿空 label 当哨兵 —— 该暗号 2026-08-04 咬过两次。
    const { mapConnectorToEntry } = await import(MODULE)
    for (const raw of [null, undefined, {}]) {
      const e = mapConnectorToEntry(brokerConnector({ action: raw }))
      expect(e.action, `action=${JSON.stringify(raw)} must map to absent`).toBeUndefined()
      expect('action' in e).toBe(false)
    }
  })

  it('keeps an action that has a kind but no label — that is a data bug, not "no action"', async () => {
    // 只有 label 空、kind 还在 → broker 确实想表达一个操作，只是标签丢了。静默吞成
    // "无操作" 会让那张卡永远点不动且无人察觉；保留下来，客户端会用兜底文案渲染。
    const { mapConnectorToEntry } = await import(MODULE)
    const e = mapConnectorToEntry(brokerConnector({ action: { kind: 'manual', label: '' } }))
    expect(e.action).toBeDefined()
    expect(e.action!.kind).toBe('manual')
  })
})

describe('failSafeResult', () => {
  let failSafeResultSync: (p: string) => any
  beforeAll(async () => { failSafeResultSync = (await import(MODULE)).failSafeResult })

  it('returns all canonical connectors as error — NEVER authenticated', async () => {
    const { failSafeResult } = await import(MODULE)
    const r = failSafeResult('p1')
    expect(r.profile_name).toBe('p1')
    expect(r.credentials.map((c: any) => c.id)).toEqual(
      ['lark-cli', 'feishu-project', 'keep-record', 'kep-cli-online', 'kep-cli-pre',
       'gitlab', 'gitlab-personal'])
    expect(r.credentials.every((c: any) => c.status === 'error')).toBe(true)
    expect(r.credentials.some((c: any) => c.status === 'authenticated')).toBe(false)
  })

  it('gives every fail-safe row a non-empty action label so the panel stays actionable', () => {
    // The client renders a card's button only when `action.label` is non-empty (an
    // empty label means "admin-operated, nothing the employee can do" — the
    // GitLab（全局）card). Leaving the fail-safe rows label-less would strip EVERY
    // button the moment the broker is down, so the user could not even retry.
    const r = failSafeResultSync('p1')
    for (const c of r.credentials as any[]) {
      expect(c.action?.label, `${c.id} must keep a usable label when the broker is down`)
        .toBeTruthy()
    }
  })
})

describe('fetchConnectorStatuses', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('maps a successful broker response to SkillCredentialEntry[]', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ profile_name: 'p1', subject_id: 'u1', connectors: [brokerConnector()] }),
    })
    const { fetchConnectorStatuses } = await import(MODULE)
    const r = await fetchConnectorStatuses({ profileName: 'p1', userKey: 'u1' })
    expect(r.profile_name).toBe('p1')
    expect(r.credentials[0].id).toBe('keep-record')
    expect(r.credentials[0]).not.toHaveProperty('scope')
    // sends profile_name + user_key + Bearer
    const url = (globalThis.fetch as any).mock.calls[0][0] as string
    expect(url).toContain('/api/run-broker/connectors')
    expect(url).toContain('profile_name=p1')
    expect(url).toContain('user_key=u1')
    const init = (globalThis.fetch as any).mock.calls[0][1]
    expect(init.headers.Authorization).toBe('Bearer k-test')
  })

  it('appends fresh=1 only when opts.fresh is set (cache-bypass for the post-auth poll)', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ profile_name: 'p1', connectors: [brokerConnector()] }),
    })
    const { fetchConnectorStatuses } = await import(MODULE)
    await fetchConnectorStatuses({ profileName: 'p1', userKey: 'u1' })
    expect((globalThis.fetch as any).mock.calls[0][0] as string).not.toContain('fresh=1')
    await fetchConnectorStatuses({ profileName: 'p1', userKey: 'u1', fresh: true })
    expect((globalThis.fetch as any).mock.calls[1][0] as string).toContain('fresh=1')
  })

  it('throws BrokerUnavailableError on 5xx (fail-safe trigger)', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })
    const { fetchConnectorStatuses, BrokerUnavailableError } = await import(MODULE)
    await expect(fetchConnectorStatuses({ profileName: 'p1' })).rejects.toBeInstanceOf(BrokerUnavailableError)
  })

  it('throws on network/timeout error', async () => {
    ;(globalThis.fetch as any).mockRejectedValue(new Error('AbortError'))
    const { fetchConnectorStatuses, BrokerUnavailableError } = await import(MODULE)
    await expect(fetchConnectorStatuses({ profileName: 'p1' })).rejects.toBeInstanceOf(BrokerUnavailableError)
  })

  it('throws when the body has no connectors array', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => ({ oops: 1 }) })
    const { fetchConnectorStatuses } = await import(MODULE)
    await expect(fetchConnectorStatuses({ profileName: 'p1' })).rejects.toThrow()
  })
})

describe('shadowDiff (redacted)', () => {
  it('reports status / required_by-count / account_hint-presence diffs WITHOUT leaking values', async () => {
    const { shadowDiff } = await import(MODULE)
    const local = {
      profile_name: 'p1',
      credentials: [
        { id: 'kep-cli-online', title: 'kep-cli online', provider: 'keep', installed: true, status: 'needs_auth',
          account_hint: 'alice@x', action: { kind: 'oauth_url', label: 'a' }, required_by: ['s1'] },
      ],
    }
    const broker = {
      profile_name: 'p1',
      credentials: [
        { id: 'kep-cli-online', title: 'kep-cli online', provider: 'keep', installed: true, status: 'authenticated',
          action: { kind: 'oauth_url', label: 'a' }, required_by: ['s1', 's2'] },
      ],
    }
    const diffs = shadowDiff(local as any, broker as any)
    const fields = diffs.map((d: any) => d.field).sort()
    expect(fields).toContain('status')
    expect(fields).toContain('required_by')
    expect(fields).toContain('account_hint_present')
    // redaction: serialized diff must not contain the actual account value
    expect(JSON.stringify(diffs)).not.toContain('alice@x')
    const statusDiff = diffs.find((d: any) => d.field === 'status')
    expect(statusDiff).toMatchObject({ local: 'needs_auth', broker: 'authenticated' })
  })

  it('returns empty when local and broker agree', async () => {
    const { shadowDiff } = await import(MODULE)
    const same = {
      profile_name: 'p1',
      credentials: [{ id: 'gitlab', title: 'GitLab', provider: 'gitlab', installed: true,
        status: 'configured', action: { kind: 'manual', label: '' } }],
    }
    expect(shadowDiff(same as any, JSON.parse(JSON.stringify(same)))).toEqual([])
  })
})
