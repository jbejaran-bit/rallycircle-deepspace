import { describe, expect, it } from 'vitest'
import { combinePlaceChoices, placeArea, placeFromCourt, placeFromGeocoder, placePrefill } from './rally-place-selection'
import { parseRallyPlace } from './rally-place'

describe('location selections', () => {
  it('keeps geocoded public place coordinates and bounds long labels', () => {
    const value = placeFromGeocoder({ id: 'osm:way/1', displayName: `Court One, ${'City '.repeat(100)}`, lat: -33.8688, lng: 151.2093 })!
    expect(value).toMatchObject({ name: 'Court One', lat: -33.8688, lng: 151.2093, source: 'nominatim' })
    expect(value.address.length).toBe(400)
    expect(placeArea(value).startsWith('City')).toBe(true)
  })
  it('rejects out-of-range geocoded coordinates', () => {
    expect(placeFromGeocoder({ displayName: 'Bad result', lat: 91, lng: 0 })).toBeNull()
    expect(placeFromGeocoder({ displayName: 'Bad result', lat: 0, lng: NaN })).toBeNull()
  })
  it('keeps a tennis court identity and coordinates with locality or search context', () => {
    expect(placeFromCourt({ id: 'osm:way/2', name: 'Boston courts', lat: 42.35, lng: -71.06, locality: 'Boston', source: 'osm', osmId: 2, osmType: 'way' }, 'Search area')).toMatchObject({ id: 'osm:way/2', address: 'Boston', source: 'osm' })
  })
  it('deduplicates the same searched and nearby OSM court without changing its map number', () => {
    const searched = placeFromGeocoder({ id: 'osm:way/2', displayName: 'Boston Tennis Venue, Boston', lat: 42.35, lng: -71.06 })!
    const matchedCourt = placeFromCourt({ id: 'osm:way/2', name: 'Boston courts', lat: 42.3500123, lng: -71.0600456, locality: 'Boston', source: 'osm', osmId: 2, osmType: 'way' }, 'Search area')!
    const otherCourt = { ...matchedCourt, id: 'osm:way/3', name: 'Second court' }
    const choices = combinePlaceChoices(searched, [matchedCourt, otherCourt, matchedCourt])
    expect(choices).toEqual([matchedCourt, otherCourt])
    expect(choices[0]).toBe(matchedCourt)
    expect(choices[0]).toMatchObject({ name: 'Boston courts', lat: 42.3500123, lng: -71.0600456, source: 'osm' })
  })
  it('accepts a validated discovery URL without rounding its chosen point', () => {
    const params = new URLSearchParams({ lat: '42.3541234', lng: '-71.0649876', courtName: 'Common courts', courtArea: 'Boston', address: 'Boston, Massachusetts', placeId: 'osm:way/3', placeSource: 'osm' })
    expect(parseRallyPlace(placePrefill(params))).toMatchObject({ lat: 42.3541234, lng: -71.0649876, name: 'Common courts', address: 'Boston, Massachusetts' })
  })
  it.each([{ lat: '', lng: '-71' }, { lat: '42', lng: '' }, { lat: '100', lng: '-71' }, { lat: '0', lng: '181' }, { lat: 'NaN', lng: '0' }, { lat: '42', lng: '-71', placeSource: 'google' }])('drops invalid query pins and preserves the text-only path: %j', changes => {
    expect(placePrefill(new URLSearchParams({ courtName: 'Court', courtArea: 'City', placeSource: 'osm', placeId: 'one', ...changes }))).toBe('')
  })
  it('retains the legacy featured-court URL with trusted catalog coordinates', () => {
    expect(parseRallyPlace(placePrefill(new URLSearchParams(), { id: 'featured', name: 'Court', area: 'City', lat: 40, lng: -79 }))).toMatchObject({ source: 'featured', lat: 40, lng: -79 })
  })
})
