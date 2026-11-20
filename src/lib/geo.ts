/**
 * Geography helpers for court discovery and Find Games.
 *
 * Pure functions only — no network, no geolocation, no storage — so they
 * are unit-testable without a browser or a live API. Distances are
 * straight-line (great-circle) distances, never road distances; the UI must
 * say so wherever a distance is shown.
 */

export interface LatLng {
  lat: number
  lng: number
}

export const EARTH_RADIUS_MILES = 3958.8
export const KM_PER_MILE = 1.609344

/** Radius choices offered in the UI, in kilometres (Overpass `around:`). */
export const RADIUS_OPTIONS_KM = [5, 10, 25, 50] as const
export const DEFAULT_RADIUS_KM = 10
export const MIN_RADIUS_KM = 1
export const MAX_RADIUS_KM = 50

export function isValidLatLng(value: unknown): value is LatLng {
  if (typeof value !== 'object' || value === null) return false
  const { lat, lng } = value as { lat?: unknown; lng?: unknown }
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  )
}

/** Great-circle distance in miles. Returns NaN-free 0 for identical points. */
export function haversineMiles(from: LatLng, to: LatLng): number {
  const radians = Math.PI / 180
  const dLat = (to.lat - from.lat) * radians
  const dLng = (to.lng - from.lng) * radians
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(from.lat * radians) * Math.cos(to.lat * radians) * Math.sin(dLng / 2) ** 2
  return EARTH_RADIUS_MILES * 2 * Math.asin(Math.sqrt(Math.min(a, 1)))
}

export function milesToKm(miles: number): number {
  return miles * KM_PER_MILE
}

export function kmToMiles(km: number): number {
  return km / KM_PER_MILE
}

/** Clamp a user-supplied radius to the supported range; fall back on garbage. */
export function clampRadiusKm(value: unknown, fallback = DEFAULT_RADIUS_KM): number {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.min(MAX_RADIUS_KM, Math.max(MIN_RADIUS_KM, Math.round(n)))
}

/** One decimal in miles, e.g. "3.3 mi". Distances are straight-line. */
export function formatDistanceMiles(miles: number): string {
  if (!Number.isFinite(miles) || miles < 0) return '—'
  return `${miles.toFixed(1)} mi`
}

/** Normalise free-text place/court names for matching (case + whitespace). */
export function normalizePlaceName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Case-insensitive substring match used by the area filter. */
export function matchesArea(haystack: string, needle: string): boolean {
  const query = normalizePlaceName(needle)
  if (!query) return true
  return normalizePlaceName(haystack).includes(query)
}
