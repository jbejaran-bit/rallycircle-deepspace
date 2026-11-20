import { describe, expect, it } from 'vitest'
import { buildDashboard, filterAgenda } from './rally-dashboard'
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
