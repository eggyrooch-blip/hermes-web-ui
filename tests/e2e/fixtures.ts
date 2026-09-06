import type { Page, Request, Route } from '@playwright/test'

export const TEST_ACCESS_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwidXNlcm5hbWUiOiJwbGF5d3JpZ2h0Iiwicm9sZSI6InN1cGVyX2FkbWluIiwidHlwZSI6ImFjY2VzcyIsImF1ZCI6Imhlcm1lcy13ZWItdWkiLCJpYXQiOjE3NjAwMDAwMDAsImV4cCI6NDEwMjQ0NDgwMH0.playwright-signature'

export interface MockedRequest {
  method: string
  pathname: string
  search: string
  headers: Record<string, string>
  postData: string | null
}

interface MockHermesApiOptions {
  tokenValidationStatus?: number
  initialProfileName?: 'default' | 'research'
  sessions?: unknown[]
  experts?: unknown[]
  harnessEnabled?: boolean
  expertWorkRecords?: Record<string, unknown>
}

const sampleModelGroup = {
  provider: 'test-provider',
  label: 'Test Provider',
  base_url: 'https://example.invalid/v1',
  models: ['test-model'],
  available_models: ['test-model'],
  api_key: '',
  builtin: true,
}

const sampleJob = {
  job_id: 'job-smoke',
  id: 'job-smoke',
  name: 'Nightly Smoke',
  prompt: 'Run the smoke check',
  prompt_preview: 'Run the smoke check',
  skills: [],
  skill: null,
  model: 'test-model',
  provider: 'test-provider',
  base_url: null,
  script: null,
  schedule: '0 9 * * *',
  schedule_display: '0 9 * * *',
  repeat: { times: null, completed: 0 },
  enabled: true,
  state: 'scheduled',
  paused_at: null,
  paused_reason: null,
  created_at: '2026-01-01T00:00:00.000Z',
  next_run_at: '2026-01-02T09:00:00.000Z',
  last_run_at: null,
  last_status: null,
  last_error: null,
  deliver: 'origin',
  origin: null,
  last_delivery_error: null,
}

const sampleAuxiliaryModelTasks = [
  { key: 'vision', label: 'Vision', default_timeout: 120, default_download_timeout: 30 },
  { key: 'web_extract', label: 'Web extract', default_timeout: 360 },
  { key: 'compression', label: 'Compression', default_timeout: 120 },
  { key: 'skills_hub', label: 'Skills hub', default_timeout: 30 },
  { key: 'approval', label: 'Approval', default_timeout: 30 },
  { key: 'mcp', label: 'MCP', default_timeout: 30 },
  { key: 'title_generation', label: 'Title generation', default_timeout: 30 },
  { key: 'triage_specifier', label: 'Triage specifier', default_timeout: 120 },
  { key: 'kanban_decomposer', label: 'Kanban decomposer', default_timeout: 180 },
  { key: 'profile_describer', label: 'Profile describer', default_timeout: 60 },
  { key: 'curator', label: 'Curator', default_timeout: 600 },
  { key: 'session_search', label: 'Session search', default_timeout: 30 },
  { key: 'flush_memories', label: 'Flush memories', default_timeout: 30 },
]

function jsonResponse(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  }
}

function recordRequest(request: Request): MockedRequest {
  const url = new URL(request.url())
  return {
    method: request.method(),
    pathname: url.pathname,
    search: url.search,
    headers: request.headers(),
    postData: request.postData(),
  }
}

