import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Koa from 'koa'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AddressInfo } from 'net'

/**
 * End-to-end RBAC + BFF proof for the console shell (design §8c A1/A3/A4/A5).
 * Mounts the real console routes + guards in a Koa app, injects a session via a
 * middleware (standing in for Feishu OAuth), stubs the run-broker fetch, and
 * asserts the security-critical behavior that unit tests can't cover in isolation:
 *   - no session          → 401 on every console route
 *   - non-admin session   → 404 on admin routes (ops plane invisible)
 *   - admin session       → forwards to broker with master key, browser never sees it
 *   - dev/me              → only the SESSION owner's agents, ?owner= override ignored
 */

let dir: string
let adminsFile: string
const brokerCalls: Array<{ url: string; auth?: string }> = []

function seedAdmins(unionIds: string[]) {
  writeFileSync(adminsFile, JSON.stringify({ admins: unionIds }), 'utf8')
}

/** Fake run-broker: intercepts ONLY broker.test calls (records url+auth, returns
 *  canned console_api shapes); everything else (the test's own calls to the koa
 *  server on 127.0.0.1) passes through to the real fetch. */
function stubFetch() {
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (url: any, init?: RequestInit) => {
    const u = new URL(String(url))
    if (u.hostname !== 'broker.test') return realFetch(url, init)
    brokerCalls.push({ url: String(url), auth: (init?.headers as any)?.Authorization })
    const body = (() => {
      if (u.pathname.endsWith('/console/overview')) return { broker: { alive: true }, active: { user: 3 }, skillhub: { failed: 0 }, reauth_pending_count: 0, cache_age_s: 0 }
      if (u.pathname.endsWith('/console/agents')) {
        // the owner-column endpoint: broker already scoped by owner=<open_id>.
        // Echo the owner so the test can assert the BFF passed the SESSION open_id.
        // Include a MISMATCHED-owner row to prove the BFF's defense-in-depth filter
        // drops it even if the broker's scoping regressed.
        const owner = u.searchParams.get('owner')
        return { owner_open_id: owner, available: true, items: owner === 'open-self'
          ? [
              { profile: 'feishu_self', owner_open_id: 'open-self', display_label: 'ME', kind: 'user', active: 1 },
              { profile: 'ag_mine', owner_open_id: 'open-self', display_label: 'MINE', kind: 'agent', active: 1 },
              { profile: 'group_mine', owner_open_id: 'open-self', display_label: 'GROUP', kind: 'group', active: 1 },
              { profile: 'ag_leak', owner_open_id: 'open-other', display_label: 'LEAK', kind: 'agent', active: 1 },
            ]
          : [] }
      }
      return { ok: true }
    })()
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

async function makeApp(sessionUser: Record<string, unknown> | null, opts: { noBrokerKey?: boolean } = {}) {
  vi.resetModules()
  process.env.HERMES_CONSOLE_ADMINS_FILE = adminsFile
  process.env.HERMES_RUN_BROKER_URL = 'http://broker.test'
  if (opts.noBrokerKey) delete process.env.HERMES_RUN_BROKER_KEY
  else process.env.HERMES_RUN_BROKER_KEY = 'master-key-secret'
  const { consoleRoutes } = await import('../../packages/server/src/routes/hermes/console')
  const app = new Koa()
  app.use(async (ctx, next) => { ctx.state.user = sessionUser ?? undefined; await next() })
  app.use(consoleRoutes.routes())
  const server = app.listen(0)
  const port = (server.address() as AddressInfo).port
  return { server, base: `http://127.0.0.1:${port}` }
}

describe('console BFF + RBAC (integration)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'console-bff-'))
    adminsFile = join(dir, 'console-admins.json')
    brokerCalls.length = 0
    stubFetch()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
    delete process.env.HERMES_CONSOLE_ADMINS_FILE
  })

  it('rejects every admin route with 401 when unauthenticated', async () => {
    seedAdmins(['ou-admin'])
    const { server, base } = await makeApp(null)
    try {
      for (const p of ['/api/console/overview', '/api/console/profiles', '/api/console/profiles/x', '/api/console/reauth-pending']) {
        const r = await fetch(base + p)
        expect(r.status).toBe(401)
      }
    } finally { server.close() }
  })

  it('returns 404 on admin routes for a logged-in non-admin (ops plane hidden)', async () => {
    seedAdmins(['ou-admin'])
    const { server, base } = await makeApp({ openid: 'open-x', unionId: 'ou-not-admin' })
    try {
      const r = await fetch(base + '/api/console/overview')
      expect(r.status).toBe(404)
      expect(brokerCalls.length).toBe(0) // never reached the broker
    } finally { server.close() }
  })

  it('forwards admin request to the broker with the master key (browser never sees it)', async () => {
    seedAdmins(['ou-admin'])
    const { server, base } = await makeApp({ openid: 'open-a', unionId: 'ou-admin' })
    try {
      const r = await fetch(base + '/api/console/overview')
      expect(r.status).toBe(200)
      const body = await r.json()
      expect(body.active.user).toBe(3)
      expect(brokerCalls[0].url).toContain('/api/run-broker/console/overview')
      expect(brokerCalls[0].auth).toBe('Bearer master-key-secret')
    } finally { server.close() }
  })

  it('clamps the profiles limit to 200 (A9)', async () => {
    seedAdmins(['ou-admin'])
    const { server, base } = await makeApp({ openid: 'open-a', unionId: 'ou-admin' })
    try {
      await fetch(base + '/api/console/profiles?limit=999999')
      expect(new URL(brokerCalls[0].url).searchParams.get('limit')).toBe('200')
    } finally { server.close() }
  })

  it('dev/me returns only the session owner\'s active fleet with kind and ignores ?owner= (A5 self-scope)', async () => {
    seedAdmins([]) // developer plane needs no admin
    const { server, base } = await makeApp({ openid: 'open-self', unionId: 'ou-dev' })
    try {
      // attacker tries to scope to someone else via query — must be ignored
      const r = await fetch(base + '/api/console/dev/me?owner=open-other')
      expect(r.status).toBe(200)
      const body = await r.json()
      expect(body.developer.open_id).toBe('open-self')
      const names = body.agents.map((a: any) => a.name)
      expect(names).toEqual(['ME', 'MINE', 'GROUP']) // only own active fleet
      expect(names).not.toContain('LEAK')           // defense-in-depth drops mismatched owner
      expect(body.agents.map((a: any) => a.kind)).toEqual(['user', 'agent', 'group'])
      // owner-column endpoint scoped by the SESSION open_id, not the client param
      expect(new URL(brokerCalls[0].url).pathname).toContain('/console/agents')
      expect(new URL(brokerCalls[0].url).searchParams.get('owner')).toBe('open-self')
      expect(body.api_catalog.length).toBe(4)
    } finally { server.close() }
  })

  it('is fail-closed: no master key → 503, request never reaches the broker', async () => {
    seedAdmins(['ou-admin'])
    const { server, base } = await makeApp({ openid: 'open-a', unionId: 'ou-admin' }, { noBrokerKey: true })
    try {
      const r = await fetch(base + '/api/console/overview')
      expect(r.status).toBe(503)
      expect(brokerCalls.length).toBe(0) // never forwarded a keyless request
    } finally {
      server.close()
    }
  })

  it('does not leak the broker raw error body to the caller (§ leak fix)', async () => {
    seedAdmins(['ou-admin'])
    // stub broker to 500 with an internal-detail body
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (url: any, init?: RequestInit) => {
      const u = new URL(String(url))
      if (u.hostname !== 'broker.test') return realFetch(url, init)
      brokerCalls.push({ url: String(url) })
      return new Response(JSON.stringify({ error: '/home/hermes/.hermes/secret/path exploded', trace: 'internal' }),
        { status: 500, headers: { 'content-type': 'application/json' } })
    })
    const { server, base } = await makeApp({ openid: 'open-a', unionId: 'ou-admin' })
    try {
      const r = await fetch(base + '/api/console/overview')
      expect(r.status).toBe(502) // 5xx mapped to generic 502
      const body = await r.json()
      expect(JSON.stringify(body)).not.toContain('secret/path')
      expect(JSON.stringify(body)).not.toContain('trace')
    } finally { server.close() }
  })

  it('degrades a malformed 200 body to 502 instead of an unhandled 500', async () => {
    seedAdmins(['ou-admin'])
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (url: any, init?: RequestInit) => {
      const u = new URL(String(url))
      if (u.hostname !== 'broker.test') return realFetch(url, init)
      return new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } })
    })
    const { server, base } = await makeApp({ openid: 'open-a', unionId: 'ou-admin' })
    try {
      const r = await fetch(base + '/api/console/overview')
      expect(r.status).toBe(502)
    } finally { server.close() }
  })

  it('dev/me degrades gracefully when the agents endpoint is unavailable', async () => {
    seedAdmins([])
    // broker lacks /console/agents (version skew) → 404
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (url: any, init?: RequestInit) => {
      const u = new URL(String(url))
      if (u.hostname !== 'broker.test') return realFetch(url, init)
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    })
    const { server, base } = await makeApp({ openid: 'open-self', unionId: 'ou-dev' })
    try {
      const r = await fetch(base + '/api/console/dev/me')
      expect(r.status).toBe(200) // page still serves
      const body = await r.json()
      expect(body.agents).toEqual([])            // no agents, but not an error page
      expect(body.agents_unavailable).toBe(true) // UI can show a "temporarily unavailable" note
      expect(body.api_catalog.length).toBe(4)    // the static catalog still renders
    } finally { server.close() }
  })

  it('dev/me treats broker available:false (200) as unavailable, not empty', async () => {
    seedAdmins([])
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (url: any, init?: RequestInit) => {
      const u = new URL(String(url))
      if (u.hostname !== 'broker.test') return realFetch(url, init)
      // 200 but the routing DB was unreadable → available:false, empty items
      return new Response(JSON.stringify({ available: false, items: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const { server, base } = await makeApp({ openid: 'open-self', unionId: 'ou-dev' })
    try {
      const r = await fetch(base + '/api/console/dev/me')
      expect(r.status).toBe(200)
      const body = await r.json()
      expect(body.agents_unavailable).toBe(true) // "稍后重试", not "你名下暂无 agent"
      expect(body.api_catalog.length).toBe(4)
    } finally { server.close() }
  })

  it('dev/me requires a session', async () => {
    seedAdmins([])
    const { server, base } = await makeApp(null)
    try {
      const r = await fetch(base + '/api/console/dev/me')
      expect(r.status).toBe(401)
    } finally { server.close() }
  })
})
