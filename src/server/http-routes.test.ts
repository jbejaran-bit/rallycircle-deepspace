import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { AppContext } from '../../worker'
import { registerAuthAndIntegrationRoutes } from './http-routes'

vi.mock('deepspace/worker', () => ({
  SESSION_COOKIE: 'session',
  authWorkerFetch: vi.fn(async () => Response.json({ sessionToken: 'test-session' })),
}))

const app = new Hono<AppContext>()
registerAuthAndIntegrationRoutes(app)
const origin = 'https://rallycircle.example'
const env = { AUTH_WORKER_URL: 'https://auth.example' }

describe('shared session OAuth redirect', () => {
  it('preserves an encoded session ID and clears the invite cookie after exchange', async () => {
    const invite = `${origin}/rallies?session=test%2Fid%26detail`
    const start = await app.request(`${origin}/api/auth/social-redirect?provider=github`, {
      headers: { referer: invite },
    }, env)
    expect(start.status).toBe(302)
    const cookie = start.headers.getSetCookie()[0]
    expect(cookie).toContain('rallycircle_invite=test%2Fid%26detail')
    expect(cookie).toContain('HttpOnly')

    const callback = await app.request(`${origin}/api/auth/oauth-complete?code=test-code`, {
      headers: { cookie: cookie.split(';', 1)[0] },
    }, env)
    expect(callback.headers.get('location')).toBe(invite)
    expect(callback.headers.getSetCookie()).toEqual(expect.arrayContaining([
      expect.stringContaining('session=test-session'),
      expect.stringContaining('rallycircle_invite=; Max-Age=0'),
    ]))
  })

  it('ignores off-site referrers and keeps redirects on RallyCircle', async () => {
    const start = await app.request(`${origin}/api/auth/social-redirect?provider=github`, {
      headers: { referer: 'https://elsewhere.example/rallies?session=foreign' },
    }, env)
    expect(start.headers.get('set-cookie')).toContain('Max-Age=0')
    const result = await app.request(`${origin}/api/auth/oauth-complete`, {}, env)
    expect(result.headers.get('location')).toBe(`${origin}/rallies`)
  })
})
