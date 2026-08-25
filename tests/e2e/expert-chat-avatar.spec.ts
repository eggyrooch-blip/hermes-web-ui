import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const inputPlaceholder = 'Type a message... (Enter to send, Shift+Enter for new line)'
const expertAvatar = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
  <rect width="40" height="40" rx="8" fill="#0f766e"/>
  <text x="20" y="25" text-anchor="middle" font-size="18" font-family="Arial" fill="white">资</text>
</svg>
`)}`

function sessionSummary(id: string, title: string, lastActive: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    profile: 'research',
    source: 'cli',
    model: 'test-model',
    provider: 'test-provider',
    title,
    preview: title,
    started_at: lastActive - 10,
    ended_at: null,
    last_active: lastActive,
    message_count: 1,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: null,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: 'estimated',
    ...extra,
  }
}

function resumePayload(sessionId: string, content: string) {
  return {
    session_id: sessionId,
    messages: [{
      id: 1,
      session_id: sessionId,
      role: 'user',
      content,
      timestamp: Date.now() / 1000,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      token_count: null,
      finish_reason: null,
      reasoning: null,
    }],
    isWorking: false,
    events: [],
  }
}

async function sendChatMessage(page: Page, message: string) {
  const input = page.getByPlaceholder(inputPlaceholder)
  await expect(input).toBeVisible()
  await input.fill(message)
  await page.getByRole('button', { name: 'Send' }).click()
}

async function waitForRun(page: Page) {
  const handle = await page.waitForFunction(() => {
    const state = (window as any).__PW_CHAT_SOCKET__
    const run = state?.emitted?.find((item: any) => item.event === 'run')
    return run ? run.payload : null
  })
  return handle.jsonValue() as Promise<any>
}

test('opens a separate fixed digital-employee session and restores it from history', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const resumes = {
    'session-expert': resumePayload('session-expert', 'Expert session seed'),
    'session-other': resumePayload('session-other', 'Other session seed'),
  }
  await page.addInitScript((payload) => {
    window.localStorage.setItem('hermes_active_session_research', 'session-other')
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = payload
  }, resumes)
  const sessions = [
    sessionSummary('session-other', 'Other seeded chat', 200),
    sessionSummary('session-expert', 'Existing chat', 100),
  ]
  const api = await mockHermesApi(page, {
    sessions,
    experts: [
      {
        id: 'keep-resource-delivery',
        name: '资源投放专家',
        title: '资源投放专家',
        avatar: expertAvatar,
        featured: true,
        source: 'aihub',
        skills: ['Campaign planning', 'Delivery review'],
      },
    ],
  })
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat?surface=expert')
  await page.locator('.expert-card', { hasText: '资源投放专家' }).click()
  await page.locator('.action-primary').click()
  await expect(page).toHaveURL(/#\/hermes\/session\/[^?]+/)
  const newSessionId = decodeURIComponent(new URL(page.url()).hash.match(/\/hermes\/session\/([^?]+)/)?.[1] || '')
  expect(newSessionId).not.toBe('session-other')
  expect(newSessionId).not.toBe('session-expert')
  await expect(page.locator('.expert-session-identity')).toContainText('资源投放专家')
  await expect(page.locator('.expert-session-identity')).toContainText('This session is fixed to this digital employee')
  await expect(page.locator('.expert-session-avatar')).toHaveAttribute('src', expertAvatar)
  await expect(page.locator('.expert-session-capabilities')).toHaveText('Capabilities')
  await expect(page.locator('.expert-slot-button')).toBeDisabled()
  await expect(page.locator('.session-item', { hasText: 'Other seeded chat' })).toBeVisible()
  await expect(page.locator('.session-item', { hasText: 'Other seeded chat' }).locator('.session-item-agent-logo')).not.toHaveAttribute('src', expertAvatar)

  await sendChatMessage(page, '启动资源投放')
  const run = await waitForRun(page)

  expect(run.session_id).toBe(newSessionId)
  expect(run.expert_id).toBe('keep-resource-delivery')
  expect(run.expert_label).toBe('资源投放专家')
  expect(run.expert_avatar).toBe(expertAvatar)
  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-expert-avatar' })
  }, run.session_id)

  await expect(page.locator('.thinking-avatar')).toHaveAttribute('src', expertAvatar)
  await expect(page.locator('.session-item.active .session-item-agent-logo')).toHaveAttribute('src', expertAvatar)

  sessions.unshift(sessionSummary(newSessionId, 'Expert work session', 250, {
    expert_id: 'keep-resource-delivery',
    expert_label: '资源投放专家',
    expert_avatar: expertAvatar,
  }))
  const restoredResumes = {
    ...resumes,
    [newSessionId]: resumePayload(newSessionId, '启动资源投放'),
  }
  await page.addInitScript(({ sessionId, payload }) => {
    window.localStorage.setItem('hermes_active_session_research', sessionId)
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = payload
  }, { sessionId: newSessionId, payload: restoredResumes })
  await page.reload()
  await expect(page.locator('.expert-session-identity')).toContainText('资源投放专家')
  await expect(page.locator('.session-item', { hasText: 'Expert work session' }).locator('.session-item-agent-logo')).toHaveAttribute('src', expertAvatar)
  await expect(page.locator('.session-item', { hasText: 'Other seeded chat' }).locator('.session-item-agent-logo')).not.toHaveAttribute('src', expertAvatar)

  const artifactDir = process.env.FTASK_ARTIFACT_DIR || 'test-results'
  await page.screenshot({
    path: path.join(artifactDir, 'expert-session-entry-desktop.png'),
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('.expert-session-identity')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: path.join(artifactDir, 'expert-session-entry-mobile.png'), fullPage: true })

  await page.locator('.expert-session-capabilities').click()
  await expect(page).toHaveURL(/surface=expert/)
  expect(api.unexpectedRequests).toEqual([])
})

