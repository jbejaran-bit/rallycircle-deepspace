/**
 * Client for the server-side court discovery adapter (`/api/courts/nearby`
 * and `/api/geocode`).
 *
 * The browser never talks to Overpass or Nominatim directly: coordinates
 * go to RallyCircle's own worker (authenticated with the SDK token), which
 * proxies, caches, and paces the upstream calls. The coordinates themselves
 * are never stored by the client.
 */

import { getAuthToken } from 'deepspace'
import type { LatLng } from './geo'
import type { DiscoveredCourt, GeocodedPlace } from './osm'

export interface NearbyCourtsResponse {
  courts: DiscoveredCourt[]
  count: number
  source: string
  attribution: string
  cached: boolean
}

export interface GeocodeResponse {
  results: GeocodedPlace[]
  cached: boolean
}

function isDiscoveredCourt(value: unknown): value is DiscoveredCourt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const c = value as Record<string, unknown>
  return (
    typeof c.id === 'string' &&
    typeof c.name === 'string' &&
    typeof c.lat === 'number' &&
    typeof c.lng === 'number' &&
    Number.isFinite(c.lat) &&
    Number.isFinite(c.lng)
  )
}

function isGeocodedPlace(value: unknown): value is GeocodedPlace {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const p = value as Record<string, unknown>
  return typeof p.displayName === 'string' && typeof p.lat === 'number' && typeof p.lng === 'number'
}

async function authedJson<T>(path: string, guard: (value: unknown) => value is T): Promise<T> {
  const token = await getAuthToken()
  if (!token) throw new Error('Sign in before searching for courts.')
  const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as Record<string, unknown>).error === 'string'
        ? (payload as Record<string, unknown>).error as string
        : 'Court search failed. Try again.'
    throw new Error(message)
  }
  if (!guard(payload)) throw new Error('Court search returned an unexpected response.')
  return payload
}

function isNearbyResponse(value: unknown): value is NearbyCourtsResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  return (
    Array.isArray(r.courts) &&
    r.courts.every(isDiscoveredCourt) &&
    typeof r.count === 'number' &&
    typeof r.attribution === 'string' &&
    typeof r.cached === 'boolean'
  )
}

function isGeocodeResponse(value: unknown): value is GeocodeResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  return Array.isArray(r.results) && r.results.every(isGeocodedPlace) && typeof r.cached === 'boolean'
}

export async function fetchNearbyCourts(center: LatLng, radiusKm: number): Promise<NearbyCourtsResponse> {
  const params = new URLSearchParams({
    lat: center.lat.toFixed(3),
    lng: center.lng.toFixed(3),
    radiusKm: String(radiusKm),
  })
  return authedJson(`/api/courts/nearby?${params}`, isNearbyResponse)
}

export async function searchPlaces(query: string): Promise<GeocodeResponse> {
  const params = new URLSearchParams({ q: query })
  return authedJson(`/api/geocode?${params}`, isGeocodeResponse)
}
