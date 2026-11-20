import assert from 'node:assert/strict'
import test from 'node:test'
import { haversineMiles, clampRadiusKm, isValidLatLng } from '../src/lib/geo.ts'
import { parseOverpassResponse, parseNominatimResponse, buildOverpassQuery } from '../src/lib/osm.ts'
import { filterGames } from '../src/lib/find-games.ts'

const NOW = Date.parse('2026-11-20T12:00:00Z')
const schenley = { lat: 40.43295667, lng: -79.94131769 }
const highland = { lat: 40.4746035, lng: -79.91066409 }

test('distance: Schenley to Highland Park is about 3.3 miles', () => {
  assert.ok(Math.abs(haversineMiles(schenley, highland) - 3.3) < 0.1)
})

test('distance: identical points are zero and bad coordinates are rejected', () => {
  assert.equal(haversineMiles(schenley, schenley), 0)
  assert.equal(isValidLatLng({ lat: 91, lng: 0 }), false)
  assert.equal(isValidLatLng(schenley), true)
})

test('radius: out-of-range values clamp, garbage falls back to 10 km', () => {
  assert.equal(clampRadiusKm(500), 50)
  assert.equal(clampRadiusKm(0), 1)
  assert.equal(clampRadiusKm('nope'), 10)
})

test('overpass: query targets tennis pitches around the point', () => {
  const query = buildOverpassQuery({ lat: 40.44, lng: -79.95 }, 10)
  assert.match(query, /around:10000,40\.44,-79\.95/)
  assert.match(query, /out center;/)
})

test('overpass: malformed responses throw, empty results are an empty list', () => {
  assert.throws(() => parseOverpassResponse(null))
  assert.throws(() => parseOverpassResponse({}))
  assert.deepEqual(parseOverpassResponse({ elements: [] }), [])
})

test('overpass: nodes and ways parse; elements without coordinates are skipped', () => {
  const courts = parseOverpassResponse({
    elements: [
      { type: 'node', id: 1, lat: 40.44, lon: -79.95, tags: { name: 'Mellon Park', surface: 'clay', lit: 'no' } },
      { type: 'way', id: 2, center: { lat: 40.45, lon: -79.96 }, tags: { name: 'Arsenal Park' } },
      { type: 'way', id: 3, tags: { name: 'No coordinates' } },
    ],
  })
  assert.equal(courts.length, 2)
  assert.equal(courts[0].name, 'Mellon Park')
  assert.equal(courts[0].surface, 'clay')
  assert.equal(courts[0].lights, 'unlit')
  assert.equal(courts[1].id, 'osm:way/2')
})

test('nominatim: places parse and bad entries are skipped', () => {
  const places = parseNominatimResponse([
    { display_name: 'Boston, MA', lat: '42.3601', lon: '-71.0589' },
    { display_name: 'Bad', lat: 'oops', lon: '0' },
  ])
  assert.deepEqual(places, [{ displayName: 'Boston, MA', lat: 42.3601, lng: -71.0589 }])
})

const sessions = [
  { recordId: 'a', data: { title: 'Doubles', court: 'Schenley Park', location: 'Pittsburgh, PA', startsAt: new Date(NOW + 86400_000).toISOString(), durationMinutes: 90, targetPlayers: 4, level: 'Intermediate', notes: '', hostId: 'h1', chatChannelId: '', status: 'open' } },
  { recordId: 'b', data: { title: 'Singles', court: 'Highland Park', location: 'Pittsburgh, PA', startsAt: new Date(NOW + 2 * 86400_000).toISOString(), durationMinutes: 90, targetPlayers: 2, level: 'Beginner', notes: '', hostId: 'h2', chatChannelId: '', status: 'open' } },
  { recordId: 'c', data: { title: 'Old', court: 'Schenley Park', location: 'Pittsburgh, PA', startsAt: new Date(NOW - 86400_000).toISOString(), durationMinutes: 90, targetPlayers: 4, level: 'Intermediate', notes: '', hostId: 'h1', chatChannelId: '', status: 'open' } },
  { recordId: 'd', data: { title: 'Cancelled', court: 'Schenley Park', location: 'Pittsburgh, PA', startsAt: new Date(NOW + 86400_000).toISOString(), durationMinutes: 90, targetPlayers: 4, level: 'Intermediate', notes: '', hostId: 'h1', chatChannelId: '', status: 'cancelled' } },
]

test('find games: past and cancelled sessions are excluded by default', () => {
  const ids = filterGames(sessions, [], {}, { now: NOW }).map(g => g.recordId)
  assert.deepEqual(ids, ['a', 'b'])
})

test('find games: filters combine (level + format + area)', () => {
  const ids = filterGames(sessions, [], { level: 'Beginner', format: 'singles', area: 'highland' }, { now: NOW }).map(g => g.recordId)
  assert.deepEqual(ids, ['b'])
})

test('find games: distance only applies where court coordinates are known', () => {
  const knownCourts = [
    { name: 'Schenley Oval Tennis Courts', lat: schenley.lat, lng: schenley.lng },
    { name: 'Highland Park Tennis Courts', lat: highland.lat, lng: highland.lng },
  ]
  const games = filterGames(sessions, [], { maxDistanceMiles: 1 }, { now: NOW, userLocation: schenley, knownCourts })
  assert.deepEqual(games.map(g => g.recordId), ['a'])
  assert.ok(games[0].distanceMiles !== null && games[0].distanceMiles < 0.01)
})
