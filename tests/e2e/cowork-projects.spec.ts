import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const projects = [
  {
    id: 'project-a', name: 'Alpha', description: 'Quarterly work', instructions: 'Use concise tables.',
    icon: 'A', color: '#5b67f1', primary_folder: 'reports/alpha', status: 'active', created_at: 1, updated_at: 1,
  },
  {
    id: 'project-b', name: 'Beta', description: '', instructions: '',
    icon: '', color: '', primary_folder: null, status: 'active', created_at: 1, updated_at: 1,
  },
]

async function sendChatMessage(page: Page, message: string) {
  await page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)').fill(message)
  await page.getByRole('button', { name: 'Send' }).click()
}

async function waitForRun(page: Page) {
  const handle = await page.waitForFunction(() => {
    const runs = (window as any).__PW_CHAT_SOCKET__?.emitted?.filter((item: any) => item.event === 'run') || []
    return runs[0]?.payload || null
  })
  return handle.jsonValue() as Promise<Record<string, any>>
}

test('manages native Projects and starts a Project session in the existing Chat UI', async ({ page }, testInfo) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await mockChatSocket(page)
  const mutations: Array<{ method: string; body: Record<string, unknown> }> = []
  let projectReads = 0

  await page.route('**/api/hermes/cowork/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname === '/api/hermes/cowork/projects' && request.method() === 'GET') return json({ items: projects })
    if (url.pathname === '/api/hermes/cowork/projects/project-a' && request.method() === 'GET') {
      projectReads += 1
      return json({ project: projects[0] })
    }
    if (url.pathname === '/api/hermes/cowork/projects/project-a/sessions' && request.method() === 'GET') {
      return json({ items: [{ session_id: 'session-alpha', created_at: 20 }] })
    }
    if (url.pathname === '/api/hermes/cowork/projects/project-a' && request.method() === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>
      mutations.push({ method: 'PATCH', body })
      return json({ project: { ...projects[0], ...body } })
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
  })
  await page.route('**/api/hermes/sessions/hermes/session-alpha**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      session: {
        id: 'session-alpha', title: 'Prepare Alpha brief', profile: 'research', source: 'cli', model: 'test-model',
        started_at: 10, ended_at: null, message_count: 2, tool_call_count: 0, input_tokens: 0, output_tokens: 0,
        cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, billing_provider: null,
        estimated_cost_usd: 0, actual_cost_usd: null, cost_status: 'ok',
        messages: [{
          id: 1, session_id: 'session-alpha', role: 'assistant', content: 'Done\nMEDIA:/tmp/workspace/reports/alpha-brief.md',
          tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 15, token_count: null,
          finish_reason: 'stop', reasoning: null,
        }],
      },
    }),
  }))

  await page.goto('/#/hermes/projects/project-a')
  await expect(page.getByRole('heading', { name: 'Alpha' })).toBeVisible()
  await expect(page.locator('label').filter({ hasText: 'Project folder' }).locator('input')).toHaveValue('reports/alpha')
  await expect(page.locator('.project-task')).toContainText('Prepare Alpha brief')
  await expect(page.locator('.project-artifact')).toContainText('alpha-brief.md')
  await page.locator('label').filter({ hasText: 'Description' }).locator('textarea').fill('Updated work')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect.poll(() => mutations.length).toBe(1)
  expect(mutations[0]).toMatchObject({ method: 'PATCH', body: { description: 'Updated work', primary_folder: 'reports/alpha' } })

  await page.getByRole('button', { name: 'New task' }).click()
  await expect(page).toHaveURL(/#\/hermes\/session\/.+/)

  const picker = page.locator('[data-cowork-project-picker]')
  expect(projectReads).toBe(1)
  await expect(picker).toHaveAttribute('data-selected-project-id', 'project-a')
  await expect(page.getByText('Fixed for this task')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Cowork' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /workspace/i })).toHaveCount(0)
  await expect(page.locator('.workspace-groups, .workspace-badge')).toHaveCount(0)

  await sendChatMessage(page, 'Prepare the Alpha brief')
  const run = await waitForRun(page)
  expect(run).toMatchObject({ project_id: 'project-a', session_id: expect.any(String) })
  await page.evaluate((sessionId) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sessionId, run_id: 'run-project-a' })
    socket.__trigger('project.bound', {
      event: 'project.bound',
      session_id: sessionId,
      run_id: 'run-project-a',
      receipt: { project_id: 'project-a', project_name: 'Alpha', workspace: 'reports/alpha' },
    })
    socket.__trigger('run.completed', {
      event: 'run.completed', session_id: sessionId, run_id: 'run-project-a', output: 'Alpha brief ready.',
    })
  }, run.session_id)
  await expect(page.getByText('Fixed for this task')).toBeVisible()

  await page.getByRole('button', { name: 'Project · Alpha' }).click()
  await expect(page.locator('.cowork-context')).toContainText('Quarterly work')
  await expect(page.locator('.cowork-context')).toContainText('Use concise tables.')
  await page.getByRole('option', { name: 'Beta' }).click()
  await expect(page).not.toHaveURL(new RegExp(`#\/hermes\/session\/${run.session_id}(?:\\?|$)`))
  await expect(picker).toHaveAttribute('data-selected-project-id', 'project-b')
  await expect(page.getByText('Fixed for this task')).toHaveCount(0)

  await page.locator('.session-item.active').click({ button: 'right' })
  await page.getByText('Rename', { exact: true }).click()
  const renameDialog = page.getByRole('dialog')
  await expect(renameDialog).toContainText('Rename Session')
  await expect(renameDialog.getByPlaceholder('Enter new title')).toBeVisible()
  await page.keyboard.press('Escape')

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/chat-native-project-desktop.png' })
  await testInfo.attach('chat-project-desktop', { body: await page.screenshot(), contentType: 'image/png' })

  await page.goto('/#/hermes/cowork')
  await expect(page).toHaveURL(/#\/hermes\/chat$/)
  await expect(page.locator('[data-cowork-project-picker]')).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(page.locator('[data-cowork-project-picker]')).toBeVisible()
  await expect(page.locator('.session-backdrop.active')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/chat-native-project-mobile.png' })
  await testInfo.attach('chat-project-mobile', { body: await page.screenshot(), contentType: 'image/png' })
})
