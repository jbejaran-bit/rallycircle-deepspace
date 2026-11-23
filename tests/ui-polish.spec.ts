import { expect, test, type Page } from '@playwright/test'

const fixture = (query = '') => `/tests/ui-fixtures/index.html?${query}`

async function mockActions(page: Page) {
  const commands: Record<string, unknown>[] = []
  await page.route('**/api/actions/*', async route => {
    const input = route.request().postDataJSON()
    commands.push(input)
    const action = new URL(route.request().url()).pathname.split('/').at(-1)!
    const recordId = await page.evaluate(({ action, input }) => {
      const bridge = (globalThis as typeof globalThis & { __rallycircleFixtureAction: (action: string, input: Record<string, unknown>) => string }).__rallycircleFixtureAction
      return bridge(action, input)
    }, { action, input })
    await route.fulfill({ json: { success: true, data: { recordId } } })
  })
  return commands
}

for (const width of [320, 390, 768, 1440]) {
  test(`actual app components reflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    for (const view of ['landing', 'rallies', 'dashboard', 'games', 'courts']) {
      await page.goto(fixture(`view=${view}`))
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      if (view === 'rallies') {
        await expect(page.getByTestId('readiness-count')).toHaveText('4 / 4 confirmed')
        await expect(page.getByTestId('courtboard-panel')).toBeVisible()
        await expect(page.getByRole('heading', { name: 'Session chat' })).toBeVisible()
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth), view).toBeLessThanOrEqual(width)
    }
  })
}

test('calendar editor keeps exact session fields without a visible ICS action', async ({ page }) => {
  await page.goto(fixture('view=rallies'))
  const google = page.getByRole('link', { name: /Add to Google Calendar/ })
  await expect(google).toBeVisible()
  const url = new URL((await google.getAttribute('href'))!)
  expect(url.origin).toBe('https://calendar.google.com')
  expect(url.searchParams.get('text')).toBe('Saturday doubles at Schenley')
  expect(url.searchParams.get('dates')).toBe('20300615T140000Z/20300615T153000Z')
  expect(url.searchParams.get('ctz')).toBe('America/New_York')
  expect(url.searchParams.get('location')).toContain('Schenley Park Tennis Courts')
  expect(url.searchParams.get('details')).toContain('/rallies?session=fixture-doubles')
  expect(url.searchParams.get('details')).toContain('Bring a fresh can of tennis balls.')
  await page.context().route('https://calendar.google.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Google Calendar target intercepted for local verification</title><p>No event created.</p>' }))
  const popupPromise = page.waitForEvent('popup')
  await google.click()
  const popup = await popupPromise
  await expect(popup).toHaveURL(url.href)
  await popup.close()
  await expect(page.getByRole('link', { name: /Download .ics/ })).toHaveCount(0)
  expect(await page.getByText(/Saved to Google Calendar/).count()).toBe(0)
})

test('cancelled sessions do not offer a Google event or direct save', async ({ page }) => {
  await page.goto(fixture('view=rallies&cancelled=1'))
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.getByRole('button', { name: /^all$/i }).click()
  await expect(page.getByText('This session is cancelled; player responses are closed.')).toBeVisible()
  await expect(page.getByRole('link', { name: /Add to Google Calendar/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Save to Google Calendar/ })).toHaveCount(0)
})

test('message controls send confirmed text and retain a rejected draft', async ({ page }) => {
  await page.goto(fixture('view=rallies'))
  const input = page.getByRole('textbox', { name: 'Your message' })
  const send = page.getByRole('button', { name: 'Send message' })
  await expect(send).toBeDisabled()
  await input.fill('   ')
  await expect(send).toBeDisabled()
  await input.fill('I will be there at 9:50.')
  await send.click()
  await expect(page.getByRole('log')).toContainText('I will be there at 9:50.')
  await expect(input).toHaveValue('')
  await page.goto(fixture('view=rallies&sendError=1'))
  await input.fill('Please keep this draft.')
  await send.click()
  await expect(page.getByRole('alert')).toContainText('Message could not be sent')
  await expect(input).toHaveValue('Please keep this draft.')
})

test('attendance and waitlist controls submit their intended operations', async ({ page }) => {
  const commands = await mockActions(page)
  await page.goto(fixture('view=rallies&user=visitor'))
  await page.getByRole('button', { name: 'Join waitlist', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Leave waitlist', exact: true })).toBeVisible()
  expect(commands.at(-1)).toMatchObject({ operation: 'joinWaitlist', sessionId: 'fixture-doubles' })
  await page.getByRole('button', { name: 'Leave waitlist', exact: true }).click()
  expect(commands.at(-1)).toMatchObject({ operation: 'leaveWaitlist' })
  await page.goto(fixture('view=rallies&user=bob'))
  await page.getByRole('button', { name: 'Withdraw', exact: true }).click()
  expect(commands.at(-1)).toMatchObject({ operation: 'withdraw' })
  await expect(page.getByTestId('readiness-count')).toHaveText('3 / 4 confirmed')
})

test('courtboard has a keyboard alternative to dragging', async ({ page }) => {
  await page.goto(fixture('view=rallies'))
  await expect(page.getByTestId('courtboard-marker-A1')).toBeVisible()
  const marker = page.getByTestId('courtboard-marker-A1')
  await marker.focus()
  await marker.press('ArrowRight')
  const x = Number(await marker.getAttribute('data-x'))
  expect(x).toBeGreaterThan(110)
})

test('creation form publishes a local rally with host RSVP and linked chat', async ({ page }) => {
  const commands = await mockActions(page)
  await page.goto(fixture('view=rallies'))
  await page.getByRole('button', { name: 'New session' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create a session' })
  await expect(dialog.getByLabel('Session title')).toBeFocused()
  for (const label of ['Court', 'Area']) await expect(dialog.getByLabel(label, { exact: true })).toBeVisible()
  for (const label of ['Format', 'Target players']) await expect(dialog.getByRole('combobox', { name: label, exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Fill sample session' }).click()
  await dialog.getByRole('button', { name: 'Publish session' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Weekend doubles & rally practice' }).last()).toBeVisible()
  await expect(page.getByTestId('readiness-count')).toHaveText('1 / 4 confirmed')
  await expect(page.getByRole('heading', { name: 'Session chat' })).toBeVisible()
  expect(commands.some(command => command.title === 'Weekend doubles & rally practice')).toBe(true)
  expect(commands.some(command => command.operation === 'rsvp' && command.sessionId === 'fixture-created' && command.status === 'going')).toBe(true)
})

test('empty, loading and error states remain understandable', async ({ page }) => {
  for (const query of ['empty=1', 'loading=1', 'error=1']) {
    await page.goto(fixture(`view=rallies&${query}`))
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    if (query.startsWith('empty')) await expect(page.getByText('No sessions here yet')).toBeVisible()
    if (query.startsWith('loading')) await expect(page.getByText('Loading sessions and responses…')).toHaveCount(1)
    if (query.startsWith('error')) await expect(page.getByRole('region', { name: 'Find a rally' }).getByRole('alert')).toContainText('Local fixture connection unavailable')
  }
})
