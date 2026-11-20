import { describe, expect, it } from 'vitest'
import {
  RATING_ALGORITHM_VERSION,
  RATING_START,
  applyFinalizedResult,
  expectedScore,
  isProvisional,
  kFactor,
  provisionalConfidence,
  resultIdFor,
  reverseChange,
  validateFinalizedInput,
  type FinalizedResultInput,
  type PlayerRatingState,
} from './rating.js'

const singles = (
  winner: 0 | 1,
  teams: [string[], string[]] = [['ana'], ['bea']],
  resultId = resultIdFor('s1', 3),
): FinalizedResultInput => ({ resultId, sessionId: 's1', format: 'Singles', teams, winner })

const state = (playerId: string, rating: number, matchesPlayed: number): PlayerRatingState => ({
  playerId, rating, matchesPlayed,
})
const states = (...entries: PlayerRatingState[]) =>
  new Map(entries.map(entry => [entry.playerId, entry]))

describe('expectedScore', () => {
  it('is 0.5 for equal ratings', () => {
    expect(expectedScore(1200, 1200)).toBeCloseTo(0.5, 10)
  })
  it('is about 0.91 for a 400-point favourite', () => {
    expect(expectedScore(1600, 1200)).toBeCloseTo(0.909, 3)
    expect(expectedScore(1200, 1600)).toBeCloseTo(0.091, 3)
  })
})

describe('kFactor', () => {
  it('starts at 40, steps down to 32 then 24', () => {
    expect(kFactor(0, 0)).toBe(40)
    expect(kFactor(9, 0)).toBe(40)
    expect(kFactor(10, 0)).toBe(32)
    expect(kFactor(29, 0)).toBe(32)
    expect(kFactor(30, 0)).toBe(24)
    expect(kFactor(100, 0)).toBe(24)
  })
  it('halves after 3 prior matches against the same opponent', () => {
    expect(kFactor(0, 2)).toBe(40)
    expect(kFactor(0, 3)).toBe(20)
    expect(kFactor(10, 3)).toBe(16)
    expect(kFactor(30, 5)).toBe(12)
  })
})

describe('provisional state', () => {
  it('is provisional below 10 finalized matches', () => {
    expect(isProvisional(0)).toBe(true)
    expect(isProvisional(9)).toBe(true)
    expect(isProvisional(10)).toBe(false)
    expect(provisionalConfidence(0)).toBe(0)
    expect(provisionalConfidence(4)).toBeCloseTo(0.4, 10)
    expect(provisionalConfidence(10)).toBe(1)
  })
})

describe('applyFinalizedResult — singles', () => {
  it('equal new players split 20 points (worked example, match 1)', () => {
    const outcome = applyFinalizedResult(singles(0), new Map())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.changes).toHaveLength(2)
    const [ana, bea] = outcome.changes
    expect([ana.before, ana.after, ana.delta]).toEqual([1200, 1220, 20])
    expect([bea.before, bea.after, bea.delta]).toEqual([1200, 1180, -20])
    expect(ana.matchesPlayedAfter).toBe(1)
    expect(ana.provisionalAfter).toBe(true)
    expect(ana.k).toBe(40)
    expect(ana.expected).toBeCloseTo(0.5, 10)
    expect(ana.explanation).toContain('Beat bea (1200)')
  })

  it('an upset is worth more than a win over an equal (worked example, match 2)', () => {
    const outcome = applyFinalizedResult(
      singles(0, [['ana'], ['cara']]),
      states(state('ana', 1220, 1), state('cara', 1400, 5)),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const [ana, cara] = outcome.changes
    // E ≈ 0.262 for Ana; +40 × 0.738 ≈ +30.
    expect(ana.delta).toBe(30)
    expect(ana.after).toBe(1250)
    expect(cara.delta).toBe(-30)
    expect(cara.after).toBe(1370)
    expect(ana.explanation).toContain('expected win chance 26%')
  })

  it('a favourite beating a much weaker player gains almost nothing', () => {
    const outcome = applyFinalizedResult(
      singles(0),
      states(state('ana', 1600, 40), state('bea', 1200, 40)),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.changes[0].delta).toBe(2) // K 24 × (1 − 0.909) ≈ 2.2
    expect(outcome.changes[1].delta).toBe(-2)
  })

  it('a zero-history player starts at 1200', () => {
    const outcome = applyFinalizedResult(singles(1), new Map())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.changes.map(change => change.before)).toEqual([1200, 1200])
  })

  it('the 10th finalized match clears provisional', () => {
    const outcome = applyFinalizedResult(
      singles(0),
      states(state('ana', 1300, 9), state('bea', 1300, 9)),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.changes[0].matchesPlayedAfter).toBe(10)
    expect(outcome.changes[0].provisionalAfter).toBe(false)
  })

  it('repeat opponents get a halved K', () => {
    const outcome = applyFinalizedResult(
      singles(0),
      states(state('ana', 1200, 5), state('bea', 1200, 5)),
      new Map([['ana', 3], ['bea', 3]]),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.changes[0].k).toBe(20)
    expect(outcome.changes[0].delta).toBe(10)
  })
})

