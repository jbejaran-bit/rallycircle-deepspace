import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'

const base = process.env.RALLYCIRCLE_FIXTURE_URL ?? 'http://127.0.0.1:5184'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
const results = []
try {
  await page.goto(`${base}/tests/ui-fixtures/index.html?view=landing`)
  await page.getByRole('heading', { level: 1 }).waitFor()
  for (const theme of ['club', 'slate', 'paper']) {
    await page.locator('html').evaluate((element, theme) => element.setAttribute('data-theme', theme), theme)
    await page.waitForTimeout(200)
    results.push(await page.evaluate(theme => {
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d', { willReadFrequently: true })
      function rgb(color) { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3) }
      function luminance(color) { const values = rgb(color).map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4 }); return .2126 * values[0] + .7152 * values[1] + .0722 * values[2] }
      function background(element) { while (element) { const color = getComputedStyle(element).backgroundColor; if (!color.endsWith(', 0)') && color !== 'transparent') return color; element = element.parentElement } return 'white' }
      const samples = ['.tennis-intro > p:not(.tennis-eyebrow)', '.tennis-nav-guide', '.tennis-primary', '.tennis-secondary', '.tennis-features p'].map(selector => {
        const element = document.querySelector(selector), style = getComputedStyle(element)
        const bg = background(element), foreground = luminance(style.color), backdrop = luminance(bg)
        return { selector, font: style.fontFamily, size: style.fontSize, foreground: style.color, background: bg, contrast: Number(((Math.max(foreground, backdrop) + .05) / (Math.min(foreground, backdrop) + .05)).toFixed(2)) }
      })
      return { theme, samples }
    }, theme))
  }
  await page.locator('html').evaluate(element => element.setAttribute('data-theme', 'club'))
  await page.getByRole('link', { name: 'Find a game', exact: true }).focus()
  const focus = await page.getByRole('link', { name: 'Find a game', exact: true }).evaluate(element => { const s = getComputedStyle(element); return { outline: s.outline, offset: s.outlineOffset, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height } })
  const report = { results, focus, note: 'Computed browser colors measured on rendered opaque landing backgrounds; no screen-reader conformance claim.' }
  await mkdir('test-results', { recursive: true })
  await writeFile('test-results/ui-runtime-audit.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally { await browser.close() }
