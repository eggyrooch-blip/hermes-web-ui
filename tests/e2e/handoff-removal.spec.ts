// Regression guard for the human-handoff removal (webui-revert-human-handoff).
// 9da45ef2 shipped a Human follow-ups inbox; sunke had it reverted whole. These
// assertions are the only thing standing between a stray re-merge and the entry
// silently coming back — the feature's own e2e went away with the revert.
import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const inputPlaceholder = 'Type a message... (Enter to send, Shift+Enter for new line)'

async function openChat(page: import('@playwright/test').Page) {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  return api
}

test('sidebar no longer exposes the human follow-ups inbox', async ({ page }) => {
  await openChat(page)

  const nav = page.locator('.page-sidebar-nav')
  await expect(nav).toBeVisible()
  await expect(page.getByRole('button', { name: 'Human follow-ups' })).toHaveCount(0)
  await expect(nav.locator('.page-sidebar-handoff')).toHaveCount(0)

  // Neighbouring navigation must survive the removal.
  await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Expert' })).toBeVisible()
})

test('the handoff route no longer resolves', async ({ page }) => {
  const routerWarnings: string[] = []
  page.on('console', message => {
    if (message.text().includes('No match found for location')) routerWarnings.push(message.text())
  })

  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.goto('/#/hermes/handoffs')
  await page.waitForLoadState('networkidle')

  // The load-bearing assertion: the route must not RESOLVE. Checking only that
  // handoff selectors are absent would still pass if /hermes/handoffs were
  // accidentally registered to some other component.
  const matched = await page.evaluate(() => {
    const app = (document.querySelector('#app') as any)?.__vue_app__
    const router = app?.config?.globalProperties?.$router
    if (!router) return -1
    return router.resolve('/hermes/handoffs').matched.length
  })
  expect(matched, 'router must be reachable and /hermes/handoffs must match nothing').toBe(0)
  expect(routerWarnings.join(' ')).toContain('/hermes/handoffs')

  await expect(page.locator('.page-sidebar-handoff')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Human follow-ups' })).toHaveCount(0)
})

test('down/unresolved feedback offers no human follow-up request', async ({ page }) => {
  await openChat(page)

  const input = page.getByPlaceholder(inputPlaceholder)
  await expect(input).toBeVisible()
  await input.fill('I still need help with this result')
  await page.getByRole('button', { name: 'Send' }).click()

  const handle = await page.waitForFunction(() => {
    const state = (window as any).__PW_CHAT_SOCKET__
    const run = state?.emitted?.find((item: any) => item.event === 'run')
    return run ? run.payload : null
  })
  const run = await handle.jsonValue() as { session_id: string }

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-removal' })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'run-removal', delta: 'Initial expert answer.' })
    socket.__trigger('run.completed', { event: 'run.completed', session_id: sid, run_id: 'run-removal', output: 'Initial expert answer.' })
  }, run.session_id)

  await page.locator('[data-feedback-rating="down"]').click()
  await page.getByRole('button', { name: 'Did not solve it' }).click()

  // The feedback control still works; only its handoff branch is gone.
  await expect(page.locator('[data-feedback-rating="down"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-handoff-request]')).toHaveCount(0)
  await expect(page.locator('[data-handoff-status]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Request human follow-up' })).toHaveCount(0)
})
