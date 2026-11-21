/**
 * Playwright smoke tests for court discovery and Find Games.
 *
 * STATUS: written, NOT RUN. They need `deepspace test run` (two test
 * accounts + a local dev server), which was unavailable in this
 * environment — no DeepSpace CLI login exists here and the worktree was
 * never created. Do not claim these pass until they are executed.
 *
 * Design: the specs never touch the live Overpass/Nominatim endpoints.
 * `/api/courts/nearby` and `/api/geocode` are intercepted with fixture
 * responses, so the tests verify UI behaviour (states, sorting,
 * map/list consistency, permission denial, empty states) without
 * depending on third-party availability. The server adapter itself is
 * covered by `src/server/court-discovery.test.ts` (vitest, mocked fetch).
 */

import { test, expect } from 'deepspace/testing'

const overpassFixture = {
  courts: [
    { id: 'osm:node/111', name: 'Mellon Park Courts', lat: 40.44, lng: -79.95, surface: 'asphalt', lights: 'lit', access: 'public', source: 'osm', osmType: 'node', osmId: 111 },
    { id: 'osm:node/222', name: 'Arsenal Park Courts', lat: 40.45, lng: -79.96, source: 'osm', osmType: 'node', osmId: 222 },
  ],
  count: 2,
  source: 'openstreetmap',
  attribution: '© OpenStreetMap contributors',
  cached: false,
}

test.describe('court discovery', () => {
  test('nearby search shows map + list sorted by distance, with details only when tagged', async ({ users }) => {
    const [{ page }] = await users(1)
    await page.route('**/api/courts/nearby*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(overpassFixture) }))
    // Geolocation is stubbed: the one-shot request resolves to Mellon Park.
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (success: PositionCallback) => {
        success({ coords: { latitude: 40.44, longitude: -79.95, accuracy: 10, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() } as GeolocationPosition)
      }
    })
    await page.goto('/courts')
    await page.getByRole('tab', { name: 'Courts near me' }).click()
    await page.getByRole('button', { name: /find courts near me/i }).click()
    await expect(page.getByText('2 courts found within 10 km')).toBeVisible()
    await expect(page.getByRole('region', { name: /nearby tennis courts map/i })).toBeVisible()
    // Mellon Park (0.0 mi) sorts before Arsenal Park.
    const list = page.getByLabel('Nearby courts')
    await expect(list.getByText(/1\. Mellon Park Courts/)).toBeVisible()
    await expect(list.getByText(/2\. Arsenal Park Courts/)).toBeVisible()
    // Tagged attributes shown; untagged court shows the honest fallback.
    await expect(page.getByText('asphalt', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /2\. Arsenal Park Courts/ }).click()
    await expect(page.getByText(/No surface, lighting, or access details/)).toBeVisible()
  })

  test('permission denial falls back to manual place search', async ({ users }) => {
    const [{ page }] = await users(1)
    await page.route('**/api/geocode*', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results: [{ displayName: 'Boston, Massachusetts, United States', lat: 42.3601, lng: -71.0589 }], cached: false }),
    }))
    await page.route('**/api/courts/nearby*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...overpassFixture, courts: [], count: 0 }) }))
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (_success: PositionCallback, error?: PositionErrorCallback) => {
        error?.({ code: 1, message: 'denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError)
      }
    })
    await page.goto('/courts')
    await page.getByRole('tab', { name: 'Courts near me' }).click()
    await page.getByRole('button', { name: /find courts near me/i }).click()
    await expect(page.getByText(/permission was denied/i)).toBeVisible()
    await page.getByPlaceholder(/search by place/i).fill('Boston, MA')
    await page.getByRole('button', { name: /search place/i }).click()
    await page.getByRole('button', { name: /Boston, Massachusetts/ }).click()
    await expect(page.getByText(/No tennis courts are mapped/)).toBeVisible()
  })

  test('network failure shows an error and keeps the Pittsburgh fallback one click away', async ({ users }) => {
    const [{ page }] = await users(1)
    await page.route('**/api/courts/nearby*', route => route.abort('failed'))
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (success: PositionCallback) => {
        success({ coords: { latitude: 40.44, longitude: -79.95, accuracy: 10, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() } as GeolocationPosition)
      }
    })
    await page.goto('/courts')
    await page.getByRole('tab', { name: 'Courts near me' }).click()
    await page.getByRole('button', { name: /find courts near me/i }).click()
    await expect(page.getByText(/Court search failed|unavailable/i)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry court search' })).toBeVisible()
    await expect(page.getByRole('region', { name: /nearby tennis courts map/i })).toHaveCount(0)
    await page.getByRole('tab', { name: /Pittsburgh courts/i }).click()
    await expect(page.getByText('Schenley Oval Tennis Courts')).toBeVisible()
  })
})

test.describe('find games', () => {
  test('filters combine and an empty result explains itself', async ({ users }) => {
    const [{ page }] = await users(1)
    await page.goto('/games')
    await page.getByPlaceholder(/e\.g\. Schenley, Oakland/i).fill('Tokyo')
    await expect(page.getByText(/No games match these filters/)).toBeVisible()
    await page.getByRole('button', { name: 'Show all upcoming games' }).click()
    await expect(page.getByRole('searchbox', { name: 'Rally title, court or area' })).toHaveValue('')
    // With no sessions seeded in the test app, the empty state is the honest result.
    await expect(page.getByText(/No upcoming games yet|games found/)).toBeVisible()
  })
})
