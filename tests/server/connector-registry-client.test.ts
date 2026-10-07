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
       'gitlab', 'gitlab-personal', 'github-mcp'])
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

describe('connector catalog and custom installation broker calls', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))

  it('stamps the trusted owner/profile and never forwards browser identity fields', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        source_count: 642,
        canonical_count: 330,
        connectors: Array.from({ length: 642 }, (_, index) => ({ row_key: `row-${index}` })),
      }),
    })
    const { completeCatalogOAuth, connectCatalogConnector, fetchConnectorCatalog, importCustomConnectors } = await import(MODULE)
    await fetchConnectorCatalog({ profileName: 'p1', ownerOpenId: 'ou_alice', view: 'source' })
    await importCustomConnectors({
      profileName: 'p1',
      ownerOpenId: 'ou_alice',
      config: '{"mcpServers":{}}',
    })
    await connectCatalogConnector({
      profileName: 'p1', ownerOpenId: 'ou_alice', rowKey: 'workbuddy:ready',
      fields: { Authorization: 'Bearer secret' },
    })
    await completeCatalogOAuth({ state: 'opaque-state', code: 'oauth-code' })
    const [catalogUrl, catalogInit] = (globalThis.fetch as any).mock.calls[0]
    expect(catalogUrl).toBe('http://broker.test/api/run-broker/connector-catalog?view=source')
    expect(catalogInit.headers).toMatchObject({
      Authorization: 'Bearer k-test',
      'X-Hermes-Owner-Open-Id': 'ou_alice',
      'X-Hermes-Profile': 'p1',
    })
    const [, importInit] = (globalThis.fetch as any).mock.calls[1]
    expect(JSON.parse(importInit.body)).toEqual({ config: '{"mcpServers":{}}' })
    expect(importInit.body).not.toContain('ou_alice')
    expect(importInit.body).not.toContain('profile_name')
    const [, connectInit] = (globalThis.fetch as any).mock.calls[2]
    expect(JSON.parse(connectInit.body)).toEqual({
      row_key: 'workbuddy:ready', fields: { Authorization: 'Bearer secret' },
    })
    expect(connectInit.body).not.toContain('ou_alice')
    const [callbackUrl, callbackInit] = (globalThis.fetch as any).mock.calls[3]
    expect(callbackUrl).toBe('http://broker.test/api/run-broker/connector-catalog/oauth/callback')
    expect(callbackInit.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer k-test' }))
    expect(callbackInit.headers).not.toHaveProperty('X-Hermes-Owner-Open-Id')
    expect(JSON.parse(callbackInit.body)).toEqual({ state: 'opaque-state', code: 'oauth-code' })
  })

  // RFC 9207 的 `iss`：Figma 的真实回调带它（`?code=…&iss=https%3A%2F%2Fapi.figma.com&state=…`）。
  // MT 对 figma 的 state 接受可选 iss，对别的 state 仍要求精确 {state, code}，所以这一层
  // 只做两件事：像样就原样转，不像样就当没有 —— 任何情况下都不自己拼一个。
  it('forwards a plausible https iss verbatim on the catalog OAuth callback', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
    const { completeCatalogOAuth } = await import(MODULE)
    await completeCatalogOAuth({ state: 'opaque-state', code: 'oauth-code', iss: 'https://api.figma.com' })
    const [, init] = (globalThis.fetch as any).mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({
      state: 'opaque-state', code: 'oauth-code', iss: 'https://api.figma.com',
    })
  })

  it('keeps the exact {state, code} body when no iss comes back', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
    const { completeCatalogOAuth } = await import(MODULE)
    await completeCatalogOAuth({ state: 'opaque-state', code: 'oauth-code' })
    const [, init] = (globalThis.fetch as any).mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({ state: 'opaque-state', code: 'oauth-code' })
    expect(init.body).not.toContain('iss')
  })

  // 「没带 issuer」和「带了个错的 issuer」必须是两件事。把后者静默降级成前者，
  // broker 就再也分不出来，回调的身份校验边界等于送人（codex review 2026-09-21,
  // `sanitizeoauthissuer:invalid-issuer-downgrade`）。
  it('classifies absent / valid / invalid iss as three distinct states', async () => {
    const { classifyOAuthIssuer, sanitizeOAuthIssuer } = await import(MODULE)
    // 只有键根本不在 query 里才算没带。
    expect(classifyOAuthIssuer(undefined)).toEqual({ kind: 'absent' })
    expect(classifyOAuthIssuer(null)).toEqual({ kind: 'absent' })
    expect(classifyOAuthIssuer('https://api.figma.com')).toEqual({
      kind: 'valid', value: 'https://api.figma.com',
    })
    const invalid = [
      'http://api.figma.com',                 // 非 https
      'javascript:alert(1)',                  // 不是 http(s) 的 scheme
      'api.figma.com',                        // 不是绝对 URL
      'https://',                             // 没有 host
      `https://api.figma.com/${'a'.repeat(300)}`,  // 超长
      'https://api.figma.com\nX-Injected: 1', // 控制字符
      '',                                     // 带了一个空 issuer —— 是错，不是没带
      '   ',
      ['https://api.figma.com'],              // 重复 query 键
      ['https://api.figma.com', 'https://evil.example'],
      42,
    ]
    for (const iss of invalid) {
      expect(classifyOAuthIssuer(iss as any), JSON.stringify(iss)).toMatchObject({ kind: 'invalid' })
      // sanitize 只取「能转发的值」那一面，判 400 要看 classify。
      expect(sanitizeOAuthIssuer(iss as any), JSON.stringify(iss)).toBe('')
    }
    expect(sanitizeOAuthIssuer(undefined)).toBe('')
  })

  it('rejects an explicitly invalid iss with 400 and never reaches the broker', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
    const { completeCatalogOAuth } = await import(MODULE)
    for (const iss of ['http://api.figma.com', 'javascript:alert(1)', '', ['https://api.figma.com']]) {
      const err = await completeCatalogOAuth({ state: 'opaque-state', code: 'oauth-code', iss: iss as any })
        .then(() => null, (e: any) => e)
      expect(err, JSON.stringify(iss)).toBeInstanceOf(Error)
      expect(err.status, JSON.stringify(iss)).toBe(400)
    }
    expect((globalThis.fetch as any)).not.toHaveBeenCalled()
  })

  it('fails closed on a malformed catalog and keeps icon paths on the BFF', async () => {
    ;(globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        source_count: 642,
        canonical_count: 330,
        connectors: [
          { row_key: 'workbuddy:demo server', icon: { url: '/api/run-broker/secret/path' } },
          ...Array.from({ length: 641 }, (_, index) => ({ row_key: `row-${index}` })),
        ],
      }),
    }).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ source_count: 641, connectors: [] }) })
    const { fetchConnectorCatalog } = await import(MODULE)
    const result = await fetchConnectorCatalog({ profileName: 'p1', ownerOpenId: 'ou_alice', view: 'source' })
    expect(result.connectors[0].icon.url).toBe('/api/auth/skill-credentials/catalog/icon?row_key=workbuddy%3Ademo%20server')
    await expect(fetchConnectorCatalog({ profileName: 'p1', ownerOpenId: 'ou_alice', view: 'source' }))
      .rejects.toThrow('catalog counts')
  })

  it('admits icon keys only after exact membership in a valid frozen catalog', async () => {
    ;(globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        source_count: 642,
        canonical_count: 330,
        connectors: [
          { row_key: 'workbuddy:known', icon: { url: '/icon.png' } },
          ...Array.from({ length: 641 }, (_, index) => ({ row_key: `exact-${index}` })),
        ],
      }),
    })
    const { fetchConnectorCatalog, isKnownConnectorIconKey } = await import(MODULE)
    await fetchConnectorCatalog({ profileName: 'p1', ownerOpenId: 'ou_alice', view: 'source' })

    expect(isKnownConnectorIconKey('workbuddy:known')).toBe(true)
    expect(isKnownConnectorIconKey('../etc/passwd')).toBe(false)
    expect(isKnownConnectorIconKey('/etc/hosts')).toBe(false)
    expect(isKnownConnectorIconKey('workbuddy:unknown')).toBe(false)
  })

  it('rejects oversized custom config before broker dispatch', async () => {
    const { importCustomConnectors } = await import(MODULE)
    expect(() => importCustomConnectors({
      profileName: 'p1',
      ownerOpenId: 'ou_alice',
      config: 'x'.repeat(64 * 1024 + 1),
    })).toThrow('connector config is empty or too large')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

// 撤销是唯一一个「答错了员工就不再看」的动作：告诉他"已撤销"而 token 还在盘上，
// 比直接报错坏得多。MT 的成功形状只有 `{ok:true, revoked:<bool>}`
// （webui_broker_server.handle_figma_credential），其余一律当失败抛出。
// codex review 2026-09-21, `revokefigmaauthorization:unvalidated-success`。
describe('revokeFigmaAuthorization validates the broker business result', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))

  const owner = { profileName: 'p1', ownerOpenId: 'ou_alice' }

  it('returns revoked:true on the documented success body', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: true, revoked: true }),
    })
    const { revokeFigmaAuthorization } = await import(MODULE)
    await expect(revokeFigmaAuthorization(owner)).resolves.toEqual({ revoked: true })
  })

  it('keeps the genuine idempotent success {ok:true, revoked:false}', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: true, revoked: false }),
    })
    const { revokeFigmaAuthorization } = await import(MODULE)
    await expect(revokeFigmaAuthorization(owner)).resolves.toEqual({ revoked: false })
  })

  it('throws on HTTP 200 with ok:false instead of reporting a silent revoked:false', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: false, error: 'Figma 授权服务暂不可用，请稍后重试。' }),
    })
    const { revokeFigmaAuthorization } = await import(MODULE)
    const err = await revokeFigmaAuthorization(owner).then(() => null, (e: any) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(502)
    // broker 自己给的理由要带出去，控制器才能把它显示给员工。
    expect(err.message).toContain('Figma 授权服务暂不可用')
  })

  it('throws when the body does not parse to the expected shape', async () => {
    // ownerBrokerJson 在 JSON 解析失败时交出 `{}` —— 旧写法把它当成 revoked:false。
    const bodies = [{}, { revoked: true }, { ok: 'true', revoked: true }, [], null, 'revoked']
    const { revokeFigmaAuthorization } = await import(MODULE)
    for (const body of bodies) {
      ;(globalThis.fetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => body })
      const err = await revokeFigmaAuthorization(owner).then(() => null, (e: any) => e)
      expect(err, JSON.stringify(body)).toBeInstanceOf(Error)
      expect(err.status, JSON.stringify(body)).toBe(502)
    }
  })

  it('throws when ok is true but revoked is not a boolean', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: true, revoked: 'yes' }),
    })
    const { revokeFigmaAuthorization } = await import(MODULE)
    const err = await revokeFigmaAuthorization(owner).then(() => null, (e: any) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(502)
  })
})

describe('connector request shape allowlist', () => {
  it('accepts only documented query and body keys', async () => {
    const { connectorRequestHasOnly } = await import('../../packages/server/src/services/hermes/connector-request-shape')
    expect(connectorRequestHasOnly({ view: 'source' }, undefined, ['view'], [])).toBe(true)
    expect(connectorRequestHasOnly({}, { config: '{}' }, [], ['config'])).toBe(true)
    expect(connectorRequestHasOnly({ profile: 'other' }, undefined, ['view'], [])).toBe(false)
    expect(connectorRequestHasOnly({}, { config: '{}', owner: 'other' }, [], ['config'])).toBe(false)
    expect(connectorRequestHasOnly({ profile: ['other'] }, undefined, [], [])).toBe(false)
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
