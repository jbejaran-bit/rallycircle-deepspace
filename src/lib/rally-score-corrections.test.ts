import { describe, expect, it } from 'vitest'
import {
  awardPoint,
  correctResult,
  createMatchScore,
  resultStatus,
  reviewResult,
  validateCorrectedSets,
  type MatchScore,
  type ScoreSide,
} from './rally-score.js'

const start = () => createMatchScore([['alice'], ['bob']])
const points = (score: MatchScore, team: ScoreSide, count: number) => {
  for (let index = 0; index < count; index++) score = awardPoint(score, team)
  return score
}
const won = () => points(start(), 0, 48)
const finalized = () => {
  let score = won()
  for (const player of ['alice', 'bob']) score = reviewResult(score, player, 'approve')!
  return score
}

describe('validateCorrectedSets', () => {
  it('accepts straight-set and three-set wins for the declared winner', () => {
    expect(validateCorrectedSets([[6, 4], [6, 3]], 0)).toBeNull()
    expect(validateCorrectedSets([[4, 6], [7, 5], [6, 2]], 0)).toBeNull()
    expect(validateCorrectedSets([[6, 7], [7, 5], [4, 6]], 1)).toBeNull()
  })

  it('rejects an extra set after the winner clinches the match', () => {
    expect(validateCorrectedSets([[6, 3], [6, 2], [3, 6]], 0)).toContain('match ends')
    expect(validateCorrectedSets([[3, 6], [2, 6], [6, 3]], 1)).toContain('match ends')
    expect(validateCorrectedSets([[6, -1], [6, 3]], 0)).toContain('completed set')
  })

  it('rejects invalid sets, wrong winners, and wrong set counts', () => {
    expect(validateCorrectedSets([[6, 6], [6, 3]], 0)).toContain('completed set')
    expect(validateCorrectedSets([[6, 5], [6, 3]], 0)).toContain('completed set')
    expect(validateCorrectedSets([[6, 4], [6, 3]], 1)).toContain('exactly two sets')
    expect(validateCorrectedSets([[6, 4], [3, 6], [6, 7]], 0)).toContain('exactly two sets')
    expect(validateCorrectedSets([[6, 4]], 0)).toContain('two or three sets')
    expect(validateCorrectedSets([[6, 4], [6, 3], [6, 3], [6, 3]], 0)).toContain('two or three sets')
  })
})

describe('correctResult', () => {
  it('corrects a finalized result, resets approvals, and reports the corrected state', () => {
    const final = finalized()
    expect(resultStatus(final)).toBe('final')
    const corrected = correctResult(final, [[4, 6], [6, 3], [6, 2]], 0)!
    expect(resultStatus(corrected)).toBe('corrected')
    expect(corrected).toMatchObject({
      sets: [[4, 6], [6, 3], [6, 2]],
      winner: 0,
      approvals: [],
      disputed: false,
      correctionCount: 1,
      revision: final.revision + 1,
    })
    // A corrected result needs fresh approval from every participant.
    const oneApproval = reviewResult(corrected, 'alice', 'approve')!
    expect(resultStatus(oneApproval)).toBe('confirmed')
    const reFinalized = reviewResult(oneApproval, 'bob', 'approve')!
    expect(resultStatus(reFinalized)).toBe('final')
    expect(reFinalized.correctionCount).toBe(1)
  })

  it('corrects a disputed result and refuses live or merely proposed results', () => {
    const disputed = reviewResult(won(), 'alice', 'dispute')!
    expect(resultStatus(disputed)).toBe('disputed')
    expect(correctResult(disputed, [[6, 2], [6, 2]], 0)).not.toBeNull()
    expect(correctResult(won(), [[6, 2], [6, 2]], 0)).toBeNull()
    expect(correctResult(start(), [[6, 2], [6, 2]], 0)).toBeNull()
  })

  it('refuses an invalid corrected scoreline without changing the result', () => {
    const final = finalized()
    expect(correctResult(final, [[6, 6], [6, 3]], 0)).toBeNull()
    expect(correctResult(final, [[6, 4], [6, 3]], 1)).toBeNull()
    expect(resultStatus(final)).toBe('final')
  })

  it('allows a corrected result to be disputed again', () => {
    const corrected = correctResult(finalized(), [[6, 1], [6, 1]], 0)!
    const disputedAgain = reviewResult(corrected, 'bob', 'dispute')!
    expect(resultStatus(disputedAgain)).toBe('disputed')
    expect(reviewResult(disputedAgain, 'alice', 'approve')).toBeNull()
  })
})
