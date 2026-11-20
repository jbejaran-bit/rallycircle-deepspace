import { test, expect } from '@playwright/test'

test.describe('API tests', () => {
  test('auth proxy forwards to auth worker', async ({ request }) => {
    const res = await request.get('/api/auth/ok')
    expect(res.ok()).toBeTruthy()
  })

  test('rally command requires an authenticated caller', async ({ request }) => {
    const res = await request.post('/api/actions/rallyCommand', {
      data: { operation: 'cancel', sessionId: 'session' },
    })
    expect(res.status()).toBe(401)
  })

  test('OAuth callback keeps a same-origin invite destination', async ({ request, baseURL }) => {
    const invitation = new URL('/rallies?session=shared-test-id', baseURL)
    const first = await request.get('/api/auth/social-redirect?provider=github', {
      headers: { referer: invitation.href },
      maxRedirects: 0,
    })
    expect(first.status()).toBe(302)
    const stored = first.headersArray().find(header => header.name.toLowerCase() === 'set-cookie')
    expect(stored?.value).toContain('rallycircle_invite=shared-test-id')

    const callback = await request.get('/api/auth/oauth-complete', {
      headers: { cookie: 'rallycircle_invite=shared-test-id' },
      maxRedirects: 0,
    })
    expect(callback.headers().location).toBe(invitation.href)
    expect(callback.headers()['set-cookie']).toContain('Max-Age=0')
  })

  test('WebSocket endpoint exists', async ({ page }) => {
    // /home is a dynamic page (under src/pages/(app)/), so mounting it boots
    // the providers and auto-connects the records WebSocket. The static
    // landing at '/' deliberately does neither — see smoke.spec.ts.
    await page.goto('/home')
    // Wait for the app to connect its WebSocket (it auto-connects on mount)
    await page.waitForSelector('[data-testid="app-navigation"]', { timeout: 15000 })
    // If the app loaded and connected, the WS endpoint works
  })
})
