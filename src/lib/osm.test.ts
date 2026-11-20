import { describe, expect, it } from 'vitest'
import {
  buildNominatimUrl,
  buildOverpassQuery,
  normalizeCourtTags,
  OsmParseError,
  parseNominatimResponse,
  parseOverpassResponse,
} from './osm'

describe('buildOverpassQuery', () => {
  it('queries tennis pitches around a point with a metre radius', () => {
    const query = buildOverpassQuery({ lat: 40.44, lng: -79.95 }, 10)
    expect(query).toContain('[out:json][timeout:25]')
    expect(query).toContain('nwr["leisure"="pitch"]["sport"~"tennis"](around:10000,40.44,-79.95)')
    expect(query).toContain('out center;')
  })
})

describe('parseOverpassResponse', () => {
  const node = {
    type: 'node',
    id: 111,
    lat: 40.44,
    lon: -79.95,
    tags: { leisure: 'pitch', sport: 'tennis', name: 'Mellon Park Courts', surface: 'asphalt', lit: 'yes', access: 'public' },
  }
  const way = {
    type: 'way',
    id: 222,
    center: { lat: 40.45, lon: -79.96 },
    tags: { leisure: 'pitch', sport: 'tennis;basketball', name: 'Arsenal Park Courts', surface: 'clay' },
  }
  const unnamed = {
    type: 'node',
    id: 333,
    lat: 40.46,
    lon: -79.97,
    tags: { leisure: 'pitch', sport: 'tennis' },
  }

  it('parses nodes and ways (via center) with their tags', () => {
    const courts = parseOverpassResponse({ elements: [node, way, unnamed] })
    expect(courts).toHaveLength(3)
    expect(courts[0]).toMatchObject({
      id: 'osm:node/111',
      name: 'Mellon Park Courts',
      lat: 40.44,
      lng: -79.95,
      surface: 'asphalt',
      lights: 'lit',
      access: 'public',
      source: 'osm',
    })
    expect(courts[1]).toMatchObject({ id: 'osm:way/222', name: 'Arsenal Park Courts', lat: 40.45, lng: -79.96, surface: 'clay' })
    // No name tag: kept, with an honest fallback name, not dropped silently.
    expect(courts[2].name).toBe('Unnamed tennis court')
    // Untagged attributes are absent, never invented.
    expect(courts[2].surface).toBeUndefined()
    expect(courts[2].lights).toBeUndefined()
  })

  it('skips elements without usable coordinates and unknown types', () => {
    const courts = parseOverpassResponse({
      elements: [
        { type: 'way', id: 444, tags: { name: 'No center' } },
        { type: 'node', id: 555, lat: 200, lon: -79.9, tags: { name: 'Bad latitude' } },
        { type: 'area', id: 666, tags: { name: 'Not an element type we handle' } },
        node,
      ],
    })
    expect(courts).toHaveLength(1)
    expect(courts[0].id).toBe('osm:node/111')
  })

  it('de-duplicates the same OSM id', () => {
    const courts = parseOverpassResponse({ elements: [node, node] })
    expect(courts).toHaveLength(1)
  })

  it('throws on a non-object payload or a missing elements array', () => {
    expect(() => parseOverpassResponse(null)).toThrow(OsmParseError)
    expect(() => parseOverpassResponse('not json')).toThrow(OsmParseError)
    expect(() => parseOverpassResponse({})).toThrow(OsmParseError)
    expect(() => parseOverpassResponse({ elements: 'nope' })).toThrow(OsmParseError)
    // An upstream HTML error page parsed as text would arrive as a string.
    expect(() => parseOverpassResponse('<html>error</html>')).toThrow(OsmParseError)
  })

  it('returns an empty list (not an error) when nothing is found', () => {
    expect(parseOverpassResponse({ elements: [] })).toEqual([])
  })
})

describe('normalizeCourtTags', () => {
  it('only reports attributes the tags actually carry', () => {
    expect(normalizeCourtTags({ surface: 'grass', lit: 'no', access: 'private', indoor: 'yes', 'addr:city': 'Boston' })).toEqual({
      surface: 'grass',
      lights: 'unlit',
      access: 'private',
      indoor: true,
      locality: 'Boston',
    })
    expect(normalizeCourtTags({})).toEqual({})
    expect(normalizeCourtTags(undefined)).toEqual({})
  })

  it('ignores unexpected tag values instead of mapping them', () => {
    expect(normalizeCourtTags({ lit: 'maybe', indoor: 'sometimes' })).toEqual({})
  })
})

describe('parseNominatimResponse', () => {
  it('parses places and skips entries with bad coordinates', () => {
    const places = parseNominatimResponse([
      { display_name: 'Boston, Massachusetts, United States', lat: '42.3601', lon: '-71.0589' },
      { display_name: 'Nowhere', lat: 'not-a-number', lon: '0' },
      { display_name: '', lat: '42', lon: '-71' },
      { lat: '42', lon: '-71' },
    ])
    expect(places).toEqual([{ displayName: 'Boston, Massachusetts, United States', lat: 42.3601, lng: -71.0589 }])
  })

  it('throws when the payload is not an array', () => {
    expect(() => parseNominatimResponse({})).toThrow(OsmParseError)
    expect(() => parseNominatimResponse(null)).toThrow(OsmParseError)
  })
})

describe('buildNominatimUrl', () => {
  it('builds a capped, JSON-format search URL', () => {
    const url = new URL(buildNominatimUrl('Boston, MA', 99))
    expect(url.origin + url.pathname).toBe('https://nominatim.openstreetmap.org/search')
    expect(url.searchParams.get('q')).toBe('Boston, MA')
    expect(url.searchParams.get('format')).toBe('jsonv2')
    expect(url.searchParams.get('limit')).toBe('5')
  })
})
