import { describe, expect, it } from 'vitest'
import type { AnnotatedGame } from './find-games.js'
import type { RallyRSVP, RallySession } from './rally.js'
import {
  buildFollowNotification,
  decodePreferences,
  DEFAULT_PREFERENCES,
  deriveActivityFeed,
  derivePlayedWith,
  encodePreferences,
  pageByCreatedAt,
  rankGames,
  validatePreferences,
  validateUserId,
  type DiscoveryPreferences,
} from './social.js'

function session(overrides: Partial<RallySession> & { recordId: string; createdAt: string }) {
  const { recordId, createdAt, ...data } = overrides
  return {
    recordId,
    createdAt,
    data: {
      title: 'Test rally',
      court: 'Schenley Park',
      location: 'Pittsburgh',
      startsAt: '2030-06-01T14:00:00.000Z',
      durationMinutes: 90,
      targetPlayers: 4,
      level: 'All levels',
      notes: '',
      hostId: 'host',
      chatChannelId: '',
      status: 'open',
      ...data,
    } as RallySession,
  }
}

function finalScore(teams: string[][], winner: 0 | 1, approvals: string[], disputed = false) {
  return JSON.stringify({
    revision: 5,
    teams,
    points: [0, 0],
    games: [0, 0],
    sets: [[6, 2], [6, 3]],
    winner,
    approvals,
    disputed,
  })
}

function game(overrides: Partial<AnnotatedGame>): AnnotatedGame {
  return {
    recordId: 'g1',
    session: session({ recordId: 's1', createdAt: '2030-01-01T00:00:00.000Z' }).data,
    going: 2,
    maybe: 0,
    status: 'needs-players',
    cancelled: false,
    past: false,
    distanceMiles: null,
    isMine: false,
    ...overrides,
  }
}

const prefs: DiscoveryPreferences = {
  formats: ['doubles'],
  level: 'Intermediate',
  area: 'Schenley',
  radiusMiles: 10,
  timeStart: '12:00',
  timeEnd: '18:00',
  days: [6],
}

describe('validateUserId', () => {
  it('accepts ids and rejects empty, over-long, and whitespace ids', () => {
    expect(validateUserId('alice')).toBe(true)
    expect(validateUserId('')).toBe(false)
    expect(validateUserId('a'.repeat(201))).toBe(false)
    expect(validateUserId('a b')).toBe(false)
    expect(validateUserId(undefined)).toBe(false)
    expect(validateUserId(42)).toBe(false)
  })
})

describe('validatePreferences', () => {
  it('accepts a complete valid preference set and the defaults', () => {
    expect(validatePreferences(prefs)).toBeNull()
    expect(validatePreferences(DEFAULT_PREFERENCES)).toBeNull()
  })

  it('rejects bad formats, levels, radius, areas, times, and days', () => {
    expect(validatePreferences({ ...prefs, formats: ['singles', 'singles'] })).toContain('repeat')
    expect(validatePreferences({ ...prefs, formats: ['triples'] })).toContain('format')
    expect(validatePreferences({ ...prefs, level: 'Pro' })).toContain('level')
    expect(validatePreferences({ ...prefs, radiusMiles: 0 })).toContain('radius')
    expect(validatePreferences({ ...prefs, radiusMiles: 101 })).toContain('radius')
    expect(validatePreferences({ ...prefs, area: 'x'.repeat(101) })).toContain('Area')
    expect(validatePreferences({ ...prefs, timeStart: '12:00', timeEnd: '' })).toContain('both')
    expect(validatePreferences({ ...prefs, timeStart: '25:00', timeEnd: '26:00' })).toContain('HH:MM')
    expect(validatePreferences({ ...prefs, timeStart: '18:00', timeEnd: '12:00' })).toContain('after it starts')
    expect(validatePreferences({ ...prefs, days: [7] })).toContain('Days')
    expect(validatePreferences({ ...prefs, days: [1, 1] })).toContain('repeat')
    expect(validatePreferences(null)).toContain('object')
  })

  it('round-trips through encode/decode and degrades malformed stored data to defaults', () => {
    expect(decodePreferences(encodePreferences(prefs))).toEqual(prefs)
    expect(decodePreferences({ formats: 'not json', level: 'Pro', radiusMiles: 'far' })).toEqual({
      ...DEFAULT_PREFERENCES,
      formats: [],
      days: [],
    })
  })
})

