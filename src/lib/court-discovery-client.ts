/**
 * Client for the server-side court discovery adapter (`/api/courts/nearby`
 * and `/api/geocode`).
 *
 * The browser never talks to Overpass or Nominatim directly: coordinates
 * go to RallyCircle's own worker (authenticated with the SDK token), which
 * proxies, caches, and paces the upstream calls. Search-area coordinates
 * stay ephemeral. A public venue pin explicitly selected in a rally form
 * is saved with that rally by the separate create/edit command.
 */

import { getAuthToken } from 'deepspace'
import type { LatLng } from './geo'
import { isValidLatLng } from './geo'
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
    isValidLatLng(c)
  )
}

function isGeocodedPlace(value: unknown): value is GeocodedPlace {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const p = value as Record<string, unknown>
  return typeof p.displayName === 'string' && isValidLatLng(p)
}

async function authedJson<T>(path: string, guard: (value: unknown) => value is T, signal?: AbortSignal): Promise<T> {
  const token = await getAuthToken()
  if (!token) throw new Error('Sign in before searching for courts.')
  signal?.throwIfAborted()
  const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, signal })
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

export async function fetchNearbyCourts(center: LatLng, radiusKm: number, signal?: AbortSignal): Promise<NearbyCourtsResponse> {
  const params = new URLSearchParams({
    lat: center.lat.toFixed(3),
    lng: center.lng.toFixed(3),
    radiusKm: String(radiusKm),
  })
  return authedJson(`/api/courts/nearby?${params}`, isNearbyResponse, signal)
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<GeocodeResponse> {
  const params = new URLSearchParams({ q: query })
  return authedJson(`/api/geocode?${params}`, isGeocodeResponse, signal)
}
