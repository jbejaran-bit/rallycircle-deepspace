/** Run via `npx deepspace test run tests/rally-collab.spec.ts` after configuring two CLI test accounts.
 * This is an integration test against real DeepSpace services, not mocked.
 * A cancelled __test record is retained for audit: no delete endpoint is exposed.
 */
import { test, expect } from 'deepspace/testing'

test('shared link, mobile RSVP, presence and messaging work across two accounts', async ({ users, page }) => {
  test.setTimeout(120_000)
  const [alice, bob] = await users(2)
  const title = `__test-${Date.now()}__ doubles`
  let created = false
  await alice.page.goto('/courts')
  await bob.page.setViewportSize({ width: 390, height: 844 })
  try {
    await alice.page.getByRole('button', { name: /Highland Park Tennis Courts/ }).click()
    await expect(alice.page.getByRole('link', { name: 'Open court calendar' })).toHaveAttribute('href', /pittsburgh\.recdesk\.com/)
    await alice.page.getByRole('link', { name: 'Plan a Rally here' }).click()
    await expect(alice.page.getByPlaceholder('Schenley Park')).toHaveValue('Highland Park Tennis Courts')
    await expect(alice.page.getByPlaceholder('Pittsburgh, PA')).toHaveValue('Stanton Avenue, Pittsburgh')
    await alice.page.getByPlaceholder('Sunday doubles & rallies').fill(title)
    await alice.page.getByPlaceholder('Schenley Park').fill('Test court')
    await alice.page.getByPlaceholder('Pittsburgh, PA').fill('Test location')
    // datetime-local expects wall-clock time, not UTC, so avoid toISOString().
    const d = new Date(Date.now() + 5 * 86400_000)
    const pad = (n: number) => String(n).padStart(2, '0')
    const future = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    await alice.page.locator('input[type="datetime-local"]').fill(future)
    await alice.page.getByRole('button', { name: 'Publish session' }).click()
    await expect(alice.page.getByRole('heading', { name: title }).last()).toBeVisible()
    created = true
    const sharedUrl = new URL(alice.page.url())
    expect(sharedUrl.searchParams.get('session')).toBeTruthy()
    const invitation = `${sharedUrl.pathname}${sharedUrl.search}`
    await page.goto(invitation)
    await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible()
    await expect(page.getByRole('heading', { name: title })).toHaveCount(0)
    await bob.page.goto(invitation)
    await expect(bob.page.getByRole('heading', { name: title }).last()).toBeVisible({ timeout: 30_000 })
    expect(await bob.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await bob.page.getByRole('button', { name: /I.m in/i }).click()
    await expect(bob.page.getByRole('button', { name: /Going/ })).toBeVisible()
    await expect(bob.page.getByRole('button', { name: 'Cancel my session' })).toHaveCount(0)
    await expect(alice.page.getByText(/2 confirmed/)).toBeVisible({ timeout: 30_000 })
    await expect(alice.page.getByRole('heading', { name: 'Session chat' })).toBeVisible({ timeout: 30_000 })
    await expect(alice.page.getByText('2 here now')).toBeVisible({ timeout: 30_000 })
    await alice.page.getByRole('textbox', { name: 'Your message' }).fill('Bring extra balls')
    await alice.page.getByRole('button', { name: 'Send message' }).click()
    await expect(bob.page.getByText('Bring extra balls')).toBeVisible({ timeout: 30_000 })
    await bob.page.getByRole('button', { name: 'Withdraw' }).click()
    await expect(alice.page.getByText(/1 confirmed/)).toBeVisible()
  } finally {
    // Cancel rather than pretending the user can erase other players' records.
    if (created) {
      alice.page.once('dialog', dialog => void dialog.accept())
      await alice.page.getByRole('button', { name: 'Cancel my session' }).click()
      await expect(alice.page.getByText('This session was cancelled')).toBeVisible()
    }
  }
})
