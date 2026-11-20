import { expect, test } from '@playwright/test'

test.describe('signed-out navigation on mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  for (const path of ['/rallies?session=invite%2Fid%26detail', '/courts', '/settings', '/api-status']) {
    test(`keeps ${path} behind the sign-in gate`, async ({ page }) => {
      await page.goto(path)
      await expect(page).toHaveURL(url => url.pathname + url.search === path)
      await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Sign in' }).last()).toBeVisible()
      await expect(page.getByRole('button', { name: 'New session' })).toHaveCount(0)
      await expect(page.getByRole('heading', { name: 'Find a court' })).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    })
  }

  test('supports keyboard activation of the return link', async ({ page }) => {
    await page.goto('/rallies?session=keyboard-check')
    const home = page.getByRole('link', { name: 'Back to home' })
    await home.focus()
    await expect(home).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(url => url.pathname === '/')
    await expect(page.getByTestId('static-landing')).toBeVisible()
  })

  test('exposes the mobile menu expansion state to assistive technology', async ({ page }) => {
    await page.goto('/home')
    const menu = page.getByRole('button', { name: 'Toggle menu' })
    await expect(menu).toHaveAttribute('aria-expanded', 'false')
    await menu.focus()
    await page.keyboard.press('Space')
    await expect(menu).toHaveAttribute('aria-expanded', 'true')
    await expect(menu).toBeFocused()
    await page.keyboard.press('Space')
    await expect(menu).toHaveAttribute('aria-expanded', 'false')
  })
})
