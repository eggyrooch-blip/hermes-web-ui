import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('sidebar matches the visual baseline', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)

  await page.goto('/#/hermes/jobs')

  const sidebar = page.locator('aside.sidebar')
  await expect(sidebar).toBeVisible()
  await expect(sidebar.getByRole('link', { name: /^Settings$/ })).toBeVisible()

  await expect(sidebar).toHaveScreenshot('sidebar.png', {
    animations: 'disabled',
    mask: [sidebar.locator('.sidebar-user')],
    maxDiffPixelRatio: 0.01,
  })

  expect(api.unexpectedRequests).toEqual([])
})
