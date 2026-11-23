/**
 * Server-side court discovery adapter.
 *
 * Why server-side: the public Overpass and Nominatim endpoints are shared,
 * donated infrastructure with published usage policies (see
 * docs/COURTS_AND_GAMES_README.md). Calling them directly from every
 * browser would multiply traffic by the user count, expose the app to
 * per-IP blocks, and leak the viewer's coordinates to a third party.
 * Routing through this worker means:
 *
 * - One cached, paced upstream call serves many identical searches.
 * - The viewer's coordinates go to RallyCircle's own worker only; they
 *   are never stored, logged, or written to a record. Overpass receives
 *   coordinates only as part of a radius query (unavoidable — it is the
 *   query), with no user identity attached.
 * - Upstream failures degrade to a clean retryable JSON error, never a
 *   crash or a leaked upstream body. Featured courts remain available.
 *
 * Usage-policy compliance, main Overpass instance (overpass-api.de):
 * - Well under 10,000 queries/day and 1 GB/day for one-off use; for a
 *   regularly-used app the guidance divides those by 100 — hence the
 *   10-minute TTL cache and a 50-entry cap, plus tight `around:` queries.
 * - Identifying User-Agent + Referer on every upstream request.
 * - On 429/406/503 from upstream: no retry, return 502 and tell the
 *   client to try again later (the policy says pause 30 s; retrying
 *   immediately from the server would be the opposite).
 *
 * Nominatim (nominatim.openstreetmap.org): absolute max 1 request/second
 * for the whole application, identifying User-Agent, no autocomplete,
 * cache results. Enforced here with a process-wide promise chain that
 * spaces geocode requests ≥1.1 s apart. The client only offers search on
 * submit (button/Enter), never per keystroke.
 */

import type { Hono } from 'hono'
import type { AppContext } from '../../worker'
import { buildNominatimUrl, buildOverpassQuery, OVERPASS_ENDPOINT, parseNominatimResponse, parseOverpassResponse } from '../lib/osm'
import { clampRadiusKm, isValidLatLng, type LatLng } from '../lib/geo'
import type { VerifyResult } from 'deepspace/worker'

export type AuthResolver = (req: Request, env: AppContext['Bindings']) => Promise<VerifyResult | null>

export const COURT_SEARCH_TTL_MS = 10 * 60 * 1000
export const COURT_CACHE_MAX_ENTRIES = 50
export const GEOCODER_MIN_GAP_MS = 1100
export const UPSTREAM_TIMEOUT_MS = 20_000
export const MAX_COURTS_PER_SEARCH = 100

const USER_AGENT =
  'RallyCircle/0.0.1 (tennis session planner; https://github.com/jbejaran-bit/rallycircle-deepspace)'
const REFERER = 'https://github.com/jbejaran-bit/rallycircle-deepspace'

export interface CourtCacheEntry {
  at: number
  courts: Awaited<ReturnType<typeof parseOverpassResponse>>
}

export interface CourtCache {
  get(key: string): CourtCacheEntry | undefined
  set(key: string, entry: CourtCacheEntry): void
}

/** Tiny bounded in-memory TTL cache. One per worker isolate; no persistence. */
export function createCourtCache(now: () => number = Date.now): CourtCache {
  const store = new Map<string, CourtCacheEntry>()
  return {
    get(key) {
      const entry = store.get(key)
      if (!entry) return undefined
      if (now() - entry.at > COURT_SEARCH_TTL_MS) {
        store.delete(key)
        return undefined
      }
      return entry
    },
    set(key, entry) {
      if (store.size >= COURT_CACHE_MAX_ENTRIES) {
        const oldest = store.keys().next().value
        if (oldest !== undefined) store.delete(oldest)
      }
      store.set(key, entry)
    },
  }
}

export interface CourtDiscoveryDeps {
  fetchFn?: typeof fetch
  cache?: CourtCache
  /** Injectable clock for tests (defaults to Date.now). */
  now?: () => number
}

/** Cache key: coordinates rounded to ~100 m + radius, so nearby pans share a hit. */
export function courtCacheKey(center: LatLng, radiusKm: number): string {
  return `${center.lat.toFixed(3)},${center.lng.toFixed(3)},${radiusKm}`
}

function upstreamError(status: number): Response {
  const retryable = status === 429 || status === 406 || status === 503
  return Response.json(
    {
      error: retryable
        ? 'Court search is busy right now. Please wait a moment and try again.'
        : 'Court search is unavailable right now. Try another place or search again later.',
    },
    { status: 502 },
  )
}

