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

test('uses the selected expert avatar for the live Hermes thinking indicator', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, {
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

  await page.goto('/#/hermes/chat')

  await page.locator('.expert-slot-button').click()
  await page.mouse.move(10, 10)
  await expect(page.getByText('Active expert: No expert')).toHaveCount(0)
  await page.locator('.n-base-select-option', { hasText: '资源投放专家' }).click()
  await expect(page.locator('.expert-slot-button img')).toHaveAttribute('src', expertAvatar)

  await sendChatMessage(page, '启动资源投放')
  const run = await waitForRun(page)

  expect(run.expert_id).toBe('keep-resource-delivery')
  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-expert-avatar' })
  }, run.session_id)

  await expect(page.locator('.thinking-avatar')).toHaveAttribute('src', expertAvatar)
  await expect(page.locator('.session-item.active .session-item-agent-logo')).toHaveAttribute('src', expertAvatar)
  const artifactDir = process.env.FTASK_ARTIFACT_DIR || 'test-results'
  await page.screenshot({
    path: path.join(artifactDir, 'expert-chat-avatar-thinking.png'),
    fullPage: true,
  })
  expect(api.unexpectedRequests).toEqual([])
})
