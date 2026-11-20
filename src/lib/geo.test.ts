import { describe, expect, it } from 'vitest'
import {
  clampRadiusKm,
  formatDistanceMiles,
  haversineMiles,
  isValidLatLng,
  kmToMiles,
  matchesArea,
  milesToKm,
} from './geo'

// Known reference points (OpenStreetMap coordinates from the Pittsburgh finder).
const SCHENLEY = { lat: 40.43295667, lng: -79.94131769 }
const HIGHLAND = { lat: 40.4746035, lng: -79.91066409 }
const FRICK = { lat: 40.43734057, lng: -79.89754367 }

describe('haversineMiles', () => {
  it('is zero for identical points', () => {
    expect(haversineMiles(SCHENLEY, SCHENLEY)).toBe(0)
  })

  it('measures Schenley to Highland Park at about 3.3 miles', () => {
    // Independent check: ~5.3 km apart across the city.
    expect(haversineMiles(SCHENLEY, HIGHLAND)).toBeCloseTo(3.3, 1)
  })

  it('measures Schenley to Frick Park at about 2.3 miles', () => {
    expect(haversineMiles(SCHENLEY, FRICK)).toBeCloseTo(2.3, 1)
  })

  it('is symmetric', () => {
    expect(haversineMiles(HIGHLAND, SCHENLEY)).toBeCloseTo(haversineMiles(SCHENLEY, HIGHLAND), 10)
  })

  it('measures New York to Los Angeles at about 2,445 miles', () => {
    const nyc = { lat: 40.7128, lng: -74.006 }
    const la = { lat: 34.0522, lng: -118.2437 }
    expect(haversineMiles(nyc, la)).toBeCloseTo(2445, -1)
  })

  it('is near half the circumference for antipodal points', () => {
    expect(haversineMiles({ lat: 0, lng: 0 }, { lat: 0, lng: 180 })).toBeCloseTo(12436, -2)
  })
})

describe('isValidLatLng', () => {
  it('accepts the poles and the antimeridian', () => {
    expect(isValidLatLng({ lat: 90, lng: 180 })).toBe(true)
    expect(isValidLatLng({ lat: -90, lng: -180 })).toBe(true)
  })

  it('rejects out-of-range, non-finite, and non-numeric coordinates', () => {
    expect(isValidLatLng({ lat: 91, lng: 0 })).toBe(false)
    expect(isValidLatLng({ lat: 0, lng: 181 })).toBe(false)
    expect(isValidLatLng({ lat: Number.NaN, lng: 0 })).toBe(false)
    expect(isValidLatLng({ lat: '40', lng: 0 })).toBe(false)
    expect(isValidLatLng(null)).toBe(false)
    expect(isValidLatLng('Pittsburgh')).toBe(false)
  })
})

describe('clampRadiusKm', () => {
  it('keeps valid radii and clamps the extremes', () => {
    expect(clampRadiusKm(10)).toBe(10)
    expect(clampRadiusKm(0)).toBe(1)
    expect(clampRadiusKm(500)).toBe(50)
    expect(clampRadiusKm('25')).toBe(25)
  })

  it('falls back on garbage input', () => {
    expect(clampRadiusKm('far')).toBe(10)
    expect(clampRadiusKm(undefined)).toBe(10)
    expect(clampRadiusKm(Number.NaN)).toBe(10)
  })
})

describe('unit conversion and formatting', () => {
  it('converts miles and kilometres consistently', () => {
    expect(milesToKm(10)).toBeCloseTo(16.09344, 4)
    expect(kmToMiles(10)).toBeCloseTo(6.2137, 4)
  })

  it('formats distances to one decimal and guards bad input', () => {
    expect(formatDistanceMiles(3.27)).toBe('3.3 mi')
    expect(formatDistanceMiles(Number.NaN)).toBe('—')
    expect(formatDistanceMiles(-1)).toBe('—')
  })
})

describe('matchesArea', () => {
  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(matchesArea('Schenley Park, Pittsburgh', '  SCHENLEY ')).toBe(true)
    expect(matchesArea('Schenley Park, Pittsburgh', 'oakland')).toBe(false)
  })

  it('treats an empty query as matching everything', () => {
    expect(matchesArea('Anywhere', '')).toBe(true)
    expect(matchesArea('Anywhere', '   ')).toBe(true)
  })
})
