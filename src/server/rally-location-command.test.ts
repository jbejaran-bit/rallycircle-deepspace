import { describe, expect, it } from 'vitest'
import { getRallyDetails, parseRallyPlace, serializeRallyPlace, type RallyPlace } from '../lib/rally-place'
import { createRaceHarness } from './race-harness'

const place: RallyPlace = { lat: 51.5072, lng: -0.1276, name: 'Public tennis courts', address: 'London, United Kingdom', id: 'osm:way/123', source: 'osm' }
function setup() {
  const harness = createRaceHarness()
  harness.addSession('rally', 'host')
  const expected = getRallyDetails(harness.readSession('rally')!)
  const details = { ...expected, title: 'London doubles', court: place.name, location: 'London', courtPlace: serializeRallyPlace(place) }
  return { harness, expected, details }
}

describe('serialized rally location editing', () => {
  it('updates text, place and notes together and reads the persisted coordinates back', async () => {
    const { harness, expected, details } = setup()
    await expect(harness.command('host', { operation: 'editDetails', sessionId: 'rally', expected, details })).resolves.toMatchObject({ success: true })
    const stored = harness.readSession('rally')!
    expect(getRallyDetails(stored)).toEqual(getRallyDetails(details))
    expect(parseRallyPlace(stored.courtPlace)).toEqual(place)
    expect(stored.hostId).toBe('host')
    expect(stored.startsAt).toBe('2031-01-01T12:00:00.000Z')
  })

  it('uses the verified caller and refuses another player even with a forged host id', async () => {
    const { harness, expected, details } = setup()
    await expect(harness.command('guest', { operation: 'editDetails', sessionId: 'rally', expected, details, userId: 'host' }))
      .resolves.toMatchObject({ success: false, error: 'Only the session host can edit these details.' })
    expect(getRallyDetails(harness.readSession('rally')!)).toEqual(expected)
  })

  it('rejects stale edits and serializes simultaneous edits against the same snapshot', async () => {
    const { harness, expected, details } = setup()
    const results = await Promise.all([
      harness.command('host', { operation: 'editDetails', sessionId: 'rally', expected, details }),
      harness.command('host', { operation: 'editDetails', sessionId: 'rally', expected, details: { ...details, title: 'Different draft' } }),
    ])
    expect(results.map(result => result.success)).toEqual([true, false])
    expect(harness.readSession('rally')?.title).toBe(details.title)
    expect(harness.readSession('rally')?.courtPlace).toBe(details.courtPlace)
  })

  it('accepts an exact retry after a lost acknowledgement without writing twice', async () => {
    const { harness, expected, details } = setup()
    await harness.command('host', { operation: 'editDetails', sessionId: 'rally', expected, details })
    const writes = harness.toolCallCount('records.update', 'sessions')
    await expect(harness.command('host', { operation: 'editDetails', sessionId: 'rally', expected, details })).resolves.toMatchObject({ success: true })
    expect(harness.toolCallCount('records.update', 'sessions')).toBe(writes)
  })

  it('keeps all previous fields when persistence rejects a write, and allows retry', async () => {
    const { harness, expected, details } = setup()
    harness.failTool('records.update', 'sessions')
    await expect(harness.command('host', { operation: 'editDetails', sessionId: 'rally', expected, details })).resolves.toMatchObject({ success: false })
    expect(getRallyDetails(harness.readSession('rally')!)).toEqual(expected)
    await expect(harness.command('host', { operation: 'editDetails', sessionId: 'rally', expected, details })).resolves.toMatchObject({ success: true })
  })

  it.each([{ lat: 91 }, { lng: -181 }, { id: '' }, { source: 'paid-provider' }])('rejects malformed coordinates or metadata: %j', patch => {
    const { harness, expected, details } = setup()
    return expect(harness.command('host', { operation: 'editDetails', sessionId: 'rally', expected,
      details: { ...details, courtPlace: JSON.stringify({ ...place, ...patch }) } })).resolves.toMatchObject({ success: false })
  })

  it('refuses a stale selected place when its court text is changed', async () => {
    const { harness, expected, details } = setup()
    await expect(harness.command('host', { operation: 'editDetails', sessionId: 'rally', expected,
      details: { ...details, court: 'Different court' } })).resolves.toMatchObject({ success: false })
    expect(getRallyDetails(harness.readSession('rally')!)).toEqual(expected)
  })

  it.each([{ status: 'cancelled' as const }, { matchScore: '{}' }])('prevents changing locations after cancellation or scoring: %j', patch => {
    const { harness, expected, details } = setup()
    harness.directUpdateSession('rally', patch)
    return expect(harness.command('host', { operation: 'editDetails', sessionId: 'rally', expected, details })).resolves.toMatchObject({ success: false })
  })

  it('supports adding a map to legacy rows and explicitly returning to text-only locations', async () => {
    const { harness, expected, details } = setup()
    expect(harness.readSession('rally')?.courtPlace).toBeUndefined()
    await harness.command('host', { operation: 'editDetails', sessionId: 'rally', expected, details })
    await expect(harness.command('host', { operation: 'editDetails', sessionId: 'rally', expected: details,
      details: { ...details, court: 'Old club court', location: 'A different city', courtPlace: '' } })).resolves.toMatchObject({ success: true })
    expect(harness.readSession('rally')?.courtPlace).toBe('')
    expect(harness.readSession('rally')?.court).toBe('Old club court')
  })
})
