/** Run via `npx deepspace test run tests/rally-collab.spec.ts` after configuring two CLI test accounts.
 * This is an integration test against real DeepSpace services, not mocked.
 * A cancelled __test record is retained for audit: no delete endpoint is exposed.
 */
import { test, expect } from 'deepspace/testing'
import type { Page } from '@playwright/test'

test('shared link and live readiness update across two accounts', async ({ users, page }) => {
  test.setTimeout(120_000)
  const [alice, bob] = await users(2)
  const title = `__test-${Date.now()}__ doubles`
  let created = false
  let bobReady = false
  let sessionId = ''
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
    await alice.page.getByLabel('Target players').selectOption('3')
    // datetime-local expects wall-clock time, not UTC, so avoid toISOString().
    const d = new Date(Date.now() + 5 * 86400_000)
    const pad = (n: number) => String(n).padStart(2, '0')
    const future = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    await alice.page.locator('input[type="datetime-local"]').fill(future)
    await alice.page.getByRole('button', { name: 'Publish session' }).click()
    await expect(alice.page.getByRole('heading', { name: title }).last()).toBeVisible()
    created = true
    const sharedUrl = new URL(alice.page.url())
    sessionId = sharedUrl.searchParams.get('session') ?? ''
    expect(sessionId).toBeTruthy()
    const missingSession = await invokeRallyCommand(alice.page, {
      operation: 'rsvp',
      sessionId: `missing-${Date.now()}`,
      status: 'going',
    })
    expect(missingSession.result).toMatchObject({ success: false })
    const invitation = `${sharedUrl.pathname}${sharedUrl.search}`
    await page.goto(invitation)
    await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible()
    await expect(page.getByRole('heading', { name: title })).toHaveCount(0)
    await bob.page.goto(invitation)
    await expect(bob.page.getByRole('heading', { name: title }).last()).toBeVisible({ timeout: 30_000 })
    bobReady = true
    expect(await bob.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    const forbiddenCancel = await invokeRallyCommand(bob.page, { operation: 'cancel', sessionId })
    expect(forbiddenCancel.result).toMatchObject({
      success: false,
      error: 'Only the session host can cancel it.',
    })
    await expect(alice.page.getByTestId('readiness-count')).toHaveText('1 / 3 confirmed')
    await expect(bob.page.getByTestId('readiness-count')).toHaveText('1 / 3 confirmed')
    await bob.page.getByRole('button', { name: /I.m in/i }).click()
    await expect(bob.page.getByRole('button', { name: /Going/ })).toBeVisible()
    await expect(bob.page.getByRole('button', { name: 'Cancel my session' })).toHaveCount(0)
    await expect(alice.page.getByTestId('readiness-count')).toHaveText('2 / 3 confirmed', { timeout: 30_000 })
    await expect(alice.page.getByTestId('readiness-status')).toHaveText('One more player needed')
    await expect(bob.page.getByTestId('readiness-count')).toHaveText('2 / 3 confirmed', { timeout: 30_000 })
    await expect(bob.page.getByTestId('readiness-status')).toHaveText('One more player needed')
    await alice.page.getByTestId('readiness-panel').screenshot({ path: 'test-results/ready-to-play-desktop.png' })
    await bob.page.getByTestId('readiness-panel').screenshot({ path: 'test-results/ready-to-play-mobile.png' })
    await expect(alice.page.getByRole('heading', { name: 'Session chat' })).toBeVisible({ timeout: 30_000 })
    await expect(alice.page.getByText('2 here now')).toBeVisible({ timeout: 30_000 })
    await alice.page.getByRole('textbox', { name: 'Your message' }).fill('Bring extra balls')
    await alice.page.getByRole('button', { name: 'Send message' }).click()
    await expect(bob.page.getByText('Bring extra balls')).toBeVisible({ timeout: 30_000 })

    const forgedIdentity = await invokeRallyCommand(bob.page, {
      operation: 'rsvp',
      sessionId,
      status: 'maybe',
      userId: alice.userId ?? 'forged-host-id',
    })
    expect(forgedIdentity.result).toMatchObject({ success: true })
    await expect(bob.page.getByRole('button', { name: 'Maybe ✓' })).toBeVisible()
    await expect(alice.page.getByTestId('readiness-count')).toHaveText('1 / 3 confirmed', { timeout: 30_000 })

    const duplicateWrites = await Promise.all([
      invokeRallyCommand(bob.page, {
        operation: 'rsvp',
        sessionId,
        status: 'going',
        userId: alice.userId ?? 'forged-host-id',
      }),
      invokeRallyCommand(bob.page, {
        operation: 'rsvp',
        sessionId,
        status: 'going',
        userId: alice.userId ?? 'forged-host-id',
      }),
    ])
    expect(duplicateWrites[0].result).toMatchObject({ success: true })
    expect(duplicateWrites[1].result).toMatchObject({ success: true })
    expect(duplicateWrites[0].result.data.recordId).toBe(duplicateWrites[1].result.data.recordId)
    await expect(alice.page.getByTestId('readiness-count')).toHaveText('2 / 3 confirmed', { timeout: 30_000 })

    await bob.page.getByRole('button', { name: 'Withdraw' }).click()
    await expect(alice.page.getByTestId('readiness-count')).toHaveText('1 / 3 confirmed', { timeout: 30_000 })
    await expect(alice.page.getByTestId('readiness-status')).toHaveText('2 more players needed')
    await expect(bob.page.getByTestId('readiness-count')).toHaveText('1 / 3 confirmed', { timeout: 30_000 })

    const concurrentUpdates = await Promise.all([
      invokeRallyCommand(alice.page, { operation: 'rsvp', sessionId, status: 'maybe' }),
      invokeRallyCommand(bob.page, { operation: 'rsvp', sessionId, status: 'going' }),
    ])
    expect(concurrentUpdates[0].result).toMatchObject({ success: true })
    expect(concurrentUpdates[1].result).toMatchObject({ success: true })
    await expect(alice.page.getByRole('button', { name: 'Maybe ✓' })).toBeVisible()
    await expect(bob.page.getByRole('button', { name: /Going/ })).toBeVisible()
    await expect(alice.page.getByTestId('readiness-count')).toHaveText('1 / 3 confirmed', { timeout: 30_000 })
  } finally {
    // Cancel rather than pretending the user can erase other players' records.
    if (created) {
      alice.page.once('dialog', dialog => void dialog.accept())
      await alice.page.getByRole('button', { name: 'Cancel my session' }).click()
      await expect(alice.page.getByText('This session was cancelled')).toBeVisible()
      await expect(alice.page.getByText('This session is cancelled; player responses are closed.')).toBeVisible()
      await expect(alice.page.getByRole('button', { name: /I.m in/i })).toHaveCount(0)
      if (bobReady) {
        const lateRsvp = await invokeRallyCommand(bob.page, {
          operation: 'rsvp',
          sessionId,
          status: 'going',
        })
        expect(lateRsvp.result).toMatchObject({
          success: false,
          error: 'This session is not open for responses.',
        })
      }
    }
  }
})

async function invokeRallyCommand(page: Page, command: Record<string, unknown>) {
  return page.evaluate(async (input) => {
    const sdkPath = new URL('/node_modules/.vite/deps/deepspace.js', location.origin).href
    const sdk = await import(sdkPath)
    const token = await sdk.getAuthToken()
    if (!token) throw new Error('Test account did not have an auth token.')
    const response = await fetch('/api/actions/rallyCommand', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    })
    return { status: response.status, result: await response.json() }
  }, command)
}
