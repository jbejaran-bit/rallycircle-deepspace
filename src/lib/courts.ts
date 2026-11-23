/**
 * Featured Pittsburgh courts — unchanged data from the existing finder
 * (City of Pittsburgh "Courts and Rinks" dataset; RecDesk is the authority
 * for booking). Kept verbatim so the existing tab keeps working exactly as
 * before; general OpenStreetMap discovery is the default court finder.
 */

import { haversineMiles, type LatLng } from './geo'

export interface Court {
  id: string
  name: string
  area: string
  lat: number
  lng: number
  bookingUrl: string
  directCalendar?: boolean
}

const cityBooking = 'https://pittsburgh.recdesk.com/Community/Facility'

// Map pins use the City's Courts and Rinks dataset. Confirm current permits
// and schedules on RecDesk, which is the authority for booking.
export const courts: Court[] = [
  { id: 'schenley', name: 'Schenley Oval Tennis Courts', area: 'Schenley Park, Pittsburgh', lat: 40.43295667, lng: -79.94131769, bookingUrl: cityBooking },
  { id: 'highland', name: 'Highland Park Tennis Courts', area: 'Stanton Avenue, Pittsburgh', lat: 40.4746035, lng: -79.91066409, bookingUrl: 'https://pittsburgh.recdesk.com/Community/Facility/Reserve?facilityId=287&r=l', directCalendar: true },
  { id: 'frick', name: 'Frick Park Clay Courts', area: 'Regent Square, Pittsburgh', lat: 40.43734057, lng: -79.89754367, bookingUrl: cityBooking },
]

export function findCourt(id: string | null) {
  return courts.find(court => court.id === id)
}

export function distanceMiles(from: { lat: number; lng: number }, to: Court) {
  return haversineMiles(from, to)
}

/** Keep court cards and numbered map pins in the same display order. */
export function rankCourts(visibleCourts: Court[], location?: LatLng) {
  return visibleCourts.map(court => ({
    court,
    distance: location ? distanceMiles(location, court) : undefined,
  })).sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))
}

/** Match a session's court/location text against the known Pittsburgh courts. */
export function findKnownCourtForSession(courtName: string, location: string): Court | undefined {
  const haystack = `${courtName} ${location}`.trim().toLowerCase()
  if (!haystack) return undefined
  return courts.find(court => {
    const name = court.name.toLowerCase()
    // Match on a distinctive fragment: "Schenley", "Highland Park", "Frick Park".
    const fragment = name.replace(' tennis courts', '').replace(' oval', '').trim()
    return haystack.includes(fragment) || haystack.includes(name)
  })
}

export type { LatLng }

export function matchesCourt(court: Court, query: string): boolean {
  const searchable = `${court.name} ${court.area}`.toLocaleLowerCase('en-US')
  return query.trim().toLocaleLowerCase('en-US').split(/\s+/u).every(term => searchable.includes(term))
}
