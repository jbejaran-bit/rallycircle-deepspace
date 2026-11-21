import { describe, expect, it } from 'vitest'
import { discoveryAction, filterGames, gameStatusLabel, type KnownCourtLocation } from './find-games'
import type { RallyRSVP, RallySession } from './rally'

const NOW = Date.parse('2026-11-20T12:00:00Z')
const SCHENLEY: KnownCourtLocation = { name: 'Schenley Oval Tennis Courts', lat: 40.43295667, lng: -79.94131769 }
const HIGHLAND: KnownCourtLocation = { name: 'Highland Park Tennis Courts', lat: 40.4746035, lng: -79.91066409 }

function session(overrides: Partial<RallySession> & { recordId: string }): { recordId: string; data: RallySession } {
  const { recordId, ...rest } = overrides
  return {
    recordId,
    data: {
      title: 'Session',
      court: 'Schenley Park',
      location: 'Pittsburgh, PA',
      startsAt: new Date(NOW + 86400_000).toISOString(),
      durationMinutes: 90,
      targetPlayers: 4,
      level: 'Intermediate',
      notes: '',
      hostId: 'host-1',
      chatChannelId: '',
      status: 'open',
      ...rest,
    },
  }
}

const sessions = [
  session({ recordId: 's1', title: 'Sunday doubles', court: 'Schenley Park', level: 'Intermediate', targetPlayers: 4 }),
  session({ recordId: 's2', title: 'Singles ladder', court: 'Highland Park', location: 'Pittsburgh, PA', level: 'Beginner', targetPlayers: 2, startsAt: new Date(NOW + 2 * 86400_000).toISOString() }),
  session({ recordId: 's3', title: 'Advanced hit', court: 'Community courts', location: 'Oakland', level: 'Advanced', targetPlayers: 4, startsAt: new Date(NOW + 3 * 86400_000).toISOString() }),
  session({ recordId: 's4', title: 'Cancelled doubles', status: 'cancelled' }),
  session({ recordId: 's5', title: 'Yesterday hit', startsAt: new Date(NOW - 86400_000).toISOString() }),
  session({ recordId: 's6', title: 'Full house', court: 'Riverside Courts', location: 'Lawrenceville', targetPlayers: 2, startsAt: new Date(NOW + 4 * 86400_000).toISOString() }),
]

const rsvps: RallyRSVP[] = [
  { sessionId: 's1', userId: 'u1', status: 'going' },
  { sessionId: 's1', userId: 'u2', status: 'going' },
  { sessionId: 's1', userId: 'u3', status: 'maybe' },
  { sessionId: 's6', userId: 'u1', status: 'going' },
  { sessionId: 's6', userId: 'u2', status: 'going' },
]

const baseOpts = { now: NOW, knownCourts: [SCHENLEY, HIGHLAND] }

describe('filterGames defaults', () => {
  it('excludes cancelled and past sessions by default', () => {
    const ids = filterGames(sessions, rsvps, {}, baseOpts).map(g => g.recordId)
    expect(ids).toEqual(['s1', 's2', 's3', 's6'])
  })

  it('includes cancelled and past sessions when explicitly requested', () => {
    const ids = filterGames(sessions, rsvps, { showCancelled: true, showPast: true }, baseOpts).map(g => g.recordId)
    expect(ids).toContain('s4')
    expect(ids).toContain('s5')
  })

  it('sorts by start time', () => {
    const ids = filterGames(sessions, rsvps, {}, baseOpts).map(g => g.recordId)
    expect(ids).toEqual(['s1', 's2', 's3', 's6'])
  })

  it('excludes unparseable start times even when showing past games or filtering by date', () => {
    const invalid = session({ recordId: 'invalid', startsAt: 'not-a-date' })
    const valid = session({ recordId: 'valid' })
    const rows = [invalid, valid]
    const ids = (filters: Parameters<typeof filterGames>[2]) =>
      filterGames(rows, [], filters, baseOpts).map(game => game.recordId)

    expect(ids({})).toEqual(['valid'])
    expect(ids({ showPast: true, showCancelled: true })).toEqual(['valid'])
    expect(ids({ fromDate: '2026-11-20', toDate: '2026-11-23' })).toEqual(['valid'])
    expect(ids({ availability: 'spots' })).toEqual(['valid'])
  })


  it('annotates attendance and target status', () => {
    const games = filterGames(sessions, rsvps, {}, baseOpts)
    const s1 = games.find(g => g.recordId === 's1')
    expect(s1?.going).toBe(2)
    expect(s1?.maybe).toBe(1)
    expect(s1?.status).toBe('needs-players')
    expect(gameStatusLabel(s1!)).toBe('Needs players')
    const s6 = games.find(g => g.recordId === 's6')
    expect(s6?.status).toBe('target-reached')
    expect(gameStatusLabel(s6!)).toBe('Target reached')
  })
})

