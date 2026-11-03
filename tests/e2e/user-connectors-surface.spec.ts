import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test.describe.configure({ mode: 'serial' })

const USER_ACCESS_KEY = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJzdWIiOiIyIiwidXNlcm5hbWUiOiJlbXBsb3llZSIsInJvbGUiOiJhZG1pbiIsInR5cGUiOiJhY2Nlc3MiLCJhdWQiOiJoZXJtZXMtd2ViLXVpIiwiaWF0IjoxNzYwMDAwMDAwLCJleHAiOjQxMDI0NDQ4MDB9',
  'playwright-signature',
].join('.')

test('ordinary users see files in the app sidebar and no technical sidebar controls', async ({ page }) => {
  await authenticate(page, USER_ACCESS_KEY, 'research')
  await mockHermesApi(page)

  await page.goto('/#/hermes/settings')
  await expect(page).toHaveURL(/#\/hermes\/settings$/)

  const sidebar = page.locator('aside.sidebar')
  await expect(sidebar.getByRole('link', { name: /^Files$/ })).toBeVisible()
  await expect(sidebar.getByRole('link', { name: /^Expert$/ })).toHaveCount(0)
  await expect(sidebar.getByRole('link', { name: /^Automation$/ })).toHaveCount(0)
  await expect(sidebar.getByRole('link', { name: /^Skills$/ })).toHaveCount(0)
  await expect(sidebar.getByRole('link', { name: /^Connectors$/ })).toHaveCount(0)
  await expect(sidebar.getByRole('link', { name: /^Plugins$/ })).toHaveCount(0)
  await expect(sidebar.getByRole('link', { name: /^MCP$/ })).toHaveCount(0)
  await expect(page.locator('button[title="Comic style"]')).toHaveCount(0)
  await expect(page.locator('button[title="Dark mode"]')).toHaveCount(0)

  const logoLink = sidebar.locator('.sidebar-logo')
  await expect(logoLink).toBeVisible()
  await expect(logoLink).toContainText('Hermes')
  await expect(logoLink.locator('img')).toHaveAttribute('src', '/logo.png')
  await logoLink.click()
  await expect(page).toHaveURL(/#\/hermes\/chat$/)

  await page.goto('/#/hermes/settings')
  await expect(page).toHaveURL(/#\/hermes\/settings$/)

  await sidebar.getByRole('link', { name: /^Files$/ }).click()
  await expect(page).toHaveURL(/#\/hermes\/files$/)
  await expect(page.getByRole('button', { name: /^New File$/ })).toBeVisible()

  await page.goto('/#/hermes/plugins')
  await expect(page).toHaveURL(/#\/hermes\/connectors$/)
  // The connector catalog panel carries its own h3 "Connectors" heading, so
  // pin this to the page header instead of matching both.
  await expect(page.getByRole('heading', { name: 'Connectors', level: 2 })).toBeVisible()
  await expect(page.getByText('Lark CLI')).toBeVisible()

  await page.goto('/#/hermes/mcp')
  await expect(page).toHaveURL(/#\/hermes\/connectors$/)

  await page.goto('/#/hermes/global-agent')
  await expect(page).toHaveURL(/#\/hermes\/chat$/)
})

test('ordinary users create chats without the advanced agent and workspace drawer', async ({ page }) => {
  await authenticate(page, USER_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)

  await page.goto('/#/hermes/chat')
  await page
    .locator('.page-sidebar-nav .page-sidebar-tab')
    .filter({ hasText: 'New Chat' })
    .click()

  await expect(page).toHaveURL(/#\/hermes\/session\/[^?]+\?profile=research$/)
  await expect(page.locator('.new-chat-drawer')).toHaveCount(0)
  await expect(page.locator('.n-drawer-body-content-wrapper')).toHaveCount(0)
  await expect(page.getByText('You do not have permission')).toHaveCount(0)
  await expect(page.getByText('你没有权限访问该资源')).toHaveCount(0)
  expect(api.requests.some((request) => request.pathname === '/api/hermes/workspace/folders')).toBe(false)
  expect(api.unexpectedRequests).toEqual([])
})

test('ordinary users open expert and automation directly from the home sidebar', async ({ page }) => {
  await authenticate(page, USER_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)

  await page.goto('/#/hermes/chat')

  const pageSidebar = page.locator('.page-sidebar-nav')
  await expect(pageSidebar).toBeVisible()
  const homeLogoLink = pageSidebar.locator('.page-sidebar-logo')
  await expect(homeLogoLink).toBeVisible()
  await expect(homeLogoLink).toContainText('Hermes')
  await expect(homeLogoLink.locator('img')).toHaveAttribute('src', '/logo.png')
  await expect(homeLogoLink).toHaveAttribute('href', '/#/hermes/chat')
  await expect(pageSidebar.locator('.page-sidebar-tabs')).not.toHaveAttribute('role', 'tablist')

  const navLabels = await pageSidebar.evaluate(element =>
    Array.from(element.querySelectorAll('.page-sidebar-tabs > *')).map(node => ({
      className: node.className,
      text: node.textContent?.trim() || '',
    })),
  )
  expect(navLabels[0]).toEqual(expect.objectContaining({ text: 'Hermes' }))
  expect(navLabels[1]).toEqual(expect.objectContaining({ text: 'New Chat' }))

  const sidebarBottom = page.locator('.page-sidebar-bottom')
  await expect(sidebarBottom.locator('.sidebar-user')).toBeVisible()
  await expect(sidebarBottom.locator('.page-sidebar-menu-btn')).toHaveCount(0)
  await sidebarBottom.locator('.card-settings-button').click()
  await expect(page).toHaveURL(/#\/hermes\/settings$/)
  await page.goto('/#/hermes/chat')

  await expect(pageSidebar.getByText('Expert', { exact: true })).toBeVisible()
  await expect(pageSidebar.getByText('Automation', { exact: true })).toBeVisible()
  await expect(page.getByText('History', { exact: true })).toBeVisible()

  const labels = await pageSidebar.evaluate(element =>
    Array.from(element.querySelectorAll('.page-sidebar-tab span')).map(node => node.textContent?.trim() || ''),
  )
  expect(labels.slice(0, 6)).toEqual(['New Chat', 'Search', 'Expert', 'Agents', 'Automation', 'History'])

  await pageSidebar.getByRole('button', { name: /^Expert$/ }).click()
  await expect(page).toHaveURL(/#\/hermes\/chat\?surface=expert$/)
  await expect(page.locator('.page-sidebar-nav')).toBeVisible()
  await expect(page.locator('aside.sidebar')).toHaveCount(0)
  await page.getByRole('tab', { name: /^Skills$/ }).click()
  await expect(page.getByRole('heading', { name: 'Skills' })).toBeVisible()
  await expect(page.getByText('Research helper')).toBeVisible()

  await page.getByRole('tab', { name: /^Connectors$/ }).click()
  await expect(page).toHaveURL(/#\/hermes\/chat\?surface=expert&tab=connectors$/)
  await expect(page.getByText('Lark CLI')).toBeVisible()

  await page.goto('/#/hermes/chat')
  await page.locator('.page-sidebar-nav').getByRole('button', { name: /^Automation$/ }).click()
  await expect(page).toHaveURL(/#\/hermes\/chat\?surface=automation$/)
  await expect(page.locator('.page-sidebar-nav')).toBeVisible()
  await expect(page.locator('aside.sidebar')).toHaveCount(0)
  await expect(page.locator('.header-session-title')).toHaveText('Automation')
  await expect(page.getByText('Nightly Smoke')).toBeVisible()

  expect(api.requests.some(request =>
    request.pathname === '/api/hermes/skills' &&
    request.search === '?profile=research'
  )).toBe(true)
  expect(api.requests.some(request =>
    request.pathname === '/api/auth/skill-credentials' &&
    request.search === '?profile=research'
  )).toBe(true)
  expect(api.requests.some(request =>
    request.pathname === '/api/hermes/jobs' &&
    request.headers['x-hermes-profile'] === 'research'
  )).toBe(true)
  expect(api.unexpectedRequests).toEqual([])
})

test('expert and automation surfaces follow the selected frontend profile', async ({ page }) => {
  await authenticate(page, USER_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)

  await page.goto('/#/hermes/chat')
  await page.evaluate(() => window.localStorage.setItem('hermes_active_profile_name', 'default'))
  await page.reload()
  await expect(page.getByTestId('profile-selector-select')).toContainText('default')

  const pageSidebar = page.locator('.page-sidebar-nav')
  await pageSidebar.getByRole('button', { name: /^Expert$/ }).click()
  await expect(page).toHaveURL(/#\/hermes\/chat\?surface=expert$/)
  await page.getByRole('tab', { name: /^Skills$/ }).click()
  await expect(page.getByText('Research helper')).toBeVisible()

  await page.getByRole('tab', { name: /^Connectors$/ }).click()
  await expect(page.getByText('Lark CLI')).toBeVisible()

  await page.goto('/#/hermes/chat')
  await pageSidebar.getByRole('button', { name: /^Automation$/ }).click()
  await expect(page).toHaveURL(/#\/hermes\/chat\?surface=automation$/)
  await expect(page.locator('.header-session-title')).toHaveText('Automation')

  expect(api.requests.some(request =>
    request.pathname === '/api/hermes/skills' &&
    request.search === '?profile=default'
  )).toBe(true)
  expect(api.requests.some(request =>
    request.pathname === '/api/auth/skill-credentials' &&
    request.search === '?profile=default'
  )).toBe(true)
  expect(api.requests.some(request =>
    request.pathname === '/api/hermes/jobs' &&
    request.headers['x-hermes-profile'] === 'default'
  )).toBe(true)
  expect(api.unexpectedRequests).toEqual([])
})

test('stale GitLab handoff opens the token form on equal connector cards', async ({ page }) => {
  await authenticate(page, USER_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await page.route('**/api/auth/skill-credentials*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        profile_name: 'research',
        credentials: [
          {
            id: 'lark-cli',
            title: 'Lark CLI',
            provider: 'Feishu',
            installed: true,
            status: 'needs_auth',
            detail: 'Connect Feishu capabilities with the current employee account.',
            account_hint: 'employee@example.com',
            required_by: ['hidden-lark-skill'],
            action: { kind: 'feishu_device_flow', label: 'Connect' },
          },
          {
            id: 'feishu-project',
            title: 'Feishu Project',
            provider: 'Feishu',
            installed: true,
            status: 'authenticated',
            detail: 'Use the existing project CLI authorization to query and update work items.',
            action: { kind: 'skill_flow', label: 'Reconnect', command: '/feishu-project auth' },
          },
          {
            id: 'keep-record',
            title: 'Keep Record',
            provider: 'Keep',
            installed: true,
            status: 'configured',
            detail: 'Read the current employee workout records after QR authorization.',
            action: { kind: 'skill_flow', label: 'Reconnect', command: '/keep-record auth' },
          },
          {
            id: 'kep-cli-online',
            title: 'KEP CLI Online',
            provider: 'Keep',
            installed: true,
            status: 'authenticated',
            detail: 'Use the employee online environment identity.',
            action: { kind: 'oauth', label: 'Reconnect' },
          },
          {
            id: 'kep-cli-pre',
            title: 'KEP CLI Pre',
            provider: 'Keep',
            installed: true,
            status: 'authenticated',
            detail: 'Use the employee pre-release environment identity.',
            action: { kind: 'oauth', label: 'Reconnect' },
          },
          {
            id: 'gitlab',
            title: 'GitLab (global)',
            provider: 'gitlab',
            installed: true,
            status: 'configured',
            detail: 'Managed by administrators and shown here only as the global fallback.',
          },
          {
            id: 'gitlab-personal',
            title: 'GitLab (personal)',
            provider: 'gitlab',
            installed: true,
            status: 'needs_auth',
            detail: 'Bind a personal token so repository operations use the current employee permissions.',
            required_by: ['hidden-gitlab-skill'],
            action: { kind: 'manual', label: 'Bind my GitLab' },
          },
          {
            id: 'github-mcp',
            title: 'GitHub',
            provider: 'github',
            installed: true,
            status: 'needs_auth',
            detail: 'Connect the official GitHub MCP server with my personal read-only credential.',
            required_by: ['github-mcp'],
            action: { kind: 'manual', label: 'Connect' },
          },
        ],
      }),
    })
  })
  await page.setViewportSize({ width: 1440, height: 900 })

  await page.goto('/#/hermes/chat?surface=expert&tab=connectors&open_credential=gitlab-personal')

  await expect(page.locator('.gitlab-form')).toBeVisible()
  await expect(page.getByText('关联技能')).toHaveCount(0)
  await expect(page.getByText('hidden-lark-skill')).toHaveCount(0)
  await expect(page.getByText('hidden-gitlab-skill')).toHaveCount(0)
  await expect(page.locator('[data-credential-action="gitlab"]')).toHaveCount(0)
  await page.getByRole('button', { name: '取消' }).click()

  await expect(page.getByRole('heading', { name: 'GitHub' })).toBeVisible()
  await expect(page.getByText('Connect the official GitHub MCP server with my personal read-only credential.')).toBeVisible()
  await page.locator('[data-credential-action="github-mcp"]').click()
  const githubToken = page.getByPlaceholder('Paste your GitHub PAT')
  await expect(githubToken).toHaveAttribute('type', 'password')
  await githubToken.fill('github_pat_browser_secret')
  await expect(page.locator('body')).not.toContainText('github_pat_browser_secret')
  expect(await page.evaluate(() => JSON.stringify(window.localStorage))).not.toContain('github_pat_browser_secret')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(githubToken).toHaveCount(0)

  const cards = page.locator('.credential-card')
  await expect(cards).toHaveCount(8)
  const boxes = await cards.evaluateAll(elements => elements.map((element) => {
    const rect = element.getBoundingClientRect()
    return {
      width: rect.width,
      height: rect.height,
      overflow: element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight,
    }
  }))
  expect(new Set(boxes.map(box => box.width)).size).toBe(1)
  expect(new Set(boxes.map(box => box.height)).size).toBe(1)
  expect(boxes.every(box => box.width === 281 && box.height === 220)).toBe(true)
  expect(boxes.every(box => !box.overflow)).toBe(true)

  for (const size of [{ width: 720, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size)
    const narrowBoxes = await cards.evaluateAll(elements => elements.map((element) => {
      const rect = element.getBoundingClientRect()
      return {
        height: rect.height,
        overflow: element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight,
      }
    }))
    expect(new Set(narrowBoxes.map(box => box.height)).size).toBe(1)
    expect(narrowBoxes.every(box => !box.overflow)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  }
})

test('connector catalog renders 642 rows and imports only owner-safe remote MCP config', async ({ page }) => {
  await authenticate(page, USER_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  const imported: Array<Record<string, unknown>> = []
  let catalogInstallation: Record<string, unknown> | null = null

  await page.route('**/api/auth/skill-credentials/catalog/icon?*', async route => {
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"missing"}' })
  })

  await page.route('**/api/auth/skill-credentials/catalog?*', async (route) => {
    const url = new URL(route.request().url())
    const count = url.searchParams.get('view') === 'canonical' ? 330 : 642
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        profile_name: 'research', subject_id: 'owner-a',
        view: count === 330 ? 'canonical' : 'source', source_count: 642, canonical_count: 330,
        connectors: Array.from({ length: count }, (_, index) => ({
          row_key: `row-${index}`, canonical_key: `connector-${index}`,
          name: `Connector ${index}`, product: 'Example',
          final_verdict: index % 2 ? 'needs_auth' : 'pass',
          next_action: index % 2 ? 'Complete personal authorization' : 'Ready to connect',
          action: catalogInstallation && index === 0
            ? { kind: 'revoke', label: 'Disconnect', available: true, installation_name: 'catalog-row-0', connector_id: 'custom-aaaaaaaaaaaaaaaaaaaaaaaa', status: 'ready' }
            : index % 2
            ? { kind: 'authorize', label: 'Authorization required', available: false }
            : { kind: 'connect', label: 'Connect', available: true, installation_name: `catalog-row-${index}` },
          download_count: index === 641 ? null : index,
          ...(index === 0 ? { icon: { url: '/api/auth/skill-credentials/catalog/icon?row_key=row-0' } } : {}),
        })),
      }),
    })
  })
  await page.route('**/api/auth/skill-credentials/catalog/connect', async (route) => {
    const { row_key: rowKey } = JSON.parse(route.request().postData() || '{}')
    catalogInstallation = {
      connector_id: 'custom-aaaaaaaaaaaaaaaaaaaaaaaa', name: `catalog-${rowKey}`,
      transport: 'streamable_http', endpoint: 'https://example.com/mcp',
      credential_fields: [], state: 'active', updated_at: 1,
    }
    await route.fulfill({
      status: 201, contentType: 'application/json',
      body: JSON.stringify({ profile_name: 'research', subject_id: 'owner-a', connectors: [catalogInstallation] }),
    })
  })
  await page.route('**/api/auth/skill-credentials/custom**', async (route) => {
    if (route.request().method() === 'DELETE') catalogInstallation = null
    if (route.request().method() === 'POST') imported.push(JSON.parse(route.request().postData() || '{}'))
    await route.fulfill({
      status: route.request().method() === 'POST' ? 201 : 200,
      contentType: 'application/json',
      body: JSON.stringify({
        profile_name: 'research', subject_id: 'owner-a',
        connectors: catalogInstallation ? [catalogInstallation] : imported.length ? [{
          connector_id: 'custom-0123456789abcdef01234567', name: 'demo',
          transport: 'streamable_http', endpoint: 'https://example.com/mcp',
          credential_fields: [], state: 'configured', updated_at: 1,
        }] : [],
      }),
    })
  })

  await page.goto('/#/hermes/chat?surface=expert&tab=connectors')
  const panel = page.getByTestId('connector-catalog')
  await expect(panel.locator('.catalog-card')).toHaveCount(642, { timeout: 30_000 })
  await expect(panel.locator('.catalog-card').first().locator('.catalog-fallback')).toHaveText('C')
  await panel.locator('.catalog-card').first().click()
  const detail = page.locator('.n-modal').filter({ hasText: 'Connector 0' })
  await detail.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(detail.getByRole('button', { name: 'Remove', exact: true })).toBeVisible()
  await detail.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(detail.getByRole('button', { name: 'Add', exact: true })).toBeVisible()
  await detail.getByRole('button', { name: 'Cancel', exact: true }).click()
  await panel.getByPlaceholder('Search servers...').fill('Connector 641')
  await expect(panel.locator('.catalog-card')).toHaveCount(1)
  await expect(panel.locator('.catalog-card')).toContainText('↓ Not provided')
  await panel.getByRole('button', { name: '330' }).click()
  await expect(panel.locator('.catalog-card')).toHaveCount(0)
  await panel.getByPlaceholder('Search servers...').fill('')
  await expect(panel.locator('.catalog-card')).toHaveCount(330)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)

  await panel.getByTestId('custom-connector-open').click()
  const modal = page.locator('.n-modal')
  const textarea = modal.locator('textarea')
  const save = modal.getByRole('button', { name: 'Save' })
  await textarea.fill('{"mcpServers":{"unsafe":{"command":"npx"}}}')
  await expect(save).toBeDisabled()
  const config = '{"mcpServers":{"demo":{"type":"streamableHttp","url":"https://example.com/mcp"}}}'
  await textarea.fill(config)
  await expect(save).toBeEnabled()
  await save.click()
  await expect(panel.getByText('demo', { exact: true })).toBeVisible()
  expect(imported).toEqual([{ config }])
})

test('super-admins keep access to technical inventory and sidebar controls', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)

  await page.goto('/#/hermes/plugins')

  await expect(page).toHaveURL(/#\/hermes\/plugins$/)
  const sidebar = page.locator('aside.sidebar')
  await expect(sidebar.getByRole('link', { name: /^Files$/ })).toBeVisible()
  await expect(sidebar.getByRole('link', { name: /^Expert$/ })).toHaveCount(0)
  await expect(sidebar.getByRole('link', { name: /^Automation$/ })).toHaveCount(0)
  await expect(sidebar.getByRole('link', { name: /^Plugins$/ })).toBeVisible()
  await expect(sidebar.getByRole('link', { name: /^MCP$/ })).toBeVisible()
  await expect(page.locator('button[title="Comic style"]')).toBeVisible()
  await expect(page.locator('button[title="Dark mode"]')).toBeVisible()

  await page.goto('/#/hermes/mcp')
  await expect(page).toHaveURL(/#\/hermes\/mcp$/)
})