export async function mockHermesApi(page: Page, options: MockHermesApiOptions = {}) {
  const requests: MockedRequest[] = []
  const unexpectedRequests: MockedRequest[] = []
  const tokenValidationStatus = options.tokenValidationStatus ?? 200
  let activeProfileName = options.initialProfileName ?? 'research'
  const feedback = new Map<string, Record<string, unknown>>()
  const sessions = (options.sessions ?? []) as Array<Record<string, any>>
  const experts = (options.experts ?? []) as Array<Record<string, any>>

  await page.route('**/*', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url

    if (!(pathname === '/health' || pathname.startsWith('/api/') || pathname.startsWith('/v1/'))) {
      await route.continue()
      return
    }

    requests.push(recordRequest(request))

    if (pathname === '/health') {
      await route.fulfill(jsonResponse({ status: 'ok', webui_version: '0.5.23', node_version: '23.0.0' }))
      return
    }

    if (pathname === '/api/auth/status') {
      await route.fulfill(jsonResponse({ hasPasswordLogin: true, username: 'playwright' }))
      return
    }

    if (pathname === '/api/auth/login') {
      if (request.method() !== 'POST') {
        await route.fulfill(jsonResponse({ error: 'Method not allowed' }, 405))
        return
      }
      if (tokenValidationStatus !== 200) {
        await route.fulfill(jsonResponse({ error: 'Invalid username or password' }, tokenValidationStatus))
        return
      }
      await route.fulfill(jsonResponse({ token: TEST_ACCESS_KEY }))
      return
    }

    if (pathname === '/api/auth/me') {
      await route.fulfill(jsonResponse({
        user: {
          id: 1,
          username: 'playwright',
          role: 'super_admin',
          status: 'active',
          created_at: 0,
          updated_at: 0,
          last_login_at: 0,
          avatar: '',
        },
      }))
      return
    }

    if (pathname === '/api/auth/avatar') {
      if (request.method() === 'GET') {
        await route.fulfill(jsonResponse({ avatar: '' }))
        return
      }
      if (request.method() === 'PUT') {
        await route.fulfill(jsonResponse({ success: true, avatar: '' }))
        return
      }
      await route.fulfill(jsonResponse({ error: 'Method not allowed' }, 405))
      return
    }

    if (pathname === '/api/hermes/sessions') {
      await route.fulfill(jsonResponse({ sessions }, tokenValidationStatus))
      return
    }

    if (pathname === '/api/hermes/sessions/hermes') {
      await route.fulfill(jsonResponse({ sessions: [] }))
      return
    }

    if (pathname === '/api/hermes/sessions/context-length') {
      await route.fulfill(jsonResponse({ context_length: 256000 }))
      return
    }

    const expertMutationMatch = pathname.match(/^\/api\/hermes\/sessions\/([^/]+)\/expert$/)
    if (expertMutationMatch && request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}') as {
        expert_id?: string | null
        execution_engine?: string
      }
      const sessionId = decodeURIComponent(expertMutationMatch[1])
      let session = sessions.find(item => item.id === sessionId)
      const expert = experts.find(item => item.id === body.expert_id)
      if (!session) {
        session = {
          id: sessionId,
          profile: url.searchParams.get('profile') || activeProfileName,
          source: 'cli',
          model: '',
          provider: '',
          title: null,
          preview: '',
          started_at: 1,
          ended_at: null,
          last_active: 1,
          message_count: 0,
          tool_call_count: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          billing_provider: null,
          estimated_cost_usd: 0,
          actual_cost_usd: null,
          cost_status: '',
        }
        sessions.unshift(session)
      }
      session.expert_id = body.expert_id ?? null
      session.expert_label = expert?.title || expert?.name || body.expert_id || null
      session.expert_avatar = expert?.avatar || null
      session.execution_engine = body.execution_engine ?? 'hermes'
      await route.fulfill(jsonResponse({ success: true, session }))
      return
    }

    const modelMutationMatch = pathname.match(/^\/api\/hermes\/sessions\/([^/]+)\/model$/)
    if (modelMutationMatch && request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}') as { model?: string; provider?: string }
      const sessionId = decodeURIComponent(modelMutationMatch[1])
      const session = sessions.find(item => item.id === sessionId)
      if (session) {
        session.model = body.model || ''
        session.provider = body.provider || ''
      }
      await route.fulfill(jsonResponse({ ok: true }))
      return
    }

    const feedbackListMatch = pathname.match(/^\/api\/hermes\/sessions\/([^/]+)\/feedback$/)
    if (feedbackListMatch && request.method() === 'GET') {
      const sessionId = decodeURIComponent(feedbackListMatch[1])
      await route.fulfill(jsonResponse({
        feedback: [...feedback.values()].filter(row => row.session_id === sessionId),
      }))
      return
    }

    const feedbackMutationMatch = pathname.match(/^\/api\/hermes\/sessions\/([^/]+)\/runs\/([^/]+)\/feedback$/)
    if (feedbackMutationMatch) {
      const sessionId = decodeURIComponent(feedbackMutationMatch[1])
      const runId = decodeURIComponent(feedbackMutationMatch[2])
      const rowKey = `${sessionId}\n${runId}`
      if (request.method() === 'DELETE') {
        feedback.delete(rowKey)
        await route.fulfill(jsonResponse({ ok: true, feedback: null }))
        return
      }
      if (request.method() === 'PUT') {
        const body = JSON.parse(request.postData() || '{}') as { rating?: string; reason?: string | null }
        const row = {
          session_id: sessionId,
          run_id: runId,
          expert_id: null,
          rating: body.rating,
          reason: body.reason ?? null,
          created_at: 1,
          updated_at: 1,
        }
        feedback.set(rowKey, row)
        await route.fulfill(jsonResponse({ feedback: row }))
        return
      }
    }

    if (/^\/api\/hermes\/sessions\/[^/]+\/workspace-run-changes$/.test(pathname)) {
      await route.fulfill(jsonResponse({ changes: [] }))
      return
    }

    if (pathname === '/api/hermes/files/list') {
      await route.fulfill(jsonResponse({ entries: [], path: '' }))
      return
    }

    if (pathname === '/api/hermes/auth/copilot/check-token') {
      await route.fulfill(jsonResponse({ has_token: false, source: null, enabled: false }))
      return
    }

    if (pathname === '/api/auth/locked-ips') {
      await route.fulfill(jsonResponse({ locks: [] }))
      return
    }

    if (pathname === '/api/hermes/available-models') {
      await route.fulfill(jsonResponse({
        default: 'test-model',
        default_provider: 'test-provider',
        groups: [sampleModelGroup],
        allProviders: [sampleModelGroup],
        model_aliases: {},
        model_visibility: {},
      }))
      return
    }

    if (pathname === '/api/hermes/provider-models') {
      await route.fulfill(jsonResponse({ models: ['proxy-model-a', 'proxy-model-b'] }))
      return
    }

    if (pathname === '/api/hermes/config/auxiliary-models') {
      await route.fulfill(jsonResponse({ tasks: sampleAuxiliaryModelTasks, auxiliary: {} }))
      return
    }

    if (pathname === '/api/auth/skill-credentials') {
      await route.fulfill(jsonResponse({
        profile_name: activeProfileName,
        credentials: [
          {
            id: 'lark-cli',
            title: 'Lark CLI',
            provider: 'Feishu',
            installed: true,
            status: 'needs_auth',
            detail: 'Connect Feishu capabilities',
            required_by: ['lark-cli'],
            action: { kind: 'feishu_device_flow', label: 'Connect' },
          },
        ],
      }))
      return
    }

    if (pathname === '/api/auth/skill-credentials/catalog') {
      await route.fulfill(jsonResponse({
        profile_name: activeProfileName,
        subject_id: 'playwright-owner',
        view: url.searchParams.get('view') === 'canonical' ? 'canonical' : 'source',
        source_count: 642,
        canonical_count: 330,
        connectors: [],
      }))
      return
    }

    if (pathname === '/api/auth/skill-credentials/custom') {
      await route.fulfill(jsonResponse({
        profile_name: activeProfileName,
        subject_id: 'playwright-owner',
        connectors: [],
      }))
      return
    }

    if (pathname === '/api/hermes/skills') {
      await route.fulfill(jsonResponse({
        categories: [
          {
            name: 'local',
            description: 'Local skills',
            skills: [
              {
                name: 'research-helper',
                description: 'Research helper',
                source: 'local',
                enabled: true,
              },
            ],
          },
        ],
        archived: [],
      }))
      return
    }

    if (pathname === '/api/hermes/experts') {
      await route.fulfill(jsonResponse({
        experts,
        profile_name: activeProfileName,
        harness_enabled: options.harnessEnabled === true,
      }))
      return
    }

    const workRecordMatch = pathname.match(/^\/api\/hermes\/experts\/([^/]+)\/work-record$/)
    if (workRecordMatch) {
      const expertId = decodeURIComponent(workRecordMatch[1])
      const mode = url.searchParams.get('view') === 'maintainer' ? 'maintainer' : 'user'
      const record = options.expertWorkRecords?.[mode]
      await route.fulfill(record
        ? jsonResponse(record)
        : jsonResponse({ error: 'not found', expert_id: expertId }, mode === 'maintainer' ? 404 : 200))
      return
    }

    if (pathname === '/api/hermes/write-gate/pending') {
      await route.fulfill(jsonResponse({
        records: [],
        counts: { memory: 0, skills: 0 },
        supported: true,
      }))
      return
    }

    if (pathname === '/api/hermes/plugins') {
      await route.fulfill(jsonResponse({ plugins: [], warnings: [], metadata: { projectPluginsEnabled: true } }))
      return
    }

    if (pathname === '/api/hermes/mcp/servers') {
      await route.fulfill(jsonResponse({ ok: true, servers: [], total_tools: 0, partial: false }))
      return
    }

    if (pathname === '/api/hermes/profiles') {
      await route.fulfill(jsonResponse({
        profiles: [
          { name: 'default', active: activeProfileName === 'default', model: 'test-model', gateway: 'test', alias: 'Default' },
          { name: 'research', active: activeProfileName === 'research', model: 'test-model', gateway: 'test', alias: 'Research' },
        ],
      }))
      return
    }

    if (pathname === '/api/hermes/profiles/runtime-statuses') {
      await route.fulfill(jsonResponse({
        profiles: [
          {
            profile: 'default',
            bridge: { running: activeProfileName === 'default', profile: 'default', reachable: true },
            gateway: { running: true, profile: 'default' },
          },
          {
            profile: 'research',
            bridge: { running: activeProfileName === 'research', profile: 'research', reachable: true },
            gateway: { running: true, profile: 'research' },
          },
        ],
      }))
      return
    }

    if (pathname === '/api/hermes/profiles/active') {
      if (request.method() !== 'PUT') {
        await route.fulfill(jsonResponse({ error: 'Method not allowed' }, 405))
        return
      }

      let body: { name?: unknown }
      try {
        body = JSON.parse(request.postData() || '{}')
      } catch {
        await route.fulfill(jsonResponse({ error: 'Invalid JSON body' }, 400))
        return
      }

      if (body.name !== 'default' && body.name !== 'research') {
        await route.fulfill(jsonResponse({ error: 'Unknown profile' }, 400))
        return
      }

      activeProfileName = body.name
      await route.fulfill(jsonResponse({ success: true, active: activeProfileName }))
      return
    }

    if (pathname === '/api/hermes/config') {
      await route.fulfill(jsonResponse({
        display: { streaming: true, show_reasoning: true, show_cost: true },
        agent: {},
        memory: {},
        session_reset: {},
        privacy: {},
        approvals: {},
      }))
      return
    }

    if (pathname === '/api/hermes/jobs') {
      if (request.method() === 'GET') {
        await route.fulfill(jsonResponse({ jobs: [sampleJob] }))
        return
      }
      if (request.method() === 'POST') {
        const body = JSON.parse(request.postData() || '{}')
        await route.fulfill(jsonResponse({ job: { ...sampleJob, ...body, id: 'job-scheduled', job_id: 'job-scheduled' } }))
        return
      }
      await route.fulfill(jsonResponse({ error: 'Method not allowed' }, 405))
      return
    }

    if (pathname === '/api/cron-history') {
      await route.fulfill(jsonResponse({ runs: [] }))
      return
    }

    unexpectedRequests.push(recordRequest(request))
    await route.fulfill(jsonResponse({ error: `Unexpected mocked route: ${request.method()} ${pathname}` }, 404))
  })

  return { requests, unexpectedRequests }
}

