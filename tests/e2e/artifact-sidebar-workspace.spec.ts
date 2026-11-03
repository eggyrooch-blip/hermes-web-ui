import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const ORDINARY_ADMIN_ACCESS_KEY = 'eyJhbGciOiJub25lIn0.eyJyb2xlIjoiYWRtaW4iLCJ1c2VybmFtZSI6InBsYXl3cmlnaHQifQ.signature'

type SessionSeed = {
  id: string
  title: string
  lastActive: number
  artifacts: string[]
}

const sessions: SessionSeed[] = [
  { id: 'session-a', title: 'Alpha chat', lastActive: 100, artifacts: ['a.txt', 'SPEC.md'] },
  { id: 'session-b', title: 'Beta chat', lastActive: 200, artifacts: ['SPEC.md'] },
  { id: 'session-empty', title: 'Empty chat', lastActive: 50, artifacts: [] },
]

const fileContents: Record<string, string> = {
  'a.txt': 'Alpha artifact body',
  'SPEC.md': '# Beta specification\n\nBeta artifact body',
  'notes.txt': 'Notes selected from the workspace browser',
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

function resumePayload({ id, artifacts }: SessionSeed) {
  return {
    session_id: id,
    messages: [
      {
        id: 1,
        session_id: id,
        role: 'assistant',
        content: artifacts.length
          ? `Artifact ready.\n\n${artifacts.map(artifact => `MEDIA:/workspace/${artifact}`).join('\n')}`
          : 'No artifacts produced.',
        timestamp: Date.now() / 1000,
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        token_count: null,
        finish_reason: 'stop',
        reasoning: null,
      },
    ],
    isWorking: false,
    events: [],
  }
}

async function setupArtifactPage(page: Page, accessKey = TEST_ACCESS_KEY) {
  await authenticate(page, accessKey, 'research')
  await page.addInitScript((payload) => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = payload
  }, Object.fromEntries(sessions.map(session => [session.id, resumePayload(session)])))

  const api = await mockHermesApi(page, { sessions: sessions.map(sessionSummary) })

  // Register these after mockHermesApi so Playwright's newest route wins while
  // every unrelated API request remains visible to the shared request audit.
  await page.route('**/api/hermes/files/read?*', async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') || ''
    const content = fileContents[path]
    await route.fulfill({
      status: content === undefined ? 404 : 200,
      contentType: 'application/json',
      body: JSON.stringify(content === undefined
        ? { error: `Unknown test file: ${path}` }
        : { content, path, size: content.length }),
    })
  })
  await page.route('**/api/hermes/files/list*', async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') || ''
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        path,
        entries: path ? [] : Object.entries(fileContents).map(([name, content]) => ({
          name,
          path: name,
          isDir: false,
          size: content.length,
          modTime: '2026-07-11T08:00:00.000Z',
        })),
      }),
    })
  })

  await mockChatSocket(page)
  return api
}

function artifactCard(page: Page, name: string) {
  return page.locator('.markdown-file-card').filter({ hasText: name })
}

function sessionLink(page: Page, title: string) {
  return page.locator('.session-item').filter({ hasText: title })
}

async function openArtifact(page: Page, name: string, body: string) {
  await expect(artifactCard(page, name)).toBeVisible()
  await artifactCard(page, name).click()
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: `Close ${name}`, exact: true })).toBeVisible()
  await expect(page.getByText(body, { exact: true })).toBeVisible()
}

async function toggleArtifactPanel(page: Page) {
  await page.locator('.header-tool-toggle').click()
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(name), animations: 'disabled' })
}

async function gotoSession(page: Page, sessionId: string) {
  await page.goto(`/#/hermes/session/${sessionId}`)
  // The first Vite run compiles ChatView's large lazy chunk. Wait for the
  // route content contract instead of racing the first artifact assertion.
  await expect(page.locator('.chat-panel')).toBeVisible({ timeout: 15_000 })
}