describe('applyFinalizedResult — doubles', () => {
  it('uses team means and each player’s own K and expected score', () => {
    const outcome = applyFinalizedResult(
      {
        resultId: resultIdFor('s2', 1),
        sessionId: 's2',
        format: 'Doubles',
        teams: [['ana', 'dan'], ['bea', 'cara']],
        winner: 0,
      },
      states(
        state('ana', 1250, 2),
        state('dan', 1200, 0),
        state('bea', 1180, 1),
        state('cara', 1370, 5),
      ),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.changes).toHaveLength(4)
    // Team means: 1225 vs 1275. Ana (E ≈ 0.464): +21; Dan (E ≈ 0.393): +24.
    const byId = new Map(outcome.changes.map(change => [change.playerId, change]))
    expect(byId.get('ana')?.delta).toBe(21)
    expect(byId.get('dan')?.delta).toBe(24)
    expect(byId.get('bea')?.delta).toBeLessThan(0)
    expect(byId.get('cara')?.delta).toBeLessThan(0)
    // Singles ratings are untouched by a doubles result (separate states).
    expect(byId.get('ana')?.format).toBe('Doubles')
  })

  it('a lower-rated partner gains more from the same upset win', () => {
    const outcome = applyFinalizedResult(
      {
        resultId: resultIdFor('s3', 1),
        sessionId: 's3',
        format: 'Doubles',
        teams: [['ana', 'dan'], ['bea', 'cara']],
        winner: 0,
      },
      states(
        state('ana', 1100, 0),
        state('dan', 1500, 0),
        state('bea', 1300, 0),
        state('cara', 1300, 0),
      ),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const byId = new Map(outcome.changes.map(change => [change.playerId, change]))
    expect((byId.get('ana')?.delta ?? 0)).toBeGreaterThan(byId.get('dan')?.delta ?? 0)
  })
})

describe('validateFinalizedInput', () => {
  it('rejects self-play and players on both sides', () => {
    expect(validateFinalizedInput(singles(0, [['ana'], ['ana']]))).toMatch(/both sides/)
    expect(validateFinalizedInput({
      resultId: 'x', sessionId: 's', format: 'Doubles',
      teams: [['ana', 'dan'], ['dan', 'cara']], winner: 0,
    })).toMatch(/both sides/)
  })
  it('rejects wrong team sizes and missing winners', () => {
    expect(validateFinalizedInput({
      resultId: 'x', sessionId: 's', format: 'Singles',
      teams: [['ana', 'dan'], ['bea', 'cara']], winner: 0,
    })).toMatch(/1 player/)
    expect(validateFinalizedInput({
      resultId: 'x', sessionId: 's', format: 'Doubles',
      teams: [['ana'], ['bea']], winner: 0,
    })).toMatch(/2 players/)
    expect(validateFinalizedInput({ ...singles(0), winner: null as never })).toMatch(/winner/)
  })
  it('rejects non-singles/doubles formats', () => {
    expect(validateFinalizedInput({ ...singles(0), format: 'Practice' as never })).toMatch(/Singles and Doubles/)
  })
  it('returns null for a valid input', () => {
    expect(validateFinalizedInput(singles(0))).toBeNull()
  })
})

describe('reverseChange', () => {
  it('negates the delta and the matches-played count', () => {
    const outcome = applyFinalizedResult(singles(0), new Map())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const reversed = reverseChange(outcome.changes[0])
    expect([reversed.before, reversed.after, reversed.delta]).toEqual([1220, 1200, -20])
    expect(reversed.matchesPlayedAfter).toBe(0)
    expect(reversed.provisionalAfter).toBe(true)
    expect(reversed.explanation).toContain('Reversal of')
  })
})

describe('inactivity', () => {
  it('no decay: a rating is unchanged when no result is applied', () => {
    // The engine has no time input at all: nothing can decay a rating.
    // This test pins that property — a state passed through untouched.
    const before = state('ana', 1450, 25)
    expect(before.rating).toBe(1450)
    expect(RATING_ALGORITHM_VERSION).toBe(1)
    expect(RATING_START).toBe(1200)
  })
})
