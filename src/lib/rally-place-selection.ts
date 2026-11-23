import { isValidLatLng } from './geo'
import type { DiscoveredCourt, GeocodedPlace } from './osm'
import { isRallyPlace, serializeRallyPlace, type RallyPlace } from './rally-place'

const clean = (value: string, max: number) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)

export function placeFromGeocoder(place: GeocodedPlace): RallyPlace | null {
  if (!isValidLatLng(place)) return null
  const address = clean(place.displayName, 400)
  const value: RallyPlace = { lat: place.lat, lng: place.lng, name: clean(address.split(',')[0], 100), address,
    id: clean(place.id || `nominatim:${place.lat},${place.lng}`, 200), source: 'nominatim' }
  return isRallyPlace(value) ? value : null
}

export function placeFromCourt(court: DiscoveredCourt, fallbackAddress: string): RallyPlace | null {
  const value: RallyPlace = { lat: court.lat, lng: court.lng, name: clean(court.name, 100), address: clean(court.locality || fallbackAddress, 400), id: clean(court.id, 200), source: 'osm' }
  return isRallyPlace(value) ? value : null
}

/** A geocoded tennis court can also be the first nearby OSM result. */
export function combinePlaceChoices(origin: RallyPlace, courts: readonly RallyPlace[]): RallyPlace[] {
  const choices = new Map<string, RallyPlace>([[origin.id, origin]])
  // Prefer court metadata for the same feature, retaining its original slot.
  for (const court of courts) choices.set(court.id, court)
  return [...choices.values()]
}

export function placeArea(place: RallyPlace): string {
  const parts = place.address.split(',').map(part => part.trim()).filter(Boolean)
  if (parts[0]?.toLowerCase() === place.name.toLowerCase() && parts.length > 1) parts.shift()
  return (parts.join(', ') || place.name).slice(0, 100)
}

/** Discovery URLs are untrusted input; invalid pins fall back to legacy text. */
export function placePrefill(params: URLSearchParams, featured?: { id: string; name: string; area: string; lat: number; lng: number }): string {
  if (featured) return serializeRallyPlace({ id: featured.id, name: featured.name, address: featured.area, lat: featured.lat, lng: featured.lng, source: 'featured' })
  const rawLat = params.get('lat'), rawLng = params.get('lng')
  if (!rawLat?.trim() || !rawLng?.trim()) return ''
  const value = { lat: Number(rawLat), lng: Number(rawLng), name: params.get('courtName')?.trim(),
    address: (params.get('address') ?? params.get('courtArea') ?? '').trim(), id: params.get('placeId')?.trim(), source: params.get('placeSource') }
  return isRallyPlace(value) ? serializeRallyPlace(value) : ''
}
