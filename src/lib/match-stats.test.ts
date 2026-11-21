import { describe, expect, it } from 'vitest'
import {
  buildMatchHistory,
  filterPublicStats,
  PROVISIONAL_MATCH_THRESHOLD,
  statsVisibilityFor,
  summarizePlayerStats,
  type MatchResultRow,
} from './match-stats.js'

function row(overrides: Partial<MatchResultRow> = {}): MatchResultRow {
  return {
    recordId: 'r1',
    sessionId: 's1',
    userId: 'alice',
    format: 'singles',
    won: true,
    sets: [[6, 4], [6, 3]],
    resultRevision: 1,
    finalizedAt: '2026-11-18T18:00:00.000Z',
    visibility: 'public',
    status: 'final',
    ...overrides,
  }
}

describe('summarizePlayerStats', () => {
  it('counts wins, losses, and win rate from finalized rows only', () => {
    const rows = [
      row({ sessionId: 's1', won: true }),
      row({ recordId: 'r2', sessionId: 's2', won: false }),
      row({ recordId: 'r3', sessionId: 's3', won: true }),
    ]
    expect(summarizePlayerStats(rows, 'alice', 'singles', 'public')).toEqual({
      userId: 'alice',
      format: 'singles',
      wins: 2,
      losses: 1,
      matchesPlayed: 3,
      winRate: 2 / 3,
      provisional: true,
      visibility: 'public',
    })
  })

  it('keeps singles and doubles strictly separate', () => {
    const rows = [
      row({ format: 'singles', won: true }),
      row({ recordId: 'r2', sessionId: 's2', format: 'doubles', won: true }),
      row({ recordId: 'r3', sessionId: 's3', format: 'doubles', won: false }),
    ]
    expect(summarizePlayerStats(rows, 'alice', 'singles', 'public').matchesPlayed).toBe(1)
    expect(summarizePlayerStats(rows, 'alice', 'doubles', 'public')).toMatchObject({
      wins: 1,
      losses: 1,
      matchesPlayed: 2,
    })
    expect(summarizePlayerStats(rows, 'bob', 'singles', 'public')).toMatchObject({
      wins: 0,
      losses: 0,
      matchesPlayed: 0,
      winRate: null,
      provisional: true,
    })
  })

  it('marks players provisional below the threshold and settled at it', () => {
    expect(PROVISIONAL_MATCH_THRESHOLD).toBe(5)
    const four = Array.from({ length: 4 }, (_, i) => row({ recordId: `r${i}`, sessionId: `s${i}` }))
    const five = [...four, row({ recordId: 'r4', sessionId: 's4' })]
    expect(summarizePlayerStats(four, 'alice', 'singles', 'public').provisional).toBe(true)
    expect(summarizePlayerStats(five, 'alice', 'singles', 'public').provisional).toBe(false)
  })

  it('never counts pending (corrected, unapproved) rows in statistics', () => {
    const rows = [
      row({ sessionId: 's1', won: true }),
      row({ recordId: 'r2', sessionId: 's2', won: true, status: 'pending' }),
    ]
    expect(summarizePlayerStats(rows, 'alice', 'singles', 'public')).toMatchObject({
      wins: 1,
      losses: 0,
      matchesPlayed: 1,
    })
  })
})

describe('buildMatchHistory', () => {
  it('orders newest first and projects only history fields', () => {
    const rows = [
      row({ sessionId: 'old', finalizedAt: '2026-11-01T18:00:00.000Z' }),
      row({ recordId: 'r2', sessionId: 'new', finalizedAt: '2026-11-18T18:00:00.000Z', won: false }),
    ]
    expect(buildMatchHistory(rows)).toEqual([
      { sessionId: 'new', format: 'singles', won: false, sets: [[6, 4], [6, 3]], finalizedAt: '2026-11-18T18:00:00.000Z', resultRevision: 1, status: 'final' },
      { sessionId: 'old', format: 'singles', won: true, sets: [[6, 4], [6, 3]], finalizedAt: '2026-11-01T18:00:00.000Z', resultRevision: 1, status: 'final' },
    ])
  })

  it('keeps pending entries visible with their status', () => {
    const rows = [
      row({ sessionId: 's1', status: 'pending', won: false }),
    ]
    expect(buildMatchHistory(rows)).toEqual([
      { sessionId: 's1', format: 'singles', won: false, sets: [[6, 4], [6, 3]], finalizedAt: '2026-11-18T18:00:00.000Z', resultRevision: 1, status: 'pending' },
    ])
  })
})

describe('privacy helpers', () => {
  it('drops private players from public listings and defaults visibility to public', () => {
    const summaries = [
      { userId: 'alice', visibility: 'public' as const },
      { userId: 'bob', visibility: 'private' as const },
    ]
    expect(filterPublicStats(summaries)).toEqual([{ userId: 'alice', visibility: 'public' }])
    expect(statsVisibilityFor(null)).toBe('public')
    expect(statsVisibilityFor('private')).toBe('private')
  })
})
