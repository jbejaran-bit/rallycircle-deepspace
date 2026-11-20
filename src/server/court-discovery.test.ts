import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { AppContext } from '../../worker'
import { createCourtCache, registerCourtDiscoveryRoutes } from './court-discovery'

const NOW = 1_800_000_000_000

const overpassFixture = {
  elements: [
    {
      type: 'node',
      id: 111,
      lat: 40.44,
      lon: -79.95,
      tags: { leisure: 'pitch', sport: 'tennis', name: 'Mellon Park Courts', surface: 'asphalt', lit: 'yes' },
    },
    {
      type: 'way',
      id: 222,
      center: { lat: 40.45, lon: -79.96 },
      tags: { leisure: 'pitch', sport: 'tennis', name: 'Arsenal Park Courts' },
    },
  ],
}

const nominatimFixture = [
  { display_name: 'Boston, Massachusetts, United States', lat: '42.3601', lon: '-71.0589' },
]

function buildApp(options: {
  authed: boolean
  fetchFn: ReturnType<typeof vi.fn>
}) {
  const app = new Hono<AppContext>()
  registerCourtDiscoveryRoutes(
    app,
    // Stub resolver: the real one verifies a JWT; here auth is a switch.
    async () => (options.authed ? ({ userId: 'user-1' } as never) : null),
    { fetchFn: options.fetchFn as unknown as typeof fetch, cache: createCourtCache(() => NOW), now: () => NOW },
  )
  return app
}

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })

describe('GET /api/courts/nearby', () => {
  it('requires sign-in', async () => {
    const app = buildApp({ authed: false, fetchFn: vi.fn() })
    const res = await app.request('https://rallycircle.example/api/courts/nearby?lat=40.44&lng=-79.95', {}, {})
    expect(res.status).toBe(401)
  })

  it('rejects invalid coordinates', async () => {
    const fetchFn = vi.fn()
    const app = buildApp({ authed: true, fetchFn })
    const res = await app.request('https://rallycircle.example/api/courts/nearby?lat=91&lng=-79.95', {}, {})
    expect(res.status).toBe(400)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('returns parsed courts with attribution, then serves the repeat from cache', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(overpassFixture))
    const app = buildApp({ authed: true, fetchFn })
    const url = 'https://rallycircle.example/api/courts/nearby?lat=40.44&lng=-79.95&radiusKm=10'

    const first = await app.request(url, {}, {})
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { courts: unknown[]; cached: boolean; attribution: string; source: string }
    expect(firstBody.courts).toHaveLength(2)
    expect(firstBody.courts[0]).toMatchObject({ name: 'Mellon Park Courts', surface: 'asphalt', lights: 'lit' })
    expect(firstBody.source).toBe('openstreetmap')
    expect(firstBody.attribution).toContain('OpenStreetMap')
    expect(firstBody.cached).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    // The upstream request identifies the app and uses a tight radius query.
    const [endpoint, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(endpoint).toBe('https://overpass-api.de/api/interpreter')
    expect((init.headers as Record<string, string>)['User-Agent']).toContain('RallyCircle')
    expect(new URLSearchParams(String(init.body)).get('data')).toContain('around:10000,40.44,-79.95')

    const second = await app.request(url, {}, {})
    expect(second.status).toBe(200)
    expect(((await second.json()) as { cached: boolean }).cached).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('clamps an out-of-range radius instead of rejecting it', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(overpassFixture))
    const app = buildApp({ authed: true, fetchFn })
    const res = await app.request('https://rallycircle.example/api/courts/nearby?lat=40.44&lng=-79.95&radiusKm=500', {}, {})
    expect(res.status).toBe(200)
    expect(new URLSearchParams(String((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body)).get('data')).toContain('around:50000,')
  })

  it('turns an upstream 429 into a 502 that tells the client to wait', async () => {
    const fetchFn = vi.fn(async () => new Response('rate limited', { status: 429 }))
    const app = buildApp({ authed: true, fetchFn })
    const res = await app.request('https://rallycircle.example/api/courts/nearby?lat=40.44&lng=-79.95', {}, {})
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toMatch(/wait a moment/)
  })

  it('turns a malformed upstream payload into a 502, not a crash', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ remark: 'not the shape we parse' }))
    const app = buildApp({ authed: true, fetchFn })
    const res = await app.request('https://rallycircle.example/api/courts/nearby?lat=40.44&lng=-79.95', {}, {})
    expect(res.status).toBe(502)
  })

  it('returns an empty list when the area has no mapped courts', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ elements: [] }))
    const app = buildApp({ authed: true, fetchFn })
    const res = await app.request('https://rallycircle.example/api/courts/nearby?lat=0&lng=0', {}, {})
    expect(res.status).toBe(200)
    expect(((await res.json()) as { courts: unknown[] }).courts).toEqual([])
  })
})

describe('GET /api/geocode', () => {
  it('requires sign-in', async () => {
    const app = buildApp({ authed: false, fetchFn: vi.fn() })
    const res = await app.request('https://rallycircle.example/api/geocode?q=Boston', {}, {})
    expect(res.status).toBe(401)
  })

  it('rejects queries that are too short or too long', async () => {
    const fetchFn = vi.fn()
    const app = buildApp({ authed: true, fetchFn })
    expect((await app.request('https://rallycircle.example/api/geocode?q=B', {}, {})).status).toBe(400)
    expect((await app.request(`https://rallycircle.example/api/geocode?q=${'x'.repeat(201)}`, {}, {})).status).toBe(400)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('returns parsed places and caches identical queries', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(nominatimFixture))
    const app = buildApp({ authed: true, fetchFn })
    const url = 'https://rallycircle.example/api/geocode?q=Boston%2C%20MA'

    const first = await app.request(url, {}, {})
    expect(first.status).toBe(200)
    const body = (await first.json()) as { results: { displayName: string; lat: number }[]; cached: boolean }
    expect(body.results).toEqual([{ displayName: 'Boston, Massachusetts, United States', lat: 42.3601, lng: -71.0589 }])
    expect(body.cached).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[0]).toContain('nominatim.openstreetmap.org/search')
    expect((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[0]).toContain('limit=5')

    const second = await app.request(url, {}, {})
    expect(((await second.json()) as { cached: boolean }).cached).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