test('schedules a bound digital employee once and keeps cancel write-free on desktop and mobile', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const expertSession = sessionSummary('session-expert', '资源投放工作', 200, {
    expert_id: 'keep-resource-delivery',
    expert_label: '资源投放专家',
    expert_avatar: expertAvatar,
  })
  await page.addInitScript((payload) => {
    window.localStorage.setItem('hermes_active_session_research', 'session-expert')
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = payload
  }, { 'session-expert': resumePayload('session-expert', 'Expert session seed') })
  const api = await mockHermesApi(page, {
    sessions: [expertSession],
    experts: [{
      id: 'keep-resource-delivery',
      name: '资源投放专家',
      title: '资源投放专家',
      avatar: expertAvatar,
      skills: ['Campaign planning'],
    }],
  })
  await mockChatSocket(page)

  await page.goto('/#/hermes/session/session-expert')
  const composer = page.getByPlaceholder(inputPlaceholder)
  await composer.fill('每天检查投放队列')
  await page.getByRole('button', { name: 'Schedule' }).click()
  await expect(page.getByText('Create Automation')).toBeVisible()
  await expect(page.getByPlaceholder('Automation name')).toHaveValue('资源投放工作')
  await expect(page.getByPlaceholder('The prompt to execute')).toHaveValue('每天检查投放队列')

  const artifactDir = process.env.FTASK_ARTIFACT_DIR || 'test-results'
  await page.screenshot({ path: path.join(artifactDir, 'scheduled-expert-desktop.png'), fullPage: true })
  await page.getByRole('button', { name: 'Cancel' }).click()
  expect(api.requests.filter(request => request.method === 'POST' && request.pathname === '/api/hermes/jobs')).toHaveLength(0)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Schedule' }).click()
  await page.getByPlaceholder('e.g. 0 9 * * *').fill('0 9 * * *')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: path.join(artifactDir, 'scheduled-expert-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: 'Create' }).click()

  await expect.poll(() => api.requests.filter(request => request.method === 'POST' && request.pathname === '/api/hermes/jobs').length).toBe(1)
  const request = api.requests.find(item => item.method === 'POST' && item.pathname === '/api/hermes/jobs')!
  const body = JSON.parse(request.postData || '{}')
  expect(body).toMatchObject({
    name: '资源投放工作',
    schedule: '0 9 * * *',
    prompt: '每天检查投放队列',
    deliver: 'feishu',
    expert_id: 'keep-resource-delivery',
    source_session_id: 'session-expert',
  })
  expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/)
  expect(body.owner_open_id).toBeUndefined()
  expect(body.owner_profile).toBeUndefined()
  expect(body.source_app).toBeUndefined()
  expect(api.unexpectedRequests).toEqual([])
})

test('shows a compact digital employee work record on desktop and mobile', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, {
    experts: [{ id: 'keep-resource-delivery', name: '资源投放专家', title: '资源投放专家', avatar: expertAvatar }],
    expertWorkRecords: {
      user: {
        expert_id: 'keep-resource-delivery', mode: 'user', window_days: 30,
        partitions: {
          sessions: { status: 'available', items: [{ id: 'session-a', title: '八月资源投放复盘', last_active: 1, status: 'completed' }] },
          jobs: { status: 'unavailable', items: [] },
          feedback: { status: 'available', items: [{ session_id: 'session-a', run_id: 'run-a', rating: 'up', reason: null, updated_at: 1 }] },
        },
      },
    },
  })

  await page.goto('/#/hermes/chat?surface=expert')
  await page.locator('.expert-card', { hasText: '资源投放专家' }).click()
  await expect(page.getByText('My work record')).toBeVisible()
  await expect(page.getByText('八月资源投放复盘')).toBeVisible()
  await expect(page.getByText('Temporarily unavailable')).toBeVisible()
  const artifactDir = process.env.FTASK_ARTIFACT_DIR || 'test-results'
  await page.locator('.n-drawer').screenshot({ path: path.join(artifactDir, 'expert-work-record-desktop.png') })

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('[data-work-record]')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.locator('.n-drawer').screenshot({ path: path.join(artifactDir, 'expert-work-record-mobile.png') })
  expect(api.unexpectedRequests).toEqual([])
})
