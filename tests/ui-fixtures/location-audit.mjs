import { chromium } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { mockDiscovery, fixturePlace } from './location-network.mjs'

const base = process.env.RALLYCIRCLE_FIXTURE_URL ?? 'http://127.0.0.1:5194'
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  await mockDiscovery(page)
  await page.goto(`${base}/tests/ui-fixtures/index.html?view=courts`)
  await page.getByLabel('City or neighbourhood').fill('Boston')
  await page.getByRole('button', { name: 'Search place', exact: true }).click()
  await page.getByRole('button', { name: fixturePlace.displayName, exact: true }).click()
  await page.locator('.rally-court-pin[aria-pressed="true"]').waitFor()
  const metrics = await page.locator('.rally-court-pin').evaluateAll(pins => pins.map(pin => {
    const style = getComputedStyle(pin), bounds = pin.getBoundingClientRect()
    const luminance = color => {
      const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(value => { const n = Number(value) / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4 })
      return .2126 * r + .7152 * g + .0722 * b
    }
    const foreground = luminance(style.color), background = luminance(style.backgroundColor)
    return { label: pin.getAttribute('aria-label'), selected: pin.getAttribute('aria-pressed'), number: pin.textContent, foreground: style.color, background: style.backgroundColor, width: bounds.width, height: bounds.height, contrast: Number(((Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05)).toFixed(2)) }
  }))
  await page.keyboard.press('Tab')
  await page.locator('.rally-court-pin').first().focus()
  const focus = await page.locator('.rally-court-pin').first().evaluate(pin => ({ outline: getComputedStyle(pin).outline, offset: getComputedStyle(pin).outlineOffset, shadow: getComputedStyle(pin).boxShadow }))
  await writeFile('test-results/location-runtime-audit.json', JSON.stringify({ metrics, focus, note: 'Actual native Leaflet pin text/fill and target sizes; upstream tiles are synthetic local fixtures.' }, null, 2))
  console.log(JSON.stringify({ metrics, focus }, null, 2))
} finally { await browser.close() }
