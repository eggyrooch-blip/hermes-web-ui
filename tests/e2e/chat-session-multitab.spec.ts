import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const inputPlaceholder = 'Type a message... (Enter to send, Shift+Enter for new line)'

type SessionSeed = {
  id: string
  title: string
  lastActive: number
}

function sessionSummary({ id, title, lastActive }: SessionSeed) {
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
  }
}

function resumePayload(sessionId: string, content: string) {
  return {
    session_id: sessionId,
    messages: [
      {
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
      },
    ],
    isWorking: false,
    events: [],
  }
}

const sessions = [
  sessionSummary({ id: 'session-a', title: 'Alpha chat', lastActive: 100 }),
  sessionSummary({ id: 'session-b', title: 'Beta chat', lastActive: 200 }),
]

const resumes = {
  'session-a': resumePayload('session-a', 'Alpha route content'),
  'session-b': resumePayload('session-b', 'Beta route content'),
}

async function setupChatPage(page: Page, resumeFixtures: Record<string, unknown> = resumes) {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript((payload) => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = payload
    window.localStorage.setItem('hermes_active_session_research', 'session-b')
  }, resumeFixtures)
  const api = await mockHermesApi(page, { sessions })
  await mockChatSocket(page)
  return api
}

async function sendChatMessage(page: Page, message: string) {
  const input = page.getByPlaceholder(inputPlaceholder)
  await expect(input).toBeVisible()
  await input.fill(message)
  await page.getByRole('button', { name: 'Send' }).click()
}

async function waitForRun(page: Page, index = 0) {
  const handle = await page.waitForFunction((runIndex) => {
    const state = (window as any).__PW_CHAT_SOCKET__
    const runs = state?.emitted?.filter((item: any) => item.event === 'run') || []
    const run = runs[runIndex]
    return run ? run.payload : null
  }, index)
  return handle.jsonValue() as Promise<any>
}

test('route session id wins over shared active-session localStorage', async ({ page }) => {
  const api = await setupChatPage(page)

  await page.goto('/#/hermes/session/session-a')

  await expect(page.getByText('Alpha route content')).toBeVisible()
  await expect(page.getByText('Beta route content')).toHaveCount(0)
  await expect(page).toHaveURL(/#\/hermes\/session\/session-a$/)
  expect(api.unexpectedRequests).toEqual([])
})

test('two tabs can show different sessions and keep them after reload', async ({ context }) => {
  const pageA = await context.newPage()
  const pageB = await context.newPage()
  const apiA = await setupChatPage(pageA)
  const apiB = await setupChatPage(pageB)

  await pageA.goto('/#/hermes/session/session-a')
  await pageB.goto('/#/hermes/session/session-b')

  await expect(pageA.getByText('Alpha route content')).toBeVisible()
  await expect(pageB.getByText('Beta route content')).toBeVisible()

  await pageA.reload()
  await pageB.reload()

  await expect(pageA.getByText('Alpha route content')).toBeVisible()
  await expect(pageB.getByText('Beta route content')).toBeVisible()
  await expect(pageA).toHaveURL(/#\/hermes\/session\/session-a$/)
  await expect(pageB).toHaveURL(/#\/hermes\/session\/session-b$/)
  expect(apiA.unexpectedRequests).toEqual([])
  expect(apiB.unexpectedRequests).toEqual([])
})

test('parallel tabs send runs and render progress only for their own session', async ({ context }) => {
  const pageA = await context.newPage()
  const pageB = await context.newPage()
  const apiA = await setupChatPage(pageA)
  const apiB = await setupChatPage(pageB)

  await pageA.goto('/#/hermes/session/session-a')
  await pageB.goto('/#/hermes/session/session-b')
  await expect(pageA.getByText('Alpha route content')).toBeVisible()
  await expect(pageB.getByText('Beta route content')).toBeVisible()

  await sendChatMessage(pageA, 'Question for Alpha')
  await sendChatMessage(pageB, 'Question for Beta')

  const runA = await waitForRun(pageA)
  const runB = await waitForRun(pageB)
  expect(runA.session_id).toBe('session-a')
  expect(runB.session_id).toBe('session-b')

  await pageA.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-a' })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'run-a', delta: 'Alpha progress' })
  }, runA.session_id)
  await pageB.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-b' })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'run-b', delta: 'Beta progress' })
  }, runB.session_id)

  await expect(pageA.getByText('Alpha progress')).toBeVisible()
  await expect(pageA.getByText('Beta progress')).toHaveCount(0)
  await expect(pageB.getByText('Beta progress')).toBeVisible()
  await expect(pageB.getByText('Alpha progress')).toHaveCount(0)
  expect(apiA.unexpectedRequests).toEqual([])
  expect(apiB.unexpectedRequests).toEqual([])
})