async function fetchOverpass(
  center: LatLng,
  radiusKm: number,
  fetchFn: typeof fetch,
): Promise<ReturnType<typeof parseOverpassResponse>> {
  const body = new URLSearchParams({ data: buildOverpassQuery(center, radiusKm) })
  const res = await fetchFn(OVERPASS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
      Referer: REFERER,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
  if (!res.ok) return Promise.reject(upstreamError(res.status))
  const payload: unknown = await res.json()
  return parseOverpassResponse(payload)
}

/**
 * Process-wide Nominatim pacing: a promise chain that guarantees ≥1.1 s
 * between the *starts* of successive geocode requests, per the 1 req/s
 * policy (the policy counts the whole application, summed over users, so
 * a per-request throttle would not be enough on its own — the cache below
 * also dedupes identical queries).
 */
export function createGeocodePacer(minGapMs = GEOCODER_MIN_GAP_MS, now: () => number = Date.now) {
  let lastStart = 0
  let chain: Promise<unknown> = Promise.resolve()
  return function pace<T>(work: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
      const wait = Math.max(0, lastStart + minGapMs - now())
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
      lastStart = now()
      return work()
    })
    // Keep the chain alive even if this request fails.
    chain = run.catch(() => undefined)
    return run
  }
}

export async function fetchGeocodedPlaces(query: string, fetchFn: typeof fetch = fetch) {
  const response = await fetchFn(buildNominatimUrl(query), {
    headers: { 'User-Agent': USER_AGENT, Referer: REFERER },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
  if (!response.ok) throw upstreamError(response.status)
  return parseNominatimResponse(await response.json())
}

export function registerCourtDiscoveryRoutes(
  app: Hono<AppContext>,
  resolveAuth: AuthResolver,
  deps: CourtDiscoveryDeps = {},
): void {
  const fetchFn = deps.fetchFn ?? fetch
  const cache = deps.cache ?? createCourtCache(deps.now)
  const now = deps.now ?? Date.now
  const paceGeocode = createGeocodePacer(GEOCODER_MIN_GAP_MS, now)
  const geocodeCache = new Map<string, { at: number; places: ReturnType<typeof parseNominatimResponse> }>()

  app.get('/api/courts/nearby', async (c) => {
    const auth = await resolveAuth(c.req.raw, c.env)
    if (!auth) return c.json({ error: 'Sign in required' }, 401)

    const lat = Number(c.req.query('lat')?.trim() || Number.NaN)
    const lng = Number(c.req.query('lng')?.trim() || Number.NaN)
    const radiusKm = clampRadiusKm(c.req.query('radiusKm'))
    if (!isValidLatLng({ lat, lng })) {
      return c.json({ error: 'Provide a valid latitude (-90 to 90) and longitude (-180 to 180).' }, 400)
    }
    const center: LatLng = { lat, lng }

    const key = courtCacheKey(center, radiusKm)
    const cached = cache.get(key)
    if (cached) {
      return c.json({
        courts: cached.courts,
        count: cached.courts.length,
        source: 'openstreetmap',
        attribution: '© OpenStreetMap contributors',
        cached: true,
      })
    }

    try {
      const courts = (await fetchOverpass(center, radiusKm, fetchFn)).slice(0, MAX_COURTS_PER_SEARCH)
      cache.set(key, { at: now(), courts })
      return c.json({
        courts,
        count: courts.length,
        source: 'openstreetmap',
        attribution: '© OpenStreetMap contributors',
        cached: false,
      })
    } catch (error) {
      if (error instanceof Response) return error
      return c.json(
        { error: 'Court search is unavailable right now. Try another place or search again later.' },
        502,
      )
    }
  })

  app.get('/api/geocode', async (c) => {
    const auth = await resolveAuth(c.req.raw, c.env)
    if (!auth) return c.json({ error: 'Sign in required' }, 401)

    const q = (c.req.query('q') ?? '').trim()
    if (q.length < 2 || q.length > 200) {
      return c.json({ error: 'Enter a place name between 2 and 200 characters.' }, 400)
    }

    const cached = geocodeCache.get(q.toLowerCase())
    if (cached && now() - cached.at <= COURT_SEARCH_TTL_MS) {
      return c.json({ results: cached.places, cached: true })
    }

    try {
      let places: ReturnType<typeof parseNominatimResponse>
      if (deps.fetchFn) {
        places = await paceGeocode(() => fetchGeocodedPlaces(q, fetchFn))
      } else {
        const namespace = c.env.RALLY_COMMAND_ROOMS
        const room = namespace.get(namespace.idFromName('court-discovery:nominatim'))
        const response = await room.fetch(new Request('https://internal/geocode', {
          method: 'POST',
          headers: { 'X-App-Action': 'true' },
          body: q,
        }))
        if (!response.ok) return response
        places = await response.json()
      }
      if (geocodeCache.size >= COURT_CACHE_MAX_ENTRIES) {
        const oldest = geocodeCache.keys().next().value
        if (oldest !== undefined) geocodeCache.delete(oldest)
      }
      geocodeCache.set(q.toLowerCase(), { at: now(), places })
      return c.json({ results: places, cached: false })
    } catch (error) {
      if (error instanceof Response) return error
      return c.json({ error: 'Place search is unavailable right now. Try again in a moment.' }, 502)
    }
  })
}
