/**
 * OpenStreetMap data handling for court discovery.
 *
 * Pure parsing only: these functions never fetch. The network calls live in
 * `src/server/court-discovery.ts` (server-side, authenticated, cached), so
 * the public Overpass/Nominatim endpoints are never hit directly from a
 * browser and never hit repeatedly without a cache.
 *
 * Tagging reality (see docs/COURTS_AND_GAMES_README.md): OpenStreetMap
 * coverage is volunteer-contributed and uneven. A court may have no name,
 * no surface, no lighting info, and no access tag. We show an attribute
 * ONLY when the source data actually carries it; everything else renders
 * as "Not listed" rather than inventing a value.
 */

import type { LatLng } from './geo'

export interface DiscoveredCourt {
  /** Stable client key, e.g. `osm:node/123456`. */
  id: string
  name: string
  lat: number
  lng: number
  /** Free-text locality from addr:* tags, when present (city/suburb/neighbourhood). */
  locality?: string
  /** OSM `surface` tag, e.g. `clay`, `asphalt`, `grass` — only when tagged. */
  surface?: string
  /** `lit=yes` → 'lit', `lit=no` → 'unlit'. Absent when untagged. */
  lights?: 'lit' | 'unlit'
  /** OSM `access` tag, e.g. `public`, `private`, `customers` — only when tagged. */
  access?: string
  /** `indoor=yes` → true, `indoor=no` → false. Absent when untagged. */
  indoor?: boolean
  source: 'osm'
  osmType: 'node' | 'way' | 'relation'
  osmId: number
}

export interface GeocodedPlace {
  displayName: string
  lat: number
  lng: number
}

export class OsmParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OsmParseError'
  }
}

export const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter'
export const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search'

/**
 * Overpass QL: tennis pitches around a point. `nwr` covers nodes, ways and
 * relations; `out center` gives ways/relations a representative coordinate
 * (nodes carry lat/lon directly). The `sport~"tennis"` regex also matches
 * multi-sport pitches such as `sport=tennis;basketball`.
 */
export function buildOverpassQuery(center: LatLng, radiusKm: number): string {
  const radiusM = Math.round(radiusKm * 1000)
  return (
    `[out:json][timeout:25];` +
    `(nwr["leisure"="pitch"]["sport"~"tennis"](around:${radiusM},${center.lat},${center.lng}););` +
    `out center;`
  )
}

interface OverpassElement {
  type?: unknown
  id?: unknown
  lat?: unknown
  lon?: unknown
  center?: { lat?: unknown; lon?: unknown }
  tags?: Record<string, unknown>
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asTag(tags: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = tags?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Keep only attributes the data actually supports; never guess a value. */
export function normalizeCourtTags(tags: Record<string, unknown> | undefined): Pick<
  DiscoveredCourt,
  'surface' | 'lights' | 'access' | 'indoor' | 'locality'
> {
  const surface = asTag(tags, 'surface')
  const lit = asTag(tags, 'lit')
  const lights = lit === 'yes' ? 'lit' : lit === 'no' ? 'unlit' : undefined
  const access = asTag(tags, 'access')
  const indoorTag = asTag(tags, 'indoor')
  const indoor = indoorTag === 'yes' ? true : indoorTag === 'no' ? false : undefined
  const locality =
    asTag(tags, 'addr:city') ?? asTag(tags, 'addr:suburb') ?? asTag(tags, 'addr:neighbourhood')
  return { ...(surface ? { surface } : {}), ...(lights ? { lights } : {}), ...(access ? { access } : {}), ...(indoor !== undefined ? { indoor } : {}), ...(locality ? { locality } : {}) }
}

function parseOverpassElement(element: OverpassElement): DiscoveredCourt | null {
  if (element.type !== 'node' && element.type !== 'way' && element.type !== 'relation') return null
  const id = asNumber(element.id)
  if (id === undefined) return null
  const lat = asNumber(element.lat) ?? asNumber(element.center?.lat)
  const lng = asNumber(element.lon) ?? asNumber(element.center?.lon)
  if (lat === undefined || lng === undefined || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null
  }
  const tags = element.tags
  const name = asTag(tags, 'name') ?? 'Unnamed tennis court'
  return {
    id: `osm:${element.type}/${id}`,
    name,
    lat,
    lng,
    ...normalizeCourtTags(tags),
    source: 'osm',
    osmType: element.type,
    osmId: id,
  }
}

/**
 * Parse an Overpass JSON response. Throws OsmParseError when the payload is
 * not an object or has no `elements` array (e.g. an upstream error page or
 * a truncated body). Individual malformed elements are skipped, not fatal:
 * one bad court must not hide the rest. Duplicates (same OSM id twice) are
 * de-duplicated, first occurrence wins.
 */
export function parseOverpassResponse(payload: unknown): DiscoveredCourt[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new OsmParseError('Overpass response is not a JSON object.')
  }
  const elements = (payload as { elements?: unknown }).elements
  if (!Array.isArray(elements)) {
    throw new OsmParseError('Overpass response has no elements array.')
  }
  const seen = new Set<string>()
  const courts: DiscoveredCourt[] = []
  for (const raw of elements) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const court = parseOverpassElement(raw as OverpassElement)
    if (court && !seen.has(court.id)) {
      seen.add(court.id)
      courts.push(court)
    }
  }
  return courts
}

/**
 * Parse a Nominatim `/search` JSON response (array of places). Throws
 * OsmParseError when the payload is not an array. Entries with unparseable
 * coordinates are skipped. Callers cap the count; this parser does not
 * invent results beyond what the service returned.
 */
export function parseNominatimResponse(payload: unknown): GeocodedPlace[] {
  if (!Array.isArray(payload)) {
    throw new OsmParseError('Nominatim response is not a JSON array.')
  }
  const places: GeocodedPlace[] = []
  for (const raw of payload) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const entry = raw as { display_name?: unknown; lat?: unknown; lon?: unknown }
    const displayName = typeof entry.display_name === 'string' ? entry.display_name.trim() : ''
    const lat = typeof entry.lat === 'string' ? Number(entry.lat) : asNumber(entry.lat)
    const lng = typeof entry.lon === 'string' ? Number(entry.lon) : asNumber(entry.lon)
    if (!displayName || lat === undefined || lng === undefined) continue
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue
    places.push({ displayName, lat, lng })
  }
  return places
}

/** Nominatim search URL (server-side use). `limit` is capped at 5 by callers. */
export function buildNominatimUrl(query: string, limit = 5): string {
  const url = new URL(NOMINATIM_ENDPOINT)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('limit', String(Math.min(5, Math.max(1, Math.round(limit)))))
  url.searchParams.set('addressdetails', '0')
  return url.toString()
}
