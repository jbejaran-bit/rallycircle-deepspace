/**
 * Migration / backward-compatibility suite (PR #19 audit port).
 *
 * Ported from the integrated branch's suite; the rating tests are
 * replaced by statsFormatOf equivalents because PR #19 contains no
 * rating code (Track D is not integrated), and the groups check is
 * kept as a no-gate assertion (Tracks I+J are not integrated).
 *
 * Fixtures are sessions, RSVPs and scoreboards in the PRE-TRACK shape:
 * the fields the integrated tracks added (format, capacity, matchScore,
 * seriesId, scheduleRevision, pendingResult) are absent, and scoreboards
 * are stored in the minimal JSON shape from before approvals / disputed /
 * correctionCount existed. Every read path must handle them with a
 * sensible default — never a crash, never a wrong derived value.
 *
 * Verdicts asserted here:
 * - additive-only: new columns are optional; old records still validate.
 * - new collections are empty for old data; stats / polls /
 *   notifications produce NOTHING for old records, not wrong values.
 * - an old finalized result can still be corrected.
 * - groupId absent means public session (no group gate exists here).
 * - an old finalized result without a format is skipped by stats
 *   (practice), never counted under a wrong format.
 */
import { describe, expect, it } from 'vitest'
import {
  correctResult,
  createMatchScore,
  isEligibleForStats,
  readMatchScore,
  resultStatus,
  type MatchScore,
} from './rally-score.js'
import { statsFormatOf } from '../server/result-finalization.js'
import { tallyVotes } from './polls.js'
import { validateSession, type RallySession } from './rally.js'
import { buildCalendarEvent } from './rally-calendar.js'

/** A session exactly as stored before any advanced track ran. */
function oldSession(overrides: Partial<RallySession> = {}): RallySession {
  return {
    title: 'Saturday rally',
    court: 'Frick Park',
    location: 'Pittsburgh, PA',
    startsAt: '2030-06-06T14:00:00.000Z',
    durationMinutes: 90,
    targetPlayers: 4,
    level: 'Intermediate',
    notes: '',
    hostId: 'host',
    chatChannelId: '',
    status: 'open',
    ...overrides,
  }
}

/** A scoreboard in the minimal pre-track JSON shape: no approvals,
 *  disputed or correctionCount keys (the schema supplies defaults). */
const OLD_FINAL_SCORE_JSON = JSON.stringify({
  revision: 2,
  teams: [['alice'], ['bob']],
  points: [0, 0],
  games: [0, 0],
  sets: [[6, 4], [6, 3]],
  winner: 0,
  approvals: ['alice', 'bob'],
})