test('rapid same-page A to B to A keeps only the newest A resume', async ({ page }) => {
  const api = await setupChatPage(page, {
    'session-a': [
      { delay_ms: 120, payload: resumePayload('session-a', 'Stale Alpha response') },
      { delay_ms: 10, payload: resumePayload('session-a', 'Fresh Alpha response') },
    ],
    'session-b': [
      { delay_ms: 60, payload: resumePayload('session-b', 'Stale Beta response') },
    ],
  })

  await page.goto('/#/hermes/session/session-a')
  const alphaItem = page.locator('.session-item').filter({ hasText: 'Alpha chat' })
  const betaItem = page.locator('.session-item').filter({ hasText: 'Beta chat' })
  await expect(alphaItem).toBeVisible()
  await expect(betaItem).toBeVisible()

  await betaItem.click()
  await alphaItem.click()

  await expect(page.getByText('Fresh Alpha response')).toBeVisible()
  await page.waitForTimeout(180)
  await expect(page.getByText('Stale Alpha response')).toHaveCount(0)
  await expect(page.getByText('Stale Beta response')).toHaveCount(0)
  await expect(page).toHaveURL(/#\/hermes\/session\/session-a(?:\?profile=research)?$/)
  expect(api.unexpectedRequests).toEqual([])
})

test('delayed message growth follows bottom until the user scrolls up', async ({ page }) => {
  const seededMessages = Array.from({ length: 40 }, (_, index) => ({
    id: index + 1,
    session_id: 'session-a',
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Seed message ${index + 1}: ${'content '.repeat(12)}`,
    timestamp: (Date.now() + index) / 1000,
    tool_call_id: null,
    tool_calls: null,
    tool_name: null,
    token_count: null,
    finish_reason: 'stop',
    reasoning: null,
  }))
  const api = await setupChatPage(page, {
    ...resumes,
    'session-a': {
      ...resumePayload('session-a', ''),
      messages: seededMessages,
    },
  })

  await page.goto('/#/hermes/session/session-a')
  await expect(page.getByText('Seed message 40:', { exact: false })).toBeVisible()
  const scroller = page.locator('.virtual-message-list')
  await scroller.evaluate(element => element.scrollTo({ top: element.scrollHeight }))

  await sendChatMessage(page, 'Grow the answer')
  const run = await waitForRun(page)
  await page.evaluate(({ sid, text }) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-growth' })
    socket.__trigger('message.delta', {
      event: 'message.delta',
      session_id: sid,
      run_id: 'run-growth',
      delta: text,
    })
  }, {
    sid: run.session_id,
    text: Array.from({ length: 80 }, (_, index) => `Growing line ${index + 1}`).join('\n\n'),
  })

  await expect.poll(() => scroller.evaluate(
    element => element.scrollHeight - element.clientHeight - element.scrollTop,
  )).toBeLessThanOrEqual(4)

  await scroller.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollTop - 320)
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }))
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await page.evaluate(({ sid, text }) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('message.delta', {
      event: 'message.delta',
      session_id: sid,
      run_id: 'run-growth',
      delta: text,
    })
  }, {
    sid: run.session_id,
    text: Array.from({ length: 80 }, (_, index) => `Detached line ${index + 1}`).join('\n\n'),
  })
  await page.waitForTimeout(250)

  expect(await scroller.evaluate(
    element => element.scrollHeight - element.clientHeight - element.scrollTop,
  )).toBeGreaterThan(64)
  expect(api.unexpectedRequests).toEqual([])
})
