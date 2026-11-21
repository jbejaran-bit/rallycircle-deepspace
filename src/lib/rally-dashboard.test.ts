import { describe, expect, it } from 'vitest'
import { agendaWeek, buildDashboard, filterAgenda } from './rally-dashboard'
import type { RallySession } from './rally'
import { createMatchScore } from './rally-score'

const base: RallySession = {
  title: 'Friendly rally', format: 'Singles', startsAt: '2026-12-01T12:00:00Z',
  durationMinutes: 90, targetPlayers: 2, level: 'All levels', court: 'Court', location: 'Park',
  hostId: 'other-host', chatChannelId: '', notes: '', status: 'open',
}
const row = (recordId: string, patch: Partial<RallySession> = {}) => ({ recordId, data: { ...base, ...patch } })
const now = Date.parse('2026-11-20T12:00:00Z')

describe('personal tennis activity', () => {
  it('scopes every agenda filter to the account and avoids stale waitlisted status after promotion', () => {
    const entries = buildDashboard([
      row('hosting', { hostId: 'me' }), row('joined'), row('queued'),
      row('cancelled', { hostId: 'me', status: 'cancelled' }),
      row('past', { hostId: 'me', startsAt: '2026-11-01T12:00Z' }), row('unrelated'),
    ], [
      { sessionId: 'joined', userId: 'me', status: 'going' },
      { sessionId: 'unrelated', userId: 'stranger', status: 'going' },
    ], [
      { sessionId: 'joined', userId: 'me' },
      { sessionId: 'queued', userId: 'me' },
      { sessionId: 'unrelated', userId: 'stranger' },
    ], 'me', now).entries
    expect(filterAgenda(entries, 'upcoming').map(entry => entry.recordId)).toEqual(['hosting', 'joined', 'queued'])
    expect(filterAgenda(entries, 'waitlisted').map(entry => entry.recordId)).toEqual(['queued'])
    expect(filterAgenda(entries, 'participating').map(entry => entry.recordId)).toEqual(['joined'])
    expect(filterAgenda(entries, 'cancelled').map(entry => entry.recordId)).toEqual(['cancelled'])
    expect(filterAgenda(entries, 'past').map(entry => entry.recordId)).toEqual(['past'])
  })

  it('counts only finalized results and includes players who no longer have an RSVP', () => {
    const score = createMatchScore([['me'], ['rival']])
    const agenda = buildDashboard([
      row('final', { matchScore: JSON.stringify({ ...score, winner: 0, approvals: ['me', 'rival'] }) }),
      row('proposed', { matchScore: JSON.stringify({ ...score, winner: 1 }) }),
    ], [], [], 'me', now)
    expect(agenda.matches).toHaveLength(2)
    expect(agenda).toMatchObject({ finalized: 1, wins: 1 })
    expect(buildDashboard([row('someone-else')], [], [], 'me', now)).toMatchObject({ entries: [], wins: 0 })
  })
})

it('buckets the week using local dates and does not repeat events at a day boundary', () => {
  const monday = new Date(2026, 10, 16)
  const sunday = new Date(2026, 10, 22, 23, 30)
  const nextMonday = new Date(2026, 10, 23)
  const entries = buildDashboard([row('opens', { hostId: 'me', startsAt: monday.toISOString() }),
    row('late', { hostId: 'me', startsAt: sunday.toISOString() }),
    row('next', { hostId: 'me', startsAt: nextMonday.toISOString() })], [], [], 'me', now).entries
  const days = agendaWeek(sunday, 0, entries)
  expect(days).toHaveLength(7)
  expect(days[0].entries.map(entry => entry.recordId)).toEqual(['opens'])
  expect(days[6].entries.map(entry => entry.recordId)).toEqual(['late'])
  expect(agendaWeek(sunday, 1, entries)[0].entries.map(entry => entry.recordId)).toEqual(['next'])
})

it('separates the next confirmed rally from actual community openings', () => {
  const future = '2026-12-01T12:00:00Z'
  const dashboard = buildDashboard([
    row('tentative', { startsAt: future }),
    row('confirmed', { startsAt: '2026-12-02T12:00:00Z' }),
    row('full', { startsAt: future, capacity: 2, targetPlayers: 2 }),
    row('open', { startsAt: future, capacity: 2, targetPlayers: 2 }),
    row('cancelled', { startsAt: future, status: 'cancelled' }),
  ], [
    { sessionId: 'tentative', userId: 'me', status: 'maybe' },
    { sessionId: 'confirmed', userId: 'me', status: 'going' },
    { sessionId: 'full', userId: 'a', status: 'going' },
    { sessionId: 'full', userId: 'b', status: 'going' },
    { sessionId: 'open', userId: 'a', status: 'going' },
  ], [], 'me', now)
  expect(dashboard.nextRally?.recordId).toBe('confirmed')
  expect(dashboard.gamesNeedingPlayers.map(({ recordId, needed }) => ({ recordId, needed }))).toEqual([{ recordId: 'open', needed: 1 }])
})

