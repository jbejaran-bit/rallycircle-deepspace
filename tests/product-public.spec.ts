import { expect, test } from '@playwright/test'

for (const width of [320, 375, 390, 768, 1024, 1440]) {
  test(`landing remains usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Make time.*for tennis\./)
    await expect(page.getByRole('link', { name: 'Find a game', exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Create a rally', exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Explore courts', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  })
}

test('product links reach the real protected routes and public help', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Create a rally', exact: true }).click()
  await expect(page).toHaveURL(/\/rallies\?create=1$/)
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible()
  await page.goto('/')
  await page.getByRole('link', { name: 'My dashboard' }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible()
  await page.goto('/')
  await page.getByRole('link', { name: 'Explore courts', exact: true }).click()
  await expect(page).toHaveURL(/\/courts$/)
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible()
  await page.goto('/')
  await page.getByRole('link', { name: 'Open match history' }).click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByText('Sign in to manage your player profile and see your match history.')).toBeVisible()
  await page.goto('/')
  await page.getByRole('link', { name: 'Privacy and help' }).click()
  await expect(page.getByRole('heading', { name: 'Privacy and help' })).toBeVisible()
})

test('mobile navigation closes on Escape and restores focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/dashboard')
  const menu = page.getByRole('button', { name: 'Toggle menu' })
  await menu.press('Enter')
  await expect(menu).toHaveAttribute('aria-expanded', 'true')
  const link = page.getByRole('link', { name: 'Dashboard', exact: true })
  await expect(link).toHaveAttribute('aria-current', 'page')
  await link.press('Escape')
  await expect(menu).toHaveAttribute('aria-expanded', 'false')
  await expect(menu).toBeFocused()
})


test('landing lets keyboard users skip the navigation', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('static-landing')).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
})

test('rally creation rejects anonymous requests', async ({ request }) => {
  const response = await request.post('/api/actions/createRally', { data: {} })
  expect(response.status()).toBe(401)
})

test('advanced profile and inbox controls stay behind sign-in on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 })
  for (const { path, reason, privateHeading } of [
    { path: '/settings', reason: /manage your player profile/, privateHeading: 'Match history' },
    { path: '/notifications', reason: /see your rally updates/, privateHeading: 'Notifications' },
  ]) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible()
    await expect(page.getByText(reason)).toBeVisible()
    await expect(page.getByRole('heading', { name: privateHeading, exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  }
})