describe('pageByCreatedAt', () => {
  const records = [
    { createdAt: '2030-01-03T00:00:00.000Z', id: 'c' },
    { createdAt: '2030-01-01T00:00:00.000Z', id: 'a' },
    { createdAt: '2030-01-02T00:00:00.000Z', id: 'b' },
  ]
  it('returns newest first with a cursor only when more pages remain', () => {
    const first = pageByCreatedAt(records, 2)
    expect(first.page.map(record => record.id)).toEqual(['c', 'b'])
    expect(first.nextCursor).toBe('2030-01-02T00:00:00.000Z')
    const second = pageByCreatedAt(records, 2, first.nextCursor ?? undefined)
    expect(second.page.map(record => record.id)).toEqual(['a'])
    expect(second.nextCursor).toBeNull()
  })
})

describe('derivePlayedWith', () => {
  const sessions = [
    session({ recordId: 's1', createdAt: '2030-01-01T00:00:00.000Z', hostId: 'alice', startsAt: '2030-06-01T14:00:00.000Z' }),
    session({
      recordId: 's2',
      createdAt: '2030-01-02T00:00:00.000Z',
      hostId: 'bob',
      startsAt: '2030-06-02T14:00:00.000Z',
      matchScore: finalScore([['alice', 'carol'], ['bob', 'dave']], 0, ['alice', 'carol', 'bob', 'dave']),
    }),
    session({
      recordId: 's3',
      createdAt: '2030-01-03T00:00:00.000Z',
      hostId: 'alice',
      startsAt: '2030-06-03T14:00:00.000Z',
      // Disputed result: must not count as a match.
      matchScore: finalScore([['alice'], ['erin']], 0, ['alice', 'erin'], true),
    }),
    session({
      recordId: 's4',
      createdAt: '2030-01-04T00:00:00.000Z',
      hostId: 'alice',
      startsAt: '2030-06-04T14:00:00.000Z',
      status: 'cancelled',
    }),
  ]
  const rsvps: RallyRSVP[] = [
    { sessionId: 's1', userId: 'alice', status: 'going' },
    { sessionId: 's1', userId: 'bob', status: 'going' },
    { sessionId: 's2', userId: 'alice', status: 'going' },
    { sessionId: 's2', userId: 'bob', status: 'going' },
    { sessionId: 's2', userId: 'carol', status: 'going' },
    { sessionId: 's2', userId: 'dave', status: 'going' },
    { sessionId: 's3', userId: 'alice', status: 'going' },
    { sessionId: 's3', userId: 'erin', status: 'going' },
    { sessionId: 's4', userId: 'alice', status: 'going' },
    { sessionId: 's4', userId: 'frank', status: 'going' },
  ]

  it('derives shared sessions and finalized matches only, from actual records', () => {
    const played = derivePlayedWith(sessions, rsvps, 'alice')
    const byId = new Map(played.map(entry => [entry.userId, entry]))
    // bob: shared s1 + s2, played the finalized match as an opponent, lost.
    expect(byId.get('bob')).toMatchObject({ sharedSessions: 2, matchesAgainst: 1, matchesWonAgainst: 1, matchesTogether: 0 })
    // carol: partner in the finalized win.
    expect(byId.get('carol')).toMatchObject({ sharedSessions: 1, matchesTogether: 1, matchesWonTogether: 1 })
    // dave: opponent in the finalized match.
    expect(byId.get('dave')).toMatchObject({ sharedSessions: 1, matchesAgainst: 1 })
    // erin: shared the disputed session, but the disputed result counts for nothing.
    expect(byId.get('erin')).toMatchObject({ sharedSessions: 1, matchesTogether: 0, matchesAgainst: 0 })
    // frank only shared a cancelled session: absent entirely.
    expect(byId.has('frank')).toBe(false)
    // Sorted by total shared activity.
    expect(played[0].userId).toBe('bob')
  })

  it('returns an empty list when the viewer played with nobody', () => {
    expect(derivePlayedWith(sessions, rsvps, 'nobody')).toEqual([])
  })
})