it('keeps personal attendance visible when the community counts are unavailable', () => {
  const rally = row('mine')
  const opening = row('open')
  const responses = [{ sessionId: 'mine', userId: 'me', status: 'going' }] as const
  const missingCommunity = buildDashboard([rally, opening], [...responses], [], 'me', now, null)
  expect(missingCommunity.nextRally?.recordId).toBe('mine')
  expect(missingCommunity.gamesNeedingPlayers).toEqual([])
  const available = buildDashboard([rally, opening], [...responses], [], 'me', now, [
    { sessionId: 'open', userId: 'another-player', status: 'going' },
  ])
  expect(available.gamesNeedingPlayers[0]).toMatchObject({ recordId: 'open', needed: 1 })
})

it('does not invent full games from duplicate or malformed community RSVPs', () => {
  const sessions = [row('opening', { targetPlayers: 2, capacity: 2 })]
  const community = [
    { sessionId: 'opening', userId: 'player-a', status: 'going' },
    { sessionId: 'opening', userId: 'player-a', status: 'going' },
    { sessionId: 'opening', userId: '', status: 'going' },
    { sessionId: 'opening', userId: 'player-b', status: 'unknown' },
  ] as unknown as Parameters<typeof buildDashboard>[5]
  const result = buildDashboard(sessions, [], [], 'me', now, community)
  expect(result.gamesNeedingPlayers.map(game => ({ id: game.recordId, needed: game.needed })))
    .toEqual([{ id: 'opening', needed: 1 }])
  const full = buildDashboard(sessions, [], [], 'me', now, [
    ...community!, { sessionId: 'opening', userId: 'player-b', status: 'going' },
  ])
  expect(full.gamesNeedingPlayers).toEqual([])
  // The same player in a different session is a distinct attendance record.
  const separate = buildDashboard([...sessions, row('other')], [], [], 'me', now, [
    { sessionId: 'opening', userId: 'player-a', status: 'going' },
    { sessionId: 'other', userId: 'player-a', status: 'going' },
  ])
  expect(separate.gamesNeedingPlayers.map(game => game.recordId)).toEqual(['opening', 'other'])
})


it('uses the first valid personal RSVP when legacy duplicates conflict', () => {
  const sessions = [row('joined'), row('tentative'), row('available')]
  const responses = [
    { sessionId: 'joined', userId: 'me', status: 'going' },
    { sessionId: 'joined', userId: 'me', status: 'maybe' },
    { sessionId: 'tentative', userId: 'me', status: 'unknown' },
    { sessionId: 'tentative', userId: 'me', status: 'maybe' },
    { sessionId: 'available', userId: 'me', status: 'unknown' },
    { sessionId: '', userId: 'me', status: 'going' },
  ] as unknown as Parameters<typeof buildDashboard>[1]
  const dashboard = buildDashboard(sessions, responses, [], 'me', now)
  expect(dashboard.nextRally?.recordId).toBe('joined')
  expect(filterAgenda(dashboard.entries, 'participating').map(entry => [entry.recordId, entry.response]))
    .toEqual([['joined', 'going'], ['tentative', 'maybe']])
  expect(dashboard.gamesNeedingPlayers.map(game => game.recordId)).toEqual(['available'])
})

it('ignores malformed waitlist identifiers without hiding community openings', () => {
  const dashboard = buildDashboard([row('open')], [], [
    { sessionId: '', userId: 'me' },
    { sessionId: null, userId: 'me' },
  ] as unknown as Parameters<typeof buildDashboard>[2], 'me', now)
  expect(filterAgenda(dashboard.entries, 'waitlisted')).toEqual([])
  expect(dashboard.gamesNeedingPlayers.map(game => game.recordId)).toEqual(['open'])
})

it('does not advertise a precise opening count for malformed legacy session limits', () => {
  const invalid = [
    { targetPlayers: 0 },
    { targetPlayers: NaN },
    { targetPlayers: 2.5 },
    { targetPlayers: 13 },
    { targetPlayers: 4, capacity: 2 },
    { targetPlayers: 2, capacity: -1 },
    { targetPlayers: 2, capacity: Infinity },
    { targetPlayers: 2, capacity: 2.5 },
  ] as Partial<RallySession>[]
  const sessions = [
    ...invalid.map((patch, index) => row(`invalid-${index}`, patch)),
    row('valid-capped', { targetPlayers: 4, capacity: 4 }),
    row('valid-uncapped', { targetPlayers: 2 }),
  ]
  const dashboard = buildDashboard(sessions, [], [], 'me', now)
  expect(dashboard.gamesNeedingPlayers.map(({ recordId, needed }) => ({ recordId, needed })))
    .toEqual([{ recordId: 'valid-capped', needed: 4 }, { recordId: 'valid-uncapped', needed: 2 }])
  // Do not hide a user's own historical session simply because its limits
  // are malformed; only public availability recommendations are suppressed.
  expect(buildDashboard([row('mine', { hostId: 'me', targetPlayers: NaN })], [], [], 'me', now).entries)
    .toHaveLength(1)
})
