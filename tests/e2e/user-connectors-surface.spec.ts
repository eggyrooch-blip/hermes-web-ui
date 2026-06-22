import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const USER_ACCESS_KEY = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJzdWIiOiIyIiwidXNlcm5hbWUiOiJlbXBsb3llZSIsInJvbGUiOiJhZG1pbiIsInR5cGUiOiJhY2Nlc3MiLCJhdWQiOiJoZXJtZXMtd2ViLXVpIiwiaWF0IjoxNzYwMDAwMDAwLCJleHAiOjQxMDI0NDQ4MDB9',
  'playwright-signature',
].join('.')

test('ordinary users only see connectors and no technical sidebar controls', async ({ page }) => {
  await authenticate(page, USER_ACCESS_KEY, 'research')
  await mockHermesApi(page)

  await page.goto('/#/hermes/plugins')

  await expect(page).toHaveURL(/#\/hermes\/connectors$/)
  await expect(page.getByRole('heading', { name: 'Connectors' })).toBeVisible()
  await expect(page.getByText('Lark CLI')).toBeVisible()

  const sidebar = page.locator('aside.sidebar')
  await expect(sidebar.getByRole('link', { name: /^Connectors$/ })).toBeVisible()
  await expect(sidebar.getByRole('link', { name: /^Plugins$/ })).toHaveCount(0)
  await expect(sidebar.getByRole('link', { name: /^MCP$/ })).toHaveCount(0)
  await expect(page.locator('button[title="Comic style"]')).toHaveCount(0)
  await expect(page.locator('button[title="Dark mode"]')).toHaveCount(0)

  await page.goto('/#/hermes/mcp')
  await expect(page).toHaveURL(/#\/hermes\/connectors$/)
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

test('super-admins keep access to technical inventory and sidebar controls', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)

  await page.goto('/#/hermes/plugins')

  await expect(page).toHaveURL(/#\/hermes\/plugins$/)
  const sidebar = page.locator('aside.sidebar')
  await expect(sidebar.getByRole('link', { name: /^Plugins$/ })).toBeVisible()
  await expect(sidebar.getByRole('link', { name: /^MCP$/ })).toBeVisible()
  await expect(page.locator('button[title="Comic style"]')).toBeVisible()
  await expect(page.locator('button[title="Dark mode"]')).toBeVisible()

  await page.goto('/#/hermes/mcp')
  await expect(page).toHaveURL(/#\/hermes\/mcp$/)
})
