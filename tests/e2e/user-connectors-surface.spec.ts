import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test.describe.configure({ mode: 'serial' })

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
  await expect(sidebar.getByRole('link', { name: /^Expert$/ })).toBeVisible()
  await expect(sidebar.getByRole('link', { name: /^Automation$/ })).toBeVisible()
  await expect(sidebar.getByRole('link', { name: /^Skills$/ })).toHaveCount(0)
  await expect(sidebar.getByRole('link', { name: /^Connectors$/ })).toHaveCount(0)
  await expect(sidebar.getByRole('link', { name: /^Plugins$/ })).toHaveCount(0)
  await expect(sidebar.getByRole('link', { name: /^MCP$/ })).toHaveCount(0)
  await expect(page.locator('button[title="Comic style"]')).toHaveCount(0)
  await expect(page.locator('button[title="Dark mode"]')).toHaveCount(0)

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

test('ordinary users open expert and automation directly from the app sidebar', async ({ page }) => {
  await authenticate(page, USER_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)

  await page.goto('/#/hermes/chat')

  const pageSidebar = page.locator('.page-sidebar-nav')
  await expect(pageSidebar).toBeVisible()
  await expect(pageSidebar.getByText('Expert', { exact: true })).toHaveCount(0)
  await expect(pageSidebar.getByText('Automation', { exact: true })).toHaveCount(0)
  await expect(page.getByText('History', { exact: true })).toBeVisible()

  const labels = await pageSidebar.evaluate(element =>
    Array.from(element.querySelectorAll('.page-sidebar-tab span')).map(node => node.textContent?.trim() || ''),
  )
  expect(labels.slice(0, 3)).toEqual(['New Chat', 'Search', 'History'])

  await page.goto('/#/hermes/connectors')
  const sidebar = page.locator('aside.sidebar')
  await sidebar.getByRole('link', { name: /^Expert$/ }).click()
  await expect(page).toHaveURL(/#\/hermes\/expert$/)
  await expect(page.getByRole('tab', { name: /^Skills$/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Skills' })).toBeVisible()
  await expect(page.getByText('Research helper')).toBeVisible()

  await page.getByRole('tab', { name: /^Connectors$/ }).click()
  await expect(page).toHaveURL(/#\/hermes\/expert\?tab=connectors$/)
  await expect(page.getByText('Lark CLI')).toBeVisible()

  await sidebar.getByRole('link', { name: /^Automation$/ }).click()
  await expect(page).toHaveURL(/#\/hermes\/jobs$/)
  await expect(page.getByRole('heading', { name: 'Automation' })).toBeVisible()
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

  await page.goto('/#/hermes/connectors')
  const sidebar = page.locator('aside.sidebar')
  await sidebar.getByRole('link', { name: /^Expert$/ }).click()
  await expect(page).toHaveURL(/#\/hermes\/expert$/)
  await expect(page.getByText('Research helper')).toBeVisible()

  await page.getByRole('tab', { name: /^Connectors$/ }).click()
  await expect(page.getByText('Lark CLI')).toBeVisible()

  await page.goto('/#/hermes/expert?tab=connectors&profile=research')
  await expect(page.getByText('Lark CLI')).toBeVisible()

  await sidebar.getByRole('link', { name: /^Automation$/ }).click()
  await expect(page.getByRole('heading', { name: 'Automation' })).toBeVisible()

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