test('restores the selected artifact independently for each session and after collapse', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const api = await setupArtifactPage(page)
  await gotoSession(page, 'session-a')

  await openArtifact(page, 'a.txt', fileContents['a.txt'])
  await toggleArtifactPanel(page)
  await expect(page.locator('.chat-tool-panel')).toBeHidden()
  await toggleArtifactPanel(page)
  await expect(page.getByRole('tab', { name: 'a.txt', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText(fileContents['a.txt'], { exact: true })).toBeVisible()

  await sessionLink(page, 'Beta chat').click()
  await expect(page).toHaveURL(/#\/hermes\/session\/session-b\?profile=research$/)
  await openArtifact(page, 'SPEC.md', 'Beta specification')

  await sessionLink(page, 'Alpha chat').click()
  await expect(page).toHaveURL(/#\/hermes\/session\/session-a\?profile=research$/)
  await expect(page.getByRole('tab', { name: 'a.txt', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: 'SPEC.md', exact: true })).toHaveCount(0)
  await expect(page.getByText(fileContents['a.txt'], { exact: true })).toBeVisible()

  await capture(page, testInfo, 'session-artifact-restored.png')
  expect(api.unexpectedRequests).toEqual([])
})

test('ordinary users can close and reopen an artifact panel without receiving admin tool controls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const api = await setupArtifactPage(page, ORDINARY_ADMIN_ACCESS_KEY)
  await gotoSession(page, 'session-a')

  await expect(page.locator('.header-tool-toggle')).toHaveCount(0)
  await openArtifact(page, 'a.txt', fileContents['a.txt'])

  const panel = page.locator('.chat-tool-panel')
  await page.getByRole('button', { name: 'Collapse', exact: true }).click()
  await expect(panel).toBeHidden()

  await artifactCard(page, 'a.txt').click()
  await expect(panel).toBeVisible()
  await expect(page.getByRole('tab', { name: 'a.txt', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText(fileContents['a.txt'], { exact: true })).toBeVisible()
  await expect(page.locator('.header-tool-toggle')).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('folder and plus open the secondary browser and previewing a file creates its tab', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const api = await setupArtifactPage(page)
  await gotoSession(page, 'session-a')
  await openArtifact(page, 'a.txt', fileContents['a.txt'])

  await page.getByRole('button', { name: 'Browse workspace' }).click()
  const notesRow = page.locator('.file-list-row').filter({ hasText: 'notes.txt' })
  await expect(notesRow).toBeVisible()
  await notesRow.dblclick()
  await expect(page.getByRole('tab', { name: 'notes.txt', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText(fileContents['notes.txt'], { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Open file' }).click()
  await expect(page.locator('.file-list-row').filter({ hasText: 'notes.txt' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'notes.txt', exact: true })).toHaveAttribute('aria-selected', 'false')

  await page.getByRole('tab', { name: 'notes.txt', exact: true }).click()
  await expect(page.getByText(fileContents['notes.txt'], { exact: true })).toBeVisible()
  await capture(page, testInfo, 'workspace-browser-preview-tab.png')
  expect(api.unexpectedRequests).toEqual([])
})

test('switches two artifact tabs and closes back to the overview', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const api = await setupArtifactPage(page)
  await gotoSession(page, 'session-a')

  await openArtifact(page, 'a.txt', fileContents['a.txt'])
  await openArtifact(page, 'SPEC.md', 'Beta specification')
  await page.getByRole('tab', { name: 'a.txt', exact: true }).click()
  await expect(page.getByText(fileContents['a.txt'], { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Close a.txt', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'a.txt', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'SPEC.md', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('Beta specification', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Close SPEC.md', exact: true }).click()
  await expect(page.getByRole('tablist', { name: 'Open artifacts' }).getByRole('tab')).toHaveCount(0)
  await expect(page.locator('.detail-overview')).toBeVisible()
  await expect(page.locator('.detail-open-files')).toBeVisible()
  await expect(page.locator('.detail-open-files')).toHaveAccessibleName('Browse workspace')
  await expect(page.locator('.file-list-row')).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('opens an empty session on the localized overview instead of the root file manager', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const api = await setupArtifactPage(page)
  await gotoSession(page, 'session-empty')
  await expect(page.getByText('No artifacts produced.', { exact: true })).toBeVisible()

  await toggleArtifactPanel(page)
  await expect(page.locator('.chat-tool-panel')).toBeVisible()
  await expect(page.locator('.detail-overview')).toBeVisible()
  await expect(page.getByText('No artifacts yet', { exact: true })).toBeVisible()
  await expect(page.locator('.detail-browse-workspace')).toBeVisible()
  await expect(page.locator('.detail-browse-workspace')).toHaveAccessibleName('Browse workspace')
  await expect(page.locator('.files-panel-drawer')).toHaveCount(0)
  await expect(page.locator('.file-list-row')).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('narrow artifact panel stays within the viewport and keeps its tab across collapse', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 720, height: 900 })
  const api = await setupArtifactPage(page)
  await gotoSession(page, 'session-a')
  await openArtifact(page, 'a.txt', fileContents['a.txt'])

  const panel = page.locator('.chat-tool-panel')
  const bounds = await panel.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(720)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900)

  await toggleArtifactPanel(page)
  await expect(panel).toBeHidden()
  await toggleArtifactPanel(page)
  await expect(page.getByRole('tab', { name: 'a.txt', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText(fileContents['a.txt'], { exact: true })).toBeVisible()

  await capture(page, testInfo, 'narrow-artifact-panel.png')
  expect(api.unexpectedRequests).toEqual([])
})
