/** Run via `npx deepspace test run tests/scoreboard.spec.ts` after configuring two CLI test accounts.
 * This is an integration test against real DeepSpace services, not mocked.
 * It is NOT run in this environment (no test accounts) — see IMPLEMENTATION_LOG.md.
 * A cancelled __test record is retained for audit: no delete endpoint is exposed.
 */
import { test, expect } from 'deepspace/testing'
import type { Page } from '@playwright/test'

const SCORE = {
  operation: 'scoreboard',
  teamAName: 'Alice / Bob',
  teamBName: 'Carol / Dan',
  status: 'final',
  sets: [{ a: 6, b: 4 }, { a: 6, b: 3 }],
  matchTiebreak: null,
  expectedVersion: 0,
  correction: false,
}

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

test('live scoreboard: host creates, participant sees it live, non-host cannot write', async ({ users, page }) => {
  test.setTimeout(180_000)
  const [alice, bob] = await users(2)
  const title = `__test-scoreboard-${Date.now()}__ doubles`
  await bob.page.setViewportSize({ width: 390, height: 844 })
  let sessionId = ''

  try {
    // Alice creates a session (same flow as rally-collab.spec.ts).
    await alice.page.goto('/courts')
    await alice.page.getByRole('button', { name: /Highland Park Tennis Courts/ }).click()
    await alice.page.getByRole('link', { name: 'Plan a Rally here' }).click()
    await alice.page.getByPlaceholder('Sunday doubles & rallies').fill(title)
    await alice.page.getByPlaceholder('Schenley Park').fill('Test court')
    await alice.page.getByPlaceholder('Pittsburgh, PA').fill('Test location')
    const d = new Date(Date.now() + 5 * 86400_000)
    const pad = (n: number) => String(n).padStart(2, '0')
    const future = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    await alice.page.locator('input[type="datetime-local"]').fill(future)
    await alice.page.getByRole('button', { name: 'Publish session' }).click()
    await expect(alice.page.getByRole('heading', { name: title }).last()).toBeVisible()
    sessionId = new URL(alice.page.url()).searchParams.get('session') ?? ''
    expect(sessionId).toBeTruthy()

    // Bob opens the shared link; both see the empty scoreboard.
    await bob.page.goto(`/rallies?session=${sessionId}`)
    await expect(bob.page.getByTestId('match-scoreboard')).toBeVisible({ timeout: 30_000 })
    await expect(bob.page.getByText('No score yet for this match.')).toBeVisible()
    await expect(bob.page.getByRole('button', { name: 'Add score' })).toHaveCount(0)
    await expect(alice.page.getByText('No score yet for this match.')).toBeVisible()

    // 1–2. Host creates a score; the other participant sees it live, no refresh.
    await alice.page.getByRole('button', { name: 'Add score' }).click()
    await alice.page.getByLabel('Team A name').fill('Alice / Bob')
    await alice.page.getByLabel('Team B name').fill('Carol / Dan')
    await alice.page.getByLabel('Set 1, Team A games').fill('6')
    await alice.page.getByLabel('Set 1, Team B games').fill('4')
    await alice.page.getByLabel('Set 2, Team A games').fill('6')
    await alice.page.getByLabel('Set 2, Team B games').fill('3')
    await alice.page.getByLabel('Match status').selectOption('final')
    await alice.page.getByRole('button', { name: 'Save score' }).click()
    await expect(alice.page.getByTestId('scoreboard-sets')).toHaveText('6–4, 6–3')
    await expect(alice.page.getByText('Final', { exact: true })).toBeVisible()
    await expect(bob.page.getByTestId('scoreboard-sets')).toHaveText('6–4, 6–3', { timeout: 30_000 })
    await expect(bob.page.getByText('not official or validated')).toBeVisible()

    // 5. Non-host cannot change the result (server action, not just hidden UI).
    const forbidden = await invokeRallyCommand(bob.page, { ...SCORE, sessionId, expectedVersion: 1 })
    expect(forbidden.result).toMatchObject({
      success: false,
      error: 'Only the session host can update the scoreboard.',
    })

    // 6. Invalid scores are rejected.
    const invalid = await invokeRallyCommand(alice.page, {
      ...SCORE,
      sessionId,
      sets: [{ a: 6, b: 6 }],
      expectedVersion: 1,
      correction: true,
    })
    expect(invalid.result).toMatchObject({ success: false })

    // 3–4, 8. Host corrects the score; the participant sees the update live.
    await alice.page.getByRole('button', { name: 'Correct score' }).click()
    await alice.page.getByLabel('Set 2, Team A games').fill('7')
    await alice.page.getByLabel('Set 2, Team B games').fill('5')
    await alice.page.getByLabel(/correcting the recorded score/).check()
    await alice.page.getByRole('button', { name: 'Save score' }).click()
    await expect(alice.page.getByTestId('scoreboard-sets')).toHaveText('6–4, 7–5')
    await expect(bob.page.getByTestId('scoreboard-sets')).toHaveText('6–4, 7–5', { timeout: 30_000 })

    // 7. Refresh preserves the score.
    await bob.page.reload()
    await expect(bob.page.getByTestId('scoreboard-sets')).toHaveText('6–4, 7–5', { timeout: 30_000 })

    // 9. Existing RSVP/chat workflows still work.
    await bob.page.getByRole('button', { name: /I.m in/i }).click()
    await expect(bob.page.getByRole('button', { name: /Going/ })).toBeVisible()
    await expect(alice.page.getByTestId('readiness-count')).toHaveText('2 / 4 confirmed', { timeout: 30_000 })
    await bob.page.getByRole('textbox', { name: 'Your message' }).fill('Great match')
    await bob.page.getByRole('button', { name: 'Send message' }).click()
    await expect(alice.page.getByText('Great match')).toBeVisible({ timeout: 30_000 })

    // Screenshots for the demo: desktop host view, mobile participant view.
    await alice.page.getByTestId('match-scoreboard').screenshot({ path: 'test-results/scoreboard-desktop.png' })
    await bob.page.getByTestId('match-scoreboard').screenshot({ path: 'test-results/scoreboard-mobile.png' })
    expect(await bob.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  } finally {
    // Leave the __test session in place (no delete endpoint); the title marks it.
    void sessionId
    void page
  }
})
