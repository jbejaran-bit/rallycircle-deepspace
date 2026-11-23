import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { mockDiscovery } from './location-network.mjs'

const phase = process.argv[2] ?? 'after'
const base = process.env.RALLYCIRCLE_FIXTURE_URL ?? 'http://127.0.0.1:5192'
const browser = await chromium.launch({ headless: true })
const path = `docs/screenshots/location-ux/${phase}`
await mkdir(path, { recursive: true })
try {
  for (const [device, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height }, timezoneId: 'America/New_York', reducedMotion: 'reduce' })
    await mockDiscovery(page)
    await page.goto(`${base}/tests/ui-fixtures/index.html?view=courts`)
    await page.getByRole('heading', { level: 1 }).waitFor()
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: `${path}/courts-default-${device}.png`, fullPage: true })
    await page.locator('#court-tab-nearby').click()
    await page.getByLabel(/City or neighbourhood/).fill('Boston')
    await page.getByRole('button', { name: 'Search place', exact: true }).click()
    await page.getByRole('button', { name: /Boston Common, Boston/ }).click()
    if (width < 1024) await page.getByRole('button', { name: 'Map', exact: true }).click()
    await page.locator('.leaflet-marker-pane [aria-pressed="true"]').waitFor()
    await page.screenshot({ path: `${path}/court-selection-${device}.png`, fullPage: true })

    await page.goto(`${base}/tests/ui-fixtures/index.html?view=rallies&mapped=1`)
    await page.getByRole('heading', { name: 'Rally sessions', exact: true }).waitFor()
    await page.getByTestId('courtboard-panel').waitFor()
    await page.screenshot({ path: `${path}/rally-location-${device}.png`, fullPage: true })
    await page.getByRole('button', { name: 'Edit rally details', exact: true }).click()
    await page.getByRole('dialog').screenshot({ path: `${path}/edit-location-${device}.png` })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'New session', exact: true }).click()
    await page.getByRole('button', { name: 'Fill sample session', exact: true }).click()
    await page.getByRole('dialog').screenshot({ path: `${path}/create-location-${device}.png` })
    console.log(`${phase}: ${device} five location surfaces captured`)
    await page.close()
  }
} finally { await browser.close() }
