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
  let bobConfirmed = false
  let sessionId = ''
  // Simulate the browser permission denial without requesting real coordinates.
  await alice.page.addInitScript(() => {
    Object.defineProperty(navigator.geolocation, 'getCurrentPosition', {
      value: (_resolve: PositionCallback, reject: PositionErrorCallback) => {
        queueMicrotask(() => reject({ code: 1, message: 'Denied' } as GeolocationPositionError))
      },
    })
  })
  await alice.page.goto('/courts')
  await bob.page.setViewportSize({ width: 390, height: 844 })
  try {
    await expect(alice.page.getByRole('main')).toHaveCount(1)
    await alice.page.getByRole('button', { name: 'Use my location' }).click()
    await expect(alice.page.getByRole('status')).toContainText('You can still browse the Pittsburgh courts.')
    const courtSearch = alice.page.getByRole('searchbox', { name: 'Search by court or area' })
    await courtSearch.fill('not-a-venue')
    await expect(alice.page.getByText('No Pittsburgh courts match that search.')).toBeVisible()
    await alice.page.getByRole('button', { name: 'Clear search' }).click()
    await courtSearch.fill('Stanton Avenue')
    await expect(alice.page.getByRole('button', { name: /Frick Park Clay Courts/ })).toHaveCount(0)
    await alice.page.getByRole('button', { name: /Highland Park Tennis Courts/ }).click()
    await expect(alice.page.getByRole('link', { name: 'Open court calendar' })).toHaveAttribute('href', /pittsburgh\.recdesk\.com/)
    await alice.page.getByRole('link', { name: 'Plan a Rally here' }).click()
    await expect(alice.page.getByRole('main')).toHaveCount(1)
    const createDialog = alice.page.getByRole('dialog', { name: 'Create a session' })
    await expect(createDialog.getByLabel('Session title')).toBeFocused()
    await expect(alice.page.getByPlaceholder('Schenley Park')).toHaveValue('Highland Park Tennis Courts')
    await expect(alice.page.getByPlaceholder('Pittsburgh, PA')).toHaveValue('Stanton Avenue, Pittsburgh')
    await alice.page.getByPlaceholder('Sunday doubles & rallies').fill(title)
    await alice.page.getByPlaceholder('Schenley Park').fill('Test court')
    await alice.page.getByPlaceholder('Pittsburgh, PA').fill('Test location')
    await alice.page.getByLabel('Format', { exact: true }).selectOption('Singles')
    await alice.page.getByLabel('Target players').selectOption('3')
    await alice.page.getByLabel('Maximum confirmed players').selectOption('3')
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
    await expect(bob.page.getByRole('heading', { name: title }).last()).toBeFocused()
    await bob.page.getByRole('link', { name: 'Session list' }).press('Enter')
    await expect(bob.page.getByRole('heading', { name: 'Find a rally' })).toBeFocused()
    expect(await bob.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    const forbiddenCancel = await invokeRallyCommand(bob.page, { operation: 'cancel', sessionId })
    expect(forbiddenCancel.result).toMatchObject({
      success: false,
      error: 'Only the session host can cancel it.',
    })
    await expect(alice.page.getByTestId('readiness-count')).toHaveText('1 / 3 confirmed')
    await expect(bob.page.getByTestId('readiness-count')).toHaveText('1 / 3 confirmed')
    await bob.page.goto('/games')
    const discoveryGame = bob.page.getByRole('article').filter({ has: bob.page.getByRole('heading', { name: title, exact: true }) })
    await discoveryGame.getByRole('button', { name: 'RSVP going' }).click()
    await expect(discoveryGame.getByRole('status')).toHaveText('Your RSVP was saved.')
    await discoveryGame.getByRole('link').click()
    await expect(bob.page.getByRole('button', { name: /Going/ })).toBeVisible()
    await expect(bob.page.getByRole('button', { name: 'Cancel my session' })).toHaveCount(0)
    await expect(alice.page.getByTestId('readiness-count')).toHaveText('2 / 3 confirmed', { timeout: 30_000 })
    await expect(alice.page.getByTestId('readiness-status')).toHaveText('Singles ready!')
    await expect(bob.page.getByTestId('readiness-count')).toHaveText('2 / 3 confirmed', { timeout: 30_000 })
    await expect(bob.page.getByTestId('readiness-status')).toHaveText('Singles ready!')
    await alice.page.getByTestId('readiness-panel').screenshot({ path: 'test-results/ready-to-play-desktop.png' })
    await bob.page.getByTestId('readiness-panel').screenshot({ path: 'test-results/ready-to-play-mobile.png' })
    await expect(alice.page.getByRole('heading', { name: 'Session chat' })).toBeVisible({ timeout: 30_000 })
    await expect(alice.page.getByText('2 here now')).toBeVisible({ timeout: 30_000 })
    const draft = alice.page.getByRole('textbox', { name: 'Your message' })
    const send = alice.page.getByRole('button', { name: 'Send message' })
    await expect(send).toBeDisabled()
    await draft.fill('   ')
    await expect(send).toBeDisabled()
    await expect(draft).toHaveAttribute('maxlength', '500')
    await draft.fill('Bring extra balls')
    await alice.page.getByRole('button', { name: 'Send message' }).click()
    await expect(bob.page.getByText('Bring extra balls')).toBeVisible({ timeout: 30_000 })

    const calendar = bob.page.getByRole('link', { name: 'Add to calendar' })
    const downloadPromise = bob.page.waitForEvent('download')
    await calendar.click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('rallycircle-session.ics')
    const calendarStream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of calendarStream) chunks.push(Buffer.from(chunk))
    const event = Buffer.concat(chunks).toString('utf8').replace(/\r\n /g, '')
    expect(event).toContain('BEGIN:VEVENT')
    expect(event).toContain(`SUMMARY:${title}`)
    expect(event).toContain('LOCATION:Test court\\, Test location')
    const hostScoreboard = alice.page.getByRole('region', { name: 'Match scoreboard' })
    const team1 = hostScoreboard.getByRole('group', { name: 'Side 1', exact: true }).getByLabel('Player 1')
    const team2 = hostScoreboard.getByRole('group', { name: 'Side 2', exact: true }).getByLabel('Player 1')
    await expect(team1.getByRole('option')).toHaveCount(3)
    await team1.selectOption({ index: 1 })
    await team2.selectOption({ index: 2 })
    await hostScoreboard.getByRole('button', { name: 'Start match' }).click()
    await hostScoreboard.getByRole('button', { name: 'Point to side 1' }).click()
    const participantScoreboard = bob.page.getByRole('region', { name: 'Match scoreboard' })
    await expect(participantScoreboard.getByRole('cell', { name: '15', exact: true })).toBeVisible()
    await hostScoreboard.getByRole('button', { name: 'Point to side 1' }).click()
    await expect(participantScoreboard.getByRole('cell', { name: '30', exact: true })).toBeVisible()
    await expect(participantScoreboard.getByRole('button')).toHaveCount(0)
    await alice.page.getByRole('button', { name: 'Playing now' }).click()
    await expect(alice.page.getByRole('button', { name: new RegExp(title) })).toBeVisible()
    await alice.page.goto(invitation)
    await expect(hostScoreboard.getByRole('cell', { name: '30', exact: true })).toBeVisible()

    await bob.page.goto('/dashboard')
    await expect(bob.page.getByRole('heading', { name: 'Your dashboard' })).toBeVisible()
    await expect(bob.page.getByRole('region', { name: 'My matches' }).getByRole('link', { name: new RegExp(title) })).toBeVisible()
    await bob.page.getByRole('button', { name: 'Week', exact: true }).click()
    await expect(bob.page.getByRole('status').filter({ hasText: 'Week of' })).toBeVisible()
    await bob.page.goto(invitation)

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
    bobConfirmed = true
  } finally {
    // Cancel rather than pretending the user can erase other players' records.
    if (created) {
      await alice.page.getByRole('button', { name: 'Cancel my session' }).click()
      const cancellation = alice.page.getByRole('dialog', { name: 'Cancel this session?' })
      await expect(cancellation.getByRole('button', { name: 'Keep session' })).toBeVisible()
      await cancellation.getByRole('button', { name: 'Cancel session' }).click()
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
        if (bobConfirmed) {
          const withdraw = bob.page.getByRole('button', { name: 'Withdraw RSVP', exact: true })
          await withdraw.click()
          await expect(withdraw).toHaveCount(0)
        }
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
