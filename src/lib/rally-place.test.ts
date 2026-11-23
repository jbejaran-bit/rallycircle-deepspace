import { describe, expect, it } from 'vitest'
import { getRallyDetails, googleMapsDirectionsUrl, isRallyPlace, normalizeCourtPlace, parseRallyPlace, serializeRallyPlace, validateRallyDetails, type RallyPlace } from './rally-place'
import { validateSession } from './rally'
import { checkFieldPermissions } from 'deepspace/worker'
import { sessionsSchema } from '../schemas/rally-schema'

const place: RallyPlace = { lat: 40.4321, lng: -79.9432, id: 'osm:node/123', source: 'osm', name: 'Public tennis courts', address: 'Schenley Drive, Pittsburgh, PA' }
const details = { title: 'Saturday doubles', notes: '', court: place.name, location: 'Pittsburgh, PA', courtPlace: serializeRallyPlace(place) }

describe('selected rally places', () => {
  it('round trips a validated place and encodes coordinates as a Google Maps destination', () => {
    expect(parseRallyPlace(serializeRallyPlace(place))).toEqual(place)
    const url = new URL(googleMapsDirectionsUrl(place)!)
    expect(url.origin).toBe('https://www.google.com')
    expect(url.pathname).toBe('/maps/dir/')
    expect(url.searchParams.get('api')).toBe('1')
    expect(url.searchParams.get('destination')).toBe('40.4321,-79.9432')
    expect(url.searchParams.has('query')).toBe(false)
  })

  it.each([undefined, null, ''])('keeps a missing or empty legacy place text-only: %s', value => {
    expect(parseRallyPlace(value)).toBeNull()
    expect(normalizeCourtPlace(value)).toBe('')
  })

  it.each([
    { lat: 91 }, { lng: -181 }, { lat: NaN }, { lng: Infinity }, { lat: '40.4' },
    { name: '' }, { address: 'a'.repeat(401) }, { id: 'x'.repeat(201) }, { source: 'google' },
    { name: 'Court\nInjected' }, { unknown: 'ignored?' },
    { id: '\\'.repeat(200), name: '\\'.repeat(100), address: '\\'.repeat(400) },
  ])('rejects malformed places before serialization: %j', patch => {
    const invalid = { ...place, ...patch }
    expect(isRallyPlace(invalid)).toBe(false)
    expect(parseRallyPlace(JSON.stringify(invalid))).toBeNull()
    expect(() => serializeRallyPlace(invalid as RallyPlace)).toThrow()
  })

  it.each(['not json', 'null', '[]', '{}', 'x'.repeat(1201)])('rejects invalid stored JSON: %s', value => {
    expect(normalizeCourtPlace(value)).toBeNull()
    expect(parseRallyPlace(value)).toBeNull()
  })

  it('preserves zero coordinates and rejects invalid directions coordinates', () => {
    const zero = { ...place, lat: 0, lng: 0 }
    expect(parseRallyPlace(serializeRallyPlace(zero))).toMatchObject({ lat: 0, lng: 0 })
    expect(new URL(googleMapsDirectionsUrl(zero)!).searchParams.get('destination')).toBe('0,0')
    expect(googleMapsDirectionsUrl({ lat: 40, lng: NaN })).toBeNull()
    expect(googleMapsDirectionsUrl({ lat: 180, lng: 40 })).toBeNull()
  })

  it('normalizes equivalent JSON key ordering for retry and conflict comparisons', () => {
    expect(normalizeCourtPlace(JSON.stringify({ source: 'osm', name: place.name, address: place.address, id: place.id, lng: place.lng, lat: place.lat })))
      .toBe(serializeRallyPlace(place))
    expect(getRallyDetails({ ...details, courtPlace: undefined })).toMatchObject({ courtPlace: '' })
  })

  it('validates details without requiring a scheduled date, and preserves legacy text', () => {
    expect(validateRallyDetails(details)).toBe(true)
    expect(validateRallyDetails({ ...details, courtPlace: '' })).toBe(true)
    expect(validateRallyDetails({ ...details, court: '' })).toBe(false)
    expect(validateRallyDetails({ ...details, courtPlace: '{bad' })).toBe(false)
    expect(validateRallyDetails({ ...details, hostId: 'spoof' })).toBe(false)
  })

  it('rejects a selected coordinate when its court name has changed', () => {
    const draft = { ...details, format: 'Doubles' as const, startsAt: '2031-06-15T14:00:00Z', durationMinutes: 90, targetPlayers: 4, level: 'All levels' as const }
    expect(validateSession(draft, Date.parse('2030-01-01T00:00:00Z'))).toBeNull()
    expect(validateSession({ ...draft, court: 'A different place' }, Date.parse('2030-01-01T00:00:00Z'))).toContain('Select the court again')
  })

  it('adds an optional bounded field and protects the coordinate/text tuple from direct client writes', () => {
    expect(sessionsSchema.columns.find(column => column.name === 'courtPlace')).toMatchObject({ storage: 'text', default: '', maxLength: 1200 })
    expect(sessionsSchema.columns.find(column => column.name === 'courtPlace')?.required).not.toBe(true)
    for (const role of ['member', 'admin']) {
      expect(checkFieldPermissions(sessionsSchema, role, { courtPlace: details.courtPlace })).not.toBeNull()
      expect(checkFieldPermissions(sessionsSchema, role, { court: 'Other court', location: 'City' })).not.toBeNull()
      expect(checkFieldPermissions(sessionsSchema, role, { title: 'Updated title', notes: 'Bring balls' })).toBeNull()
    }
  })
})
