import { describe, expect, it } from 'vitest'
import {
  findDuplicateSession,
  searchSessions,
  upcomingReminders,
  validateAvailabilityWindow,
  validateFavoriteCourt,
  validateMatchNote,
  validateSessionTemplate,
  type SessionRecord,
} from './extensions.js'
import type { RallyRSVP, RallySession } from './rally.js'

const NOW = Date.parse('2030-06-01T12:00:00.000Z')

function session(overrides: Partial<RallySession> = {}, recordId = `s-${Math.random().toString(36).slice(2, 8)}`): SessionRecord {
  return {
    recordId,
    data: {
      title: 'Saturday rally',
      court: 'Schenley Park',
      location: 'Pittsburgh',
      startsAt: '2030-06-08T14:00:00.000Z',
      durationMinutes: 90,
      targetPlayers: 4,
      level: 'All levels',
      notes: '',
      hostId: 'host',
      chatChannelId: '',
      status: 'open',
      ...overrides,
    },
  }
}

const validTemplate = {
  format: 'Doubles',
  court: 'Schenley Park',
  location: 'Pittsburgh',
  durationMinutes: 90,
  targetPlayers: 4,
  level: 'Intermediate',
  notes: '',
  timeOfDay: '19:00',
}

describe('validateSessionTemplate (L02)', () => {
  it('accepts a complete valid template', () => {
    expect(validateSessionTemplate(validTemplate)).toMatchObject({ format: 'Doubles', timeOfDay: '19:00' })
  })

  it('accepts a blank time of day and defaults notes', () => {
    const result = validateSessionTemplate({ ...validTemplate, timeOfDay: '' })
    expect(result).toMatchObject({ timeOfDay: '' })
  })

  it('rejects a bad format, bad time of day, and a target above capacity', () => {
    expect(validateSessionTemplate({ ...validTemplate, format: 'Squash' })).toBe('Select a session format.')
    expect(validateSessionTemplate({ ...validTemplate, timeOfDay: '25:00' })).toBe('Use a time of day like 19:00, or leave it blank.')
    expect(validateSessionTemplate({ ...validTemplate, timeOfDay: '7pm' })).toBe('Use a time of day like 19:00, or leave it blank.')
    expect(validateSessionTemplate({ ...validTemplate, targetPlayers: 6, capacity: 4 })).toBe('The planning target cannot exceed the maximum.')
    expect(validateSessionTemplate({ ...validTemplate, notes: 'x'.repeat(401) })).toBe('Keep notes under 400 characters.')
  })
})

describe('validateFavoriteCourt (L03)', () => {
  it('accepts a court-discovery place id with valid coordinates', () => {
    expect(validateFavoriteCourt({
      placeId: 'osm:way/123456',
      name: 'Schenley Oval',
      lat: 40.434,
      lng: -79.948,
      locality: 'Pittsburgh',
    })).toMatchObject({ placeId: 'osm:way/123456' })
  })

  it('rejects invented place ids and out-of-range coordinates', () => {
    expect(validateFavoriteCourt({ placeId: 'my-backyard', name: 'Home', lat: 40, lng: -80 })).toBe(
      'Choose a court from the court search results.',
    )
    expect(validateFavoriteCourt({ placeId: 'osm:node/1', name: 'X', lat: 91, lng: 0 })).toBe(
      'Provide a valid latitude (-90 to 90).',
    )
    expect(validateFavoriteCourt({ placeId: 'osm:node/1', name: 'X', lat: 0, lng: 181 })).toBe(
      'Provide a valid longitude (-180 to 180).',
    )
  })
})

describe('validateAvailabilityWindow (L04)', () => {
  it('accepts a valid window', () => {
    expect(validateAvailabilityWindow({ dayOfWeek: 6, startMinutes: 540, endMinutes: 720 })).toMatchObject({
      dayOfWeek: 6,
    })
  })

  it('rejects a bad day, an inverted window, and out-of-range minutes', () => {
    expect(validateAvailabilityWindow({ dayOfWeek: 7, startMinutes: 0, endMinutes: 60 })).toBe(
      'Choose a day of the week (0 = Sunday to 6 = Saturday).',
    )
    expect(validateAvailabilityWindow({ dayOfWeek: 1, startMinutes: 600, endMinutes: 600 })).toBe(
      'The end time must be after the start time.',
    )
    expect(validateAvailabilityWindow({ dayOfWeek: 1, startMinutes: -1, endMinutes: 60 })).toBe(
      'Choose a start time within the day.',
    )
  })
})

describe('validateMatchNote (L08)', () => {
  it('accepts a note up to 280 characters and rejects empty or longer notes', () => {
    expect(validateMatchNote('Great match, well played.')).toBeNull()
    expect(validateMatchNote('x'.repeat(280))).toBeNull()
    expect(validateMatchNote('   ')).toBe('Write a note.')
    expect(validateMatchNote('x'.repeat(281))).toBe('Keep match notes under 280 characters.')
  })
})

