import { isValidLatLng, type LatLng } from './geo.ts'

/** A selected public meeting place, not the player's current/private location. */
export interface RallyPlace extends LatLng {
  id: string
  name: string
  address: string
  source: 'osm' | 'nominatim' | 'featured'
}

export const MAX_COURT_PLACE_LENGTH = 1200

function boundedText(value: unknown, max: number, required = true): value is string {
  return typeof value === 'string' && value.length <= max && (!required || Boolean(value.trim())) && !/[\u0000-\u001f\u007f]/.test(value)
}

export function isRallyPlace(value: unknown): value is RallyPlace {
  if (!isValidLatLng(value) || Array.isArray(value)) return false
  const place = value as unknown as Record<string, unknown>
  return Object.keys(place).every(key => ['lat', 'lng', 'id', 'name', 'address', 'source'].includes(key)) &&
    boundedText(place.id, 200) && boundedText(place.name, 100) && boundedText(place.address, 400, false) &&
    typeof place.source === 'string' && ['osm', 'nominatim', 'featured'].includes(place.source) &&
    JSON.stringify(value).length <= MAX_COURT_PLACE_LENGTH
}

/** Missing, null and empty are the legacy text-only location representation. */
export function parseRallyPlace(value: unknown): RallyPlace | null {
  if (typeof value !== 'string' || !value || value.length > MAX_COURT_PLACE_LENGTH) return null
  try {
    const place: unknown = JSON.parse(value)
    if (!isRallyPlace(place)) return null
    return { lat: place.lat, lng: place.lng, id: place.id.trim(), name: place.name.trim(), address: place.address.trim(), source: place.source }
  } catch { return null }
}

export function serializeRallyPlace(place: RallyPlace): string {
  if (!isRallyPlace(place)) throw new Error('Choose a location with valid coordinates and place details.')
  return JSON.stringify({ lat: place.lat, lng: place.lng, id: place.id.trim(), name: place.name.trim(), address: place.address.trim(), source: place.source })
}

/** Null means malformed; '' means an intentionally text-only location. */
export function normalizeCourtPlace(value: unknown): string | null {
  if (value == null || value === '') return ''
  const place = parseRallyPlace(value)
  return place ? serializeRallyPlace(place) : null
}

export function googleMapsDirectionsUrl(place: LatLng): string | null {
  if (!isValidLatLng(place)) return null
  const url = new URL('https://www.google.com/maps/dir/')
  url.search = new URLSearchParams({ api: '1', destination: `${place.lat},${place.lng}` }).toString()
  return url.href
}

export interface RallyDetailsSnapshot {
  title: string
  notes: string
  court: string
  location: string
  courtPlace: string
}

export function getRallyDetails(session: Pick<RallyDetailsSnapshot, 'title' | 'court' | 'location'> & Partial<Pick<RallyDetailsSnapshot, 'notes' | 'courtPlace'>>): RallyDetailsSnapshot {
  return { title: session.title, court: session.court, location: session.location, notes: session.notes ?? '', courtPlace: normalizeCourtPlace(session.courtPlace) ?? '' }
}

export function validateRallyDetails(value: unknown): value is RallyDetailsSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const details = value as Record<string, unknown>
  return Object.keys(details).every(key => ['title', 'notes', 'court', 'location', 'courtPlace'].includes(key)) &&
    boundedText(details.title, 72) && typeof details.notes === 'string' && details.notes.length <= 400 &&
    boundedText(details.court, 100) && boundedText(details.location, 100) &&
    typeof details.courtPlace === 'string' && normalizeCourtPlace(details.courtPlace) !== null
}
