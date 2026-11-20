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
    await expect(page).toHaveURL(url => url.pathname === '/rallies')
    await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible()
    const menu = page.getByRole('button', { name: 'Toggle menu' })
    await expect(menu).toHaveAttribute('aria-expanded', 'false')
    await menu.press('Space')
    await expect(menu).toHaveAttribute('aria-expanded', 'true')
    await expect(menu).toBeFocused()
    await menu.press('Space')
    await expect(menu).toHaveAttribute('aria-expanded', 'false')
  })
})

function luminance(rgb: string) {
  const components = rgb.match(/[\d.]+/g)?.slice(0, 3).map(value => {
    const srgb = Number(value) / 255
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  })
  if (!components || components.length !== 3) throw new Error(`Expected an RGB color, got ${rgb}`)
  const [red, green, blue] = components
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

test('sign-in actions meet normal-text contrast in both themes', async ({ page }) => {
  await page.goto('/rallies')
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible()

  const signInButtons = page.getByRole('button', { name: 'Sign in', exact: true })
  await expect(signInButtons).toHaveCount(2)
  for (const theme of ['slate', 'paper']) {
    await page.locator('html').evaluate((html, value) => html.setAttribute('data-theme', value), theme)
    for (const button of await signInButtons.all()) {
      const colors = await button.evaluate(element => {
        const { color, backgroundColor } = getComputedStyle(element)
        return { color, backgroundColor }
      })
      const fg = luminance(colors.color)
      const bg = luminance(colors.backgroundColor)
      const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
      expect(ratio, `${theme} sign-in contrast`).toBeGreaterThanOrEqual(4.5)
    }
  }
})
