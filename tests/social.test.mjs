import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildFollowNotification,
  decodePreferences,
  deriveActivityFeed,
  derivePlayedWith,
  pageByCreatedAt,
  rankGames,
  validatePreferences,
} from '../src/lib/social.ts'

const prefs = {
  formats: ['doubles'],
  level: 'Intermediate',
  area: 'Schenley',
  radiusMiles: 10,
  timeStart: '12:00',
  timeEnd: '18:00',
  days: [6],
}

test('preferences: a valid set passes and an overnight window is rejected', () => {
  assert.equal(validatePreferences(prefs), null)
  assert.match(validatePreferences({ ...prefs, timeStart: '18:00', timeEnd: '12:00' }) ?? '', /after it starts/)
  assert.match(validatePreferences({ ...prefs, radiusMiles: 101 }) ?? '', /radius/)
})

test('preferences: malformed stored data degrades to defaults', () => {
  const decoded = decodePreferences({ formats: 'not json', level: 'Pro', radiusMiles: 'far' })
  assert.equal(decoded.level, 'All levels')
  assert.deepEqual(decoded.formats, [])
})

test('pagination: newest first with a cursor only when more pages remain', () => {
  const records = [
    { createdAt: '2030-01-03T00:00:00.000Z', id: 'c' },
    { createdAt: '2030-01-01T00:00:00.000Z', id: 'a' },
    { createdAt: '2030-01-02T00:00:00.000Z', id: 'b' },
  ]
  const first = pageByCreatedAt(records, 2)
  assert.deepEqual(first.page.map(record => record.id), ['c', 'b'])
  assert.equal(first.nextCursor, '2030-01-02T00:00:00.000Z')
  const second = pageByCreatedAt(records, 2, first.nextCursor ?? undefined)
  assert.deepEqual(second.page.map(record => record.id), ['a'])
  assert.equal(second.nextCursor, null)
})

test('played-with: only finalized matches count, disputed results do not', () => {
  const finalScore = (teams, winner, approvals, disputed = false) =>
    JSON.stringify({
      revision: 5, teams, points: [0, 0], games: [0, 0], sets: [[6, 2], [6, 3]],
      winner, approvals, disputed,
    })
  const base = {
    title: 'Test rally', court: 'Schenley Park', location: 'Pittsburgh',
    startsAt: '2030-06-01T14:00:00.000Z', durationMinutes: 90, targetPlayers: 4,
    level: 'All levels', notes: '', chatChannelId: '', status: 'open',
  }
  const sessions = [
    {
      recordId: 's1', createdAt: '2030-01-01T00:00:00.000Z',
      data: { ...base, hostId: 'alice' },
    },
    {
      recordId: 's2', createdAt: '2030-01-02T00:00:00.000Z',
      data: {
        ...base, hostId: 'bob',
        matchScore: finalScore([['alice', 'carol'], ['bob', 'dave']], 0, ['alice', 'carol', 'bob', 'dave']),
      },
    },
    {
      recordId: 's3', createdAt: '2030-01-03T00:00:00.000Z',
      data: {
        ...base, hostId: 'alice',
        matchScore: finalScore([['alice'], ['erin']], 0, ['alice', 'erin'], true),
      },
    },
  ]
  const rsvps = [
    { sessionId: 's1', userId: 'alice', status: 'going' },
    { sessionId: 's1', userId: 'bob', status: 'going' },
    { sessionId: 's2', userId: 'alice', status: 'going' },
    { sessionId: 's2', userId: 'bob', status: 'going' },
    { sessionId: 's2', userId: 'carol', status: 'going' },
    { sessionId: 's2', userId: 'dave', status: 'going' },
    { sessionId: 's3', userId: 'alice', status: 'going' },
    { sessionId: 's3', userId: 'erin', status: 'going' },
  ]
  const played = derivePlayedWith(sessions, rsvps, 'alice')
  const byId = new Map(played.map(entry => [entry.userId, entry]))
  assert.equal(byId.get('bob')?.matchesAgainst, 1)
  assert.equal(byId.get('carol')?.matchesTogether, 1)
  assert.equal(byId.get('erin')?.matchesTogether, 0)
  assert.equal(byId.get('erin')?.sharedSessions, 1)
})

test('activity feed: cancelled sessions never appear; blocked actors are hidden', () => {
  const base = {
    title: 'Test rally', court: 'Schenley Park', location: 'Pittsburgh',
    startsAt: '2030-06-01T14:00:00.000Z', durationMinutes: 90, targetPlayers: 4,
    level: 'All levels', notes: '', chatChannelId: '', status: 'open',
  }
  const sessions = [
    { recordId: 's1', createdAt: '2030-01-01T00:00:00.000Z', data: { ...base, hostId: 'alice' } },
    { recordId: 's2', createdAt: '2030-01-02T00:00:00.000Z', data: { ...base, hostId: 'bob' } },
    { recordId: 's3', createdAt: '2030-01-03T00:00:00.000Z', data: { ...base, hostId: 'dave', status: 'cancelled' } },
  ]
  const feed = deriveActivityFeed(sessions, 'alice', new Set(['bob']), new Set(['dave']), { followedOnly: true })
  assert.deepEqual(feed.map(event => event.sessionId), ['s2', 's1'])
})

test('ranking: a level match outranks a level gap deterministically', () => {
  const mk = (recordId, level) => ({
    recordId,
    session: {
      title: 'Test rally', court: 'Schenley Park', location: 'Pittsburgh',
      startsAt: '2030-06-01T14:00:00.000Z', durationMinutes: 90, targetPlayers: 4,
      level, notes: '', hostId: 'host', chatChannelId: '', status: 'open', format: 'Doubles',
    },
    going: 2, maybe: 0, status: 'needs-players', cancelled: false, past: false,
    distanceMiles: null, isMine: false,
  })
  const localPrefs = {
    formats: ['doubles'], level: 'Beginner', area: '', radiusMiles: 10,
    timeStart: null, timeEnd: null, days: [],
  }
  const ranked = rankGames([mk('g-adv', 'Advanced'), mk('g-beg', 'Beginner')], localPrefs)
  assert.equal(ranked[0].recordId, 'g-beg')
  assert.ok(ranked[0].reasons.includes('level-match'))
  assert.ok(ranked[1].reasons.includes('level-gap'))
})

test('follow notification draft: typed, side-effect free, and never persisted here', () => {
  const draft = buildFollowNotification('alice', 'bob', Date.parse('2030-01-01T00:00:00.000Z'))
  assert.equal(draft.type, 'follow')
  assert.equal(draft.recipientId, 'bob')
  assert.equal(draft.deepLink, '/players/alice')
})
