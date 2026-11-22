import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

const phase = process.argv[2] ?? 'after'
const base = process.env.RALLYCIRCLE_FIXTURE_URL ?? 'http://127.0.0.1:5182'
const browser = await chromium.launch({ headless: true })
try {
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height }, timezoneId: 'America/New_York', reducedMotion: 'reduce' })
    page.on('pageerror', error => console.error(error.message))
    await mkdir(`docs/screenshots/calendar-ui/${phase}`, { recursive: true })
    for (const view of ['landing', 'rallies', 'dashboard', 'games']) {
      await page.goto(`${base}/tests/ui-fixtures/index.html?view=${view}`)
      await page.getByRole('heading', { level: 1 }).waitFor()
      await page.evaluate(() => document.fonts.ready)
      if (view === 'rallies') await page.getByTestId('courtboard-panel').waitFor()
      await page.screenshot({ path: `docs/screenshots/calendar-ui/${phase}/${view}-${name}.png`, fullPage: true })
      console.log(`${phase}/${view}-${name}.png`)
      if (view === 'rallies') {
        await page.getByTestId('courtboard-panel').screenshot({ path: `docs/screenshots/calendar-ui/${phase}/courtboard-${name}.png` })
        await page.locator('#rally-chat').screenshot({ path: `docs/screenshots/calendar-ui/${phase}/chat-${name}.png` })
      }
    }
    await page.close()
  }
} finally { await browser.close() }