describe('deriveActivityFeed', () => {
  const sessions = [
    session({ recordId: 's1', createdAt: '2030-01-01T00:00:00.000Z', hostId: 'alice' }),
    session({
      recordId: 's2',
      createdAt: '2030-01-02T00:00:00.000Z',
      hostId: 'bob',
      matchScore: finalScore([['bob'], ['carol']], 1, ['bob', 'carol']),
    }),
    session({ recordId: 's3', createdAt: '2030-01-03T00:00:00.000Z', hostId: 'dave', status: 'cancelled' }),
    session({ recordId: 's4', createdAt: '2030-01-04T00:00:00.000Z', hostId: 'erin' }),
  ]
  it('shows followed players only, excludes cancelled sessions and blocked actors, and adds finalized matches', () => {
    const feed = deriveActivityFeed(sessions, 'alice', new Set(['bob']), new Set(['erin']), { followedOnly: true })
    // Same-session events keep insertion order (session-created, then the
    // finalized-match event); ordering across sessions is newest first.
    expect(feed.map(event => `${event.type}:${event.sessionId}`)).toEqual([
      'session-created:s2',
      'match-finalized:s2',
      'session-created:s1',
    ])
    expect(feed[1]).toMatchObject({ type: 'match-finalized', winner: 1, teams: [['bob'], ['carol']] })
  })

  it('shows every public event when followedOnly is false, newest first', () => {
    const feed = deriveActivityFeed(sessions, 'alice', new Set(), new Set(), { followedOnly: false })
    expect(feed.map(event => event.sessionId)).toEqual(['s4', 's2', 's2', 's1'])
  })
})

describe('rankGames', () => {
  const base = game({
    recordId: 'g1',
    session: session({
      recordId: 's1',
      createdAt: '2030-01-01T00:00:00.000Z',
      format: 'Doubles',
      level: 'Intermediate',
      court: 'Schenley Park',
      location: 'Pittsburgh',
      startsAt: '2030-06-01T14:00:00.000Z', // a Saturday in UTC, matching prefs.days [6]
    }).data,
    going: 4,
    distanceMiles: 3,
  })

  it('scores level, format, area, distance, time, day, capacity, doubles readiness, and followed hosts', () => {
    const [ranked] = rankGames([base], prefs, { followedHostIds: new Set(['host']) })
    expect(ranked.score).toBe(40 + 30 + 15 + 20 + 10 + 5 + 10 + 10 + 10)
    expect(ranked.reasons).toEqual([
      'level-match',
      'format-match',
      'nearby',
      'area-match',
      'time-match',
      'day-match',
      'needs-players',
      'doubles-ready',
      'followed-host',
    ])
  })

  it('demotes a two-step level gap and excludes it under strictLevel', () => {
    const advanced = game({
      ...base,
      recordId: 'g2',
      session: { ...base.session, level: 'Advanced', format: 'Singles' },
    })
    // Beginner viewer vs Advanced session is a two-step gap: demoted by 30
    // relative to the same session at the viewer's level, and labelled.
    const beginnerPrefs: DiscoveryPreferences = { ...prefs, level: 'Beginner' }
    const [ranked] = rankGames([advanced], beginnerPrefs)
    const [matched] = rankGames([{ ...advanced, session: { ...advanced.session, level: 'Beginner' } }], beginnerPrefs)
    expect(ranked.score).toBe(matched.score - 70)
    expect(ranked.reasons).toContain('level-gap')
    expect(rankGames([advanced], beginnerPrefs, { strictLevel: true })).toEqual([])
  })

  it('marks full sessions down and keeps them visible with a waitlist reason', () => {
    const [ranked] = rankGames([{ ...base, status: 'full', going: 4 }], prefs)
    expect(ranked.reasons).toContain('session-full')
  })

  it('sorts deterministically by score, then start time, then record id', () => {
    const early = game({ recordId: 'g-early', session: { ...base.session, startsAt: '2030-06-06T09:00:00.000Z' } })
    const late = game({ recordId: 'g-late', session: { ...base.session, startsAt: '2030-06-06T15:00:00.000Z' } })
    expect(rankGames([late, early], null).map(item => item.recordId)).toEqual(['g-early', 'g-late'])
  })
})

describe('buildFollowNotification', () => {
  it('builds a typed draft without persisting anything', () => {
    const draft = buildFollowNotification('alice', 'bob', Date.parse('2030-01-01T00:00:00.000Z'))
    expect(draft).toEqual({
      type: 'follow',
      recipientId: 'bob',
      actorId: 'alice',
      createdAt: '2030-01-01T00:00:00.000Z',
      deepLink: '/players/alice',
    })
  })
})
