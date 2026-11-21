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
    row('full', { startsAt: future, capacity: 2, targetPlayers: 4 }),
    row('open', { startsAt: future, capacity: 2, targetPlayers: 4 }),
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