export async function authenticate(page: Page, accessKey = TEST_ACCESS_KEY, profileName?: string) {
  await page.addInitScript((state: { storedToken: string; storedProfileName?: string }) => {
    const { storedToken, storedProfileName } = state
    window.localStorage.setItem('hermes_api_key', storedToken)
    if (storedProfileName && !window.localStorage.getItem('hermes_active_profile_name')) {
      window.localStorage.setItem('hermes_active_profile_name', storedProfileName)
    }
  }, { storedToken: accessKey, storedProfileName: profileName })
}

export async function mockChatSocket(page: Page) {
  await page.route('**/node_modules/.vite/deps/socket__io-client.js*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
const state = window.__PW_CHAT_SOCKET__ || (window.__PW_CHAT_SOCKET__ = { sockets: [], emitted: [] })
function makeSocket(url, options) {
  const listeners = new Map()
  const onceListeners = new Map()
  const socket = {
    connected: true,
    url,
    options,
    on(event, handler) {
      const handlers = listeners.get(event) || []
      handlers.push(handler)
      listeners.set(event, handlers)
      return this
    },
    once(event, handler) {
      const handlers = onceListeners.get(event) || []
      handlers.push(handler)
      onceListeners.set(event, handlers)
      return this
    },
    emit(event, payload) {
      state.emitted.push({ event, payload })
      if (event === 'resume') {
        const sessionId = payload && payload.session_id
        const resumes = window.__PW_CHAT_SOCKET_RESUMES__ || {}
        const configured = sessionId ? resumes[sessionId] : null
        const response = Array.isArray(configured) ? configured.shift() : configured
        const resumed = response && response.payload ? response.payload : response
        if (resumed) {
          setTimeout(() => this.__trigger('resumed', resumed), Number(response.delay_ms) || 0)
        }
      }
      return this
    },
    removeAllListeners() {
      listeners.clear()
      onceListeners.clear()
      return this
    },
    disconnect() {
      this.connected = false
      return this
    },
    __trigger(event, payload) {
      for (const handler of listeners.get(event) || []) handler(payload)
      const handlers = onceListeners.get(event) || []
      onceListeners.delete(event)
      for (const handler of handlers) handler(payload)
    },
  }
  state.sockets.push(socket)
  state.latest = socket
  return socket
}
export function io(url, options) {
  return makeSocket(url, options)
}
export default { io }
`,
    })
  })
}

export async function mockTerminalWebSocket(page: Page) {
  await page.addInitScript(() => {
    const state = (window as any).__PW_TERMINAL_WS__ = {
      sockets: [] as any[],
      sent: [] as any[],
      createdCount: 0,
      latest: null as any,
    }
    const RealEvent = window.Event
    const RealMessageEvent = window.MessageEvent

    class MockTerminalWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSING = 2
      readonly CLOSED = 3
      binaryType: BinaryType = 'blob'
      bufferedAmount = 0
      extensions = ''
      protocol = ''
      readyState = MockTerminalWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null

      constructor(readonly url: string | URL) {
        super()
        state.sockets.push(this)
        state.latest = this
        setTimeout(() => {
          this.readyState = MockTerminalWebSocket.OPEN
          const openEvent = new RealEvent('open')
          this.onopen?.(openEvent)
          this.dispatchEvent(openEvent)
          this.__createSession('term-1', 'zsh', 101)
        }, 0)
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        const normalized = typeof data === 'string' ? data : String(data)
        state.sent.push({ socket: this.url.toString(), data: normalized })
        if (normalized.charCodeAt(0) !== 0x7B) return
        try {
          const message = JSON.parse(normalized)
          if (message.type === 'create') {
            this.__createSession(`term-${state.createdCount + 1}`, 'bash', 200 + state.createdCount)
          }
          if (message.type === 'switch') {
            this.__emitMessage(JSON.stringify({ type: 'switched', id: message.sessionId }))
          }
        } catch {}
      }

      close() {
        this.readyState = MockTerminalWebSocket.CLOSED
      }

      __createSession(id: string, shell: string, pid: number) {
        state.createdCount += 1
        this.__emitMessage(JSON.stringify({ type: 'created', id, shell, pid }))
      }

      __emitMessage(data: string) {
        const event = new RealMessageEvent('message', { data })
        this.onmessage?.(event)
        this.dispatchEvent(event)
      }
    }

    ;(window as any).WebSocket = MockTerminalWebSocket
  })
}
