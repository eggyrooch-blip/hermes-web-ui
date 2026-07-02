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

test('persists the selected expert avatar across session switching and reloads', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const resumes = {
    'session-expert': resumePayload('session-expert', 'Expert session seed'),
    'session-other': resumePayload('session-other', 'Other session seed'),
  }
  await page.addInitScript((payload) => {
    window.localStorage.setItem('hermes_active_session_research', 'session-expert')
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = payload
  }, resumes)
  const sessions = [
    sessionSummary('session-expert', 'Expert seeded chat', 200),
    sessionSummary('session-other', 'Other seeded chat', 100),
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
      },
    ],
  })
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat?surface=expert')
  await page.locator('.expert-card', { hasText: '资源投放专家' }).click()
  await page.locator('.action-primary').click()
  await page.goto('/#/hermes/chat')
  await expect(page.locator('.expert-slot-button img')).toHaveAttribute('src', expertAvatar)

  await sendChatMessage(page, '启动资源投放')
  const run = await waitForRun(page)

  expect(run.expert_id).toBe('keep-resource-delivery')
  expect(run.expert_label).toBe('资源投放专家')
  expect(run.expert_avatar).toBe(expertAvatar)
  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-expert-avatar' })
  }, run.session_id)

  await expect(page.locator('.thinking-avatar')).toHaveAttribute('src', expertAvatar)
  await expect(page.locator('.session-item.active .session-item-agent-logo')).toHaveAttribute('src', expertAvatar)
  await page.locator('.session-item', { hasText: 'Other seeded chat' }).click()
  await expect(page.locator('.session-item', { hasText: 'Expert seeded chat' }).locator('.session-item-agent-logo')).toHaveAttribute('src', expertAvatar)
  sessions[0] = sessionSummary('session-expert', 'Expert seeded chat', 250, {
    expert_id: 'keep-resource-delivery',
    expert_label: '资源投放专家',
    expert_avatar: expertAvatar,
  })
  await page.reload()
  await expect(page.locator('.session-item', { hasText: 'Expert seeded chat' }).locator('.session-item-agent-logo')).toHaveAttribute('src', expertAvatar)
  const artifactDir = process.env.FTASK_ARTIFACT_DIR || 'test-results'
  await page.screenshot({
    path: path.join(artifactDir, 'expert-chat-avatar-thinking.png'),
    fullPage: true,
  })
  expect(api.unexpectedRequests).toEqual([])
})