describe('filterGames filters', () => {
  it('filters by area across court and location text', () => {
    expect(filterGames(sessions, rsvps, { area: 'oakland' }, baseOpts).map(g => g.recordId)).toEqual(['s3'])
    expect(filterGames(sessions, rsvps, { area: 'highland' }, baseOpts).map(g => g.recordId)).toEqual(['s2'])
  })

  it('filters by skill level', () => {
    expect(filterGames(sessions, rsvps, { level: 'Beginner' }, baseOpts).map(g => g.recordId)).toEqual(['s2'])
    expect(filterGames(sessions, rsvps, { level: 'Any level' }, baseOpts)).toHaveLength(4)
  })

  it('filters singles vs doubles by target players', () => {
    expect(filterGames(sessions, rsvps, { format: 'singles' }, baseOpts).map(g => g.recordId)).toEqual(['s2', 's6'])
    expect(filterGames(sessions, rsvps, { format: 'doubles' }, baseOpts).map(g => g.recordId)).toEqual(['s1', 's3'])
  })

  it('filters by date range inclusively', () => {
    const from = new Date(NOW + 2 * 86400_000).toISOString().slice(0, 10)
    const to = new Date(NOW + 3 * 86400_000).toISOString().slice(0, 10)
    expect(filterGames(sessions, rsvps, { fromDate: from, toDate: to }, baseOpts).map(g => g.recordId)).toEqual(['s2', 's3'])
  })

  it('combines filters', () => {
    const games = filterGames(
      sessions,
      rsvps,
      { area: 'pittsburgh', level: 'Intermediate', format: 'doubles' },
      baseOpts,
    )
    expect(games.map(g => g.recordId)).toEqual(['s1'])
  })

  it('returns an empty list (not an error) when nothing matches', () => {
    expect(filterGames(sessions, rsvps, { area: 'Tokyo' }, baseOpts)).toEqual([])
  })
})

describe('filterGames distance', () => {
  const userLocation = { lat: 40.43295667, lng: -79.94131769 } // at Schenley

  it('attaches distances only where the court is known, never by guessing', () => {
    const games = filterGames(sessions, rsvps, {}, { ...baseOpts, userLocation })
    const byId = new Map(games.map(g => [g.recordId, g]))
    expect(byId.get('s1')?.distanceMiles).toBeCloseTo(0, 6)
    expect(byId.get('s2')?.distanceMiles).toBeCloseTo(3.3, 1)
    // Text-only location: no coordinates exist, so no distance is invented.
    expect(byId.get('s3')?.distanceMiles).toBeNull()
  })

  it('excludes sessions without known coordinates when a max distance is set', () => {
    const ids = filterGames(sessions, rsvps, { maxDistanceMiles: 1 }, { ...baseOpts, userLocation }).map(g => g.recordId)
    expect(ids).toEqual(['s1'])
  })

  it('keeps text-only sessions when no distance filter is set', () => {
    const ids = filterGames(sessions, rsvps, {}, { ...baseOpts, userLocation }).map(g => g.recordId)
    expect(ids).toContain('s3')
  })
})