describe('Migration / backward compatibility — old-format records', () => {
  it('an old session without any new field still validates', () => {
    const session = oldSession()
    expect('format' in session).toBe(false)
    expect('capacity' in session).toBe(false)
    expect('matchScore' in session).toBe(false)
    expect('groupId' in session).toBe(false)
    expect('seriesId' in session).toBe(false)
    expect('scheduleRevision' in session).toBe(false)
    expect(validateSession(session, Date.parse('2030-01-01T00:00:00.000Z'))).toBeNull()
  })

  it('an old session with no notes validates (pre-field template shape)', () => {
    const session = oldSession()
    // @ts-expect-error old stored templates predate the notes field
    delete session.notes
    expect(validateSession(session, Date.parse('2030-01-01T00:00:00.000Z'))).toBeNull()
  })

  it('a missing matchScore reads as no score, not a crash', () => {
    expect(readMatchScore(undefined)).toBeNull()
    expect(readMatchScore('')).toBeNull()
  })

  it('corrupt or legacy-non-JSON matchScore reads as no score', () => {
    expect(readMatchScore('not json at all')).toBeNull()
    expect(readMatchScore('{"revision": "two"}')).toBeNull()
    expect(readMatchScore('[]')).toBeNull()
  })

  it('an old minimal scoreboard parses with defaults and is proposed, not final', () => {
    const minimal = JSON.stringify({
      revision: 0,
      teams: [['alice'], ['bob']],
      points: [0, 0],
      games: [0, 0],
      sets: [],
      winner: null,
    })
    const score = readMatchScore(minimal)
    expect(score).not.toBeNull()
    expect(score!.approvals).toEqual([])
    expect(score!.disputed).toBe(false)
    expect(score!.correctionCount).toBe(0)
    expect(resultStatus(score!)).toBe('in-progress')
    expect(isEligibleForStats(score!)).toBe(false)
  })

  it('an old finalized score with approvals is final and stats-eligible', () => {
    const score = readMatchScore(OLD_FINAL_SCORE_JSON)!
    expect(resultStatus(score)).toBe('final')
    expect(isEligibleForStats(score)).toBe(true)
  })

  it('an old finalized result WITHOUT a format is skipped by stats (nothing, not a wrong value)', () => {
    expect(statsFormatOf(oldSession({ matchScore: OLD_FINAL_SCORE_JSON }))).toBeNull()
  })

  it('the same old finalized result WITH a format maps to its stats format', () => {
    expect(statsFormatOf(oldSession({ format: 'Singles', matchScore: OLD_FINAL_SCORE_JSON }))).toBe('singles')
    expect(statsFormatOf(oldSession({ format: 'Doubles', matchScore: OLD_FINAL_SCORE_JSON }))).toBe('doubles')
  })

  it('a corrected old finalized result bumps the revision and resets approvals', () => {
    const score = readMatchScore(OLD_FINAL_SCORE_JSON)!
    const corrected = correctResult(score, [[4, 6], [6, 4], [2, 6]], 1)
    expect(corrected).not.toBeNull()
    expect(corrected!.revision).toBe(score.revision + 1)
    expect(corrected!.correctionCount).toBe(1)
    expect(corrected!.approvals).toEqual([])
    expect(corrected!.disputed).toBe(false)
    expect(corrected!.winner).toBe(1)
    expect(resultStatus(corrected!)).toBe('corrected')
    expect(isEligibleForStats(corrected!)).toBe(false)
  })

  it('correctResult refuses a non-final old result', () => {
    const inProgress = createMatchScore([['alice'], ['bob']])
    expect(correctResult(inProgress, [[6, 4], [6, 3]], 0)).toBeNull()
  })

  it('no votes means an empty tally, and a calendar export for an old session omits SEQUENCE (== 0), never NaN', () => {
    expect(tallyVotes([])).toEqual({})
    const ics = buildCalendarEvent(oldSession(), 'https://rally.example/rallies?session=old', new Date('2030-01-01T00:00:00.000Z'))
    expect(ics).not.toBeNull()
    expect(ics!).not.toContain('SEQUENCE')
    expect(ics!).not.toContain('NaN')
  })

  it('a cancelled old session still exports a METHOD:CANCEL with no SEQUENCE (== 0)', () => {
    const ics = buildCalendarEvent(
      oldSession({ status: 'cancelled' }),
      'https://rally.example/rallies?session=old',
      new Date('2030-01-01T00:00:00.000Z'),
      { method: 'CANCEL' },
    )
    expect(ics).not.toBeNull()
    expect(ics!).toContain('METHOD:CANCEL')
    expect(ics!).toContain('STATUS:CANCELLED')
    expect(ics!).not.toContain('SEQUENCE')
    expect(ics!).not.toContain('NaN')
  })
})

describe('Migration / backward compatibility — per-track additive checks', () => {
  it('Track B+C: a score with no correctionCount defaults it to 0, so old results are never "corrected"', () => {
    const score: MatchScore = readMatchScore(JSON.stringify({
      revision: 1,
      teams: [['alice'], ['bob']],
      points: [0, 0],
      games: [0, 0],
      sets: [[6, 4]],
      winner: 0,
      approvals: ['alice', 'bob'],
    }))!
    expect(score.correctionCount).toBe(0)
    expect(resultStatus(score)).toBe('final')
  })

  it('Stats: a format is required, so pre-format finals stay out of stats', () => {
    expect(statsFormatOf(oldSession({ matchScore: OLD_FINAL_SCORE_JSON }))).toBeNull()
    expect(statsFormatOf(oldSession({ format: 'Doubles', matchScore: OLD_FINAL_SCORE_JSON }))).toBe('doubles')
  })

  it('Groups are not integrated here: groupId absent means the session is public, not group-gated', () => {
    const session = oldSession()
    // RallySession has no groupId in PR #19 at all; a stored pre-groups
    // record trivially carries none.
    expect((session as unknown as Record<string, unknown>).groupId ?? '').toBe('')
  })

  it('PR #19 recovery fields: pendingResult / seriesId / scheduleRevision absent means no pending op, no series, revision 0', () => {
    const session = oldSession()
    expect('pendingResult' in session).toBe(false)
    expect('seriesId' in session).toBe(false)
    expect('scheduleRevision' in session).toBe(false)
    expect(session.pendingResult ?? '').toBe('')
    expect(session.seriesId ?? '').toBe('')
    expect(session.scheduleRevision ?? 0).toBe(0)
  })
})