describe('searchSessions (L01/L13)', () => {
  it('finds by text, format, level and date window, sorted by start time', () => {
    const records = [
      session({ title: 'Morning doubles', startsAt: '2030-06-08T09:00:00.000Z', format: 'Doubles', level: 'Beginner' }),
      session({ title: 'Evening singles', startsAt: '2030-06-07T19:00:00.000Z', format: 'Singles', level: 'Advanced' }),
      session({ title: 'Practice drills', startsAt: '2030-06-09T10:00:00.000Z', format: 'Practice' }),
    ]
    const found = searchSessions(records, { q: 'singles' }, NOW)
    expect(found.sessions.map(s => s.title)).toEqual(['Evening singles'])
    const byFormat = searchSessions(records, { format: 'doubles' }, NOW)
    expect(byFormat.sessions.map(s => s.title)).toEqual(['Morning doubles'])
    const byDate = searchSessions(records, { fromDate: '2030-06-08', toDate: '2030-06-08' }, NOW)
    expect(byDate.sessions.map(s => s.title)).toEqual(['Morning doubles'])
    const byLevel = searchSessions(records, { level: 'Beginner' }, NOW)
    expect(byLevel.sessions.map(s => s.title)).toEqual(['Morning doubles'])
    // Default sort is by start time regardless of input order.
    expect(searchSessions(records, {}, NOW).sessions.map(s => s.title)).toEqual([
      'Evening singles',
      'Morning doubles',
      'Practice drills',
    ])
  })

  it('excludes cancelled and past sessions by default, includes them on request', () => {
    const records = [
      session({ title: 'Cancelled one', status: 'cancelled' }, 'a-cancelled'),
      session({ title: 'Past one', startsAt: '2030-05-01T14:00:00.000Z' }, 'b-past'),
      session({ title: 'Future one' }, 'c-future'),
    ]
    expect(searchSessions(records, {}, NOW).sessions.map(s => s.title)).toEqual(['Future one'])
    expect(searchSessions(records, { showCancelled: true, showPast: true }, NOW).sessions.map(s => s.title)).toEqual([
      'Past one',
      'Cancelled one',
      'Future one',
    ])
  })

  it('infers legacy formats from target players and caps the result limit', () => {
    const records = [
      session({ title: 'Legacy pairs', format: undefined, targetPlayers: 2 }),
      session({ title: 'Legacy group', format: undefined, targetPlayers: 6 }),
    ]
    expect(searchSessions(records, { format: 'singles' }, NOW).sessions.map(s => s.title)).toEqual(['Legacy pairs'])
    expect(searchSessions(records, { format: 'doubles' }, NOW).sessions.map(s => s.title)).toEqual(['Legacy group'])
    expect(searchSessions([session(), session(), session()], { limit: 2 }, NOW).sessions).toHaveLength(2)
  })

  it('reports truncation when the scan hits the limit', () => {
    const records = Array.from({ length: 200 }, (_, i) => session({ title: `Session ${i}` }))
    const found = searchSessions(records, {}, NOW)
    expect(found.truncated).toBe(true)
    expect(searchSessions(records.slice(0, 10), {}, NOW).truncated).toBe(false)
  })
})

describe('findDuplicateSession (L12)', () => {
  const candidate = { court: 'Schenley Park', location: 'Pittsburgh', startsAt: '2030-06-08T14:03:00.000Z' }

  it('flags the same host, court and start time within 5 minutes', () => {
    const records = [session({ title: 'Original' }, 'dup')]
    expect(findDuplicateSession(records, 'host', candidate)).toEqual({ recordId: 'dup', title: 'Original' })
  })

  it('ignores other hosts, other courts, cancelled sessions, and times beyond 5 minutes', () => {
    const records = [
      session({ hostId: 'someone-else' }, 'a'),
      session({ court: 'Mellon Park' }, 'b'),
      session({ status: 'cancelled' }, 'c'),
      session({ startsAt: '2030-06-08T14:10:00.000Z' }, 'd'),
    ]
    expect(findDuplicateSession(records, 'host', candidate)).toBeNull()
    // Case-insensitive place matching still flags the duplicate.
    const same = [session({ court: 'schenley park', location: 'pittsburgh' }, 'e')]
    expect(findDuplicateSession(same, 'host', candidate)).toEqual({ recordId: 'e', title: 'Saturday rally' })
  })
})

describe('upcomingReminders (L05)', () => {
  const rsvps: RallyRSVP[] = [
    { sessionId: 'soon', userId: 'player', status: 'going' },
    { sessionId: 'later', userId: 'player', status: 'going' },
    { sessionId: 'maybe', userId: 'player', status: 'maybe' },
    { sessionId: 'other', userId: 'someone-else', status: 'going' },
  ]

  it('returns only open going sessions starting within 24 hours, sorted', () => {
    const records = [
      session({ title: 'Soon', startsAt: '2030-06-02T00:00:00.000Z' }, 'soon'),
      session({ title: 'Evening', startsAt: '2030-06-01T18:00:00.000Z' }, 'evening'),
      session({ title: 'Later', startsAt: '2030-06-03T13:00:00.000Z' }, 'later'),
      session({ title: 'Maybe', startsAt: '2030-06-01T18:00:00.000Z' }, 'maybe'),
      session({ title: 'Other', startsAt: '2030-06-01T18:00:00.000Z' }, 'other'),
      session({ title: 'Cancelled', startsAt: '2030-06-01T18:00:00.000Z', status: 'cancelled' }, 'cancelled'),
    ]
    // 'cancelled' has no RSVP above; add a going RSVP for it to prove the status filter.
    const all = [
      ...rsvps,
      { sessionId: 'evening', userId: 'player', status: 'going' as const },
      { sessionId: 'cancelled', userId: 'player', status: 'going' as const },
    ]
    const reminders = upcomingReminders(records, all, 'player', NOW)
    expect(reminders.map(r => r.sessionId)).toEqual(['evening', 'soon'])
    expect(reminders[0]).toMatchObject({ minutesUntilStart: 360 })
    expect(reminders[1]).toMatchObject({ minutesUntilStart: 720 })
  })
})