describe('filterGames corrupted or duplicated attendance', () => {
  it('does not double count the same player or treat unknown statuses as attendance', () => {
    const row = session({ recordId: 'limited', capacity: 2, targetPlayers: 2 })
    const legacy: RallyRSVP[] = [
      { sessionId: 'limited', userId: 'u1', status: 'going' },
      { sessionId: 'limited', userId: 'u1', status: 'going' },
      { sessionId: 'limited', userId: 'u2', status: 'withdrawn' as RallyRSVP['status'] },
    ]
    const [game] = filterGames([row], legacy, {}, { ...baseOpts, userId: 'u1' })
    expect(game.going).toBe(1)
    expect(game.maybe).toBe(0)
    expect(game.status).toBe('needs-players')
    expect(game.isMine).toBe(true)
    expect(filterGames([row], legacy, { availability: 'spots' }, baseOpts)).toHaveLength(1)
    expect(filterGames([row], legacy, { availability: 'waitlist' }, baseOpts)).toHaveLength(0)
  })

  it('counts distinct users independently for each session', () => {
    const first = session({ recordId: 'first', capacity: 2, targetPlayers: 2 })
    const second = session({ recordId: 'second', capacity: 2, targetPlayers: 2 })
    const members: RallyRSVP[] = [
      { sessionId: 'first', userId: 'u1', status: 'going' },
      { sessionId: 'second', userId: 'u1', status: 'going' },
      { sessionId: 'first', userId: 'u2', status: 'maybe' },
    ]
    const result = filterGames([first, second], members, {}, baseOpts)
    expect(result.map(game => [game.going, game.maybe])).toEqual([[1, 1], [1, 0]])
  })
})

describe('filterGames ownership', () => {
  it('marks sessions the user hosts or joined as mine', () => {
    const games = filterGames(sessions, rsvps, {}, { ...baseOpts, userId: 'u1' })
    expect(games.find(g => g.recordId === 's1')?.isMine).toBe(true)
    expect(games.find(g => g.recordId === 's2')?.isMine).toBe(false)
    expect(games.find(g => g.recordId === 's6')?.isMine).toBe(true)
  })
})

it('filters availability using capacity instead of the planning target', () => {
  const capped = session({ recordId: 's6', capacity: 2, targetPlayers: 2 })
  const open = session({ recordId: 'open', targetPlayers: 2 })
  const cancelled = session({ recordId: 'cancelled', status: 'cancelled', capacity: 2 })
  expect(filterGames([capped, open, cancelled], rsvps, { availability: 'waitlist', showCancelled: true }, baseOpts).map(game => game.recordId)).toEqual(['s6'])
  expect(filterGames([capped, open, cancelled], rsvps, { availability: 'spots', showCancelled: true }, baseOpts).map(game => game.recordId)).toEqual(['open'])
})

it('only offers inline attendance actions for eligible upcoming games', () => {
  const [game] = filterGames([session({ recordId: 's6', capacity: 2 })], rsvps, {}, baseOpts)
  expect(discoveryAction(game, 'visitor', false, false)).toBe('joinWaitlist')
  expect(discoveryAction({ ...game, status: 'needs-players' }, 'visitor', false, false)).toBe('rsvp')
  expect(discoveryAction(game, 'host-1', false, false)).toBeNull()
  expect(discoveryAction(game, 'visitor', true, false)).toBeNull()
  expect(discoveryAction(game, 'visitor', false, true)).toBeNull()
  expect(discoveryAction(game, null, false, false)).toBeNull()
  expect(discoveryAction({ ...game, past: true }, 'visitor', false, false)).toBeNull()
  expect(discoveryAction({ ...game, cancelled: true }, 'visitor', false, false)).toBeNull()
})

it('does not assign the first distance when multiple cities have a court with the same name', () => {
  const first = { name: 'Riverside Tennis Courts', locality: 'Boston', lat: 42.36, lng: -71.06 }
  const second = { name: first.name, locality: 'Pittsburgh', lat: 40.44, lng: -79.99 }
  const options = { now: NOW, userLocation: second, knownCourts: [first, second] }
  const localRow = session({ recordId: 'local', court: first.name, location: 'Pittsburgh, PA' })
  const unknownRow = session({ recordId: 'unknown', court: first.name, location: 'Chicago' })
  const [local, unknown] = filterGames([localRow, unknownRow], [], {}, options)
  expect(local.distanceMiles).toBe(0)
  expect(unknown.distanceMiles).toBeNull()
  expect(filterGames([localRow], [], {}, {
    ...options, knownCourts: [{ ...first, locality: undefined }, { ...second, locality: undefined }],
  })[0].distanceMiles).toBeNull()
})
