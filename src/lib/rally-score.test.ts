import { expect, it } from 'vitest'
import { awardPoint, createMatchScore, displayPoints, isEligibleForStats, isTiebreak, readMatchScore, resultStatus, reviewResult, type ScoreSide } from './rally-score'

const start = () => createMatchScore([['alice'], ['bob']])
const points = (score: ReturnType<typeof start>, team: ScoreSide, count: number) => {
  for (let index = 0; index < count; index++) score = awardPoint(score, team)
  return score
}

it('requires a two-point margin after deuce and resets the points at game end', () => {
  const deuce = points(points(start(), 0, 3), 1, 3)
  const advantage = awardPoint(deuce, 0)
  expect(displayPoints(advantage, 0)).toBe('Ad')
  expect(awardPoint(advantage, 1).games).toEqual([0, 0])
  expect(awardPoint(advantage, 0)).toMatchObject({ games: [1, 0], points: [0, 0], revision: 8 })
})

it('wins a set at 7–5 or by a tiebreak after six games each', () => {
  const twelveGames = { ...start(), games: [5, 5] as [number, number] }
  expect(points(twelveGames, 0, 8).sets).toEqual([[7, 5]])
  const tied = points(points(twelveGames, 0, 4), 1, 4)
  expect(isTiebreak(tied)).toBe(true)
  const sixAll = points(points(tied, 0, 6), 1, 6)
  expect(points(sixAll, 1, 2).sets).toEqual([[6, 7]])
})

it('completes at two sets won and round-trips the stored scoreboard', () => {
  const completed = points(start(), 0, 48)
  expect(completed).toMatchObject({ sets: [[6, 0], [6, 0]], winner: 0 })
  expect(awardPoint(completed, 1)).toBe(completed)
  expect(readMatchScore(JSON.stringify(completed))).toEqual(completed)
  expect(readMatchScore('{')).toBeNull()
})

it('requires approval from every participant and locks disputed results', () => {
  const won = points(createMatchScore([['a', 'b'], ['c', 'd']]), 0, 48)
  expect(resultStatus(won)).toBe('proposed')
  expect(reviewResult(won, 'outsider', 'approve')).toBeNull()
  const oneApproval = reviewResult(won, 'a', 'approve')!
  expect(resultStatus(oneApproval)).toBe('confirmed')
  expect(reviewResult(oneApproval, 'a', 'approve')).toBeNull()
  const dispute = reviewResult(oneApproval, 'c', 'dispute')!
  expect(resultStatus(dispute)).toBe('disputed')
  expect(reviewResult(dispute, 'b', 'approve')).toBeNull()
  const final = ['b', 'c', 'd'].reduce((score, player) => reviewResult(score, player, 'approve')!, oneApproval)
  expect(resultStatus(final)).toBe('final')
})

it('A12: only a finalized result is eligible for statistics or ratings', () => {
  const inProgress = points(start(), 0, 10)
  expect(resultStatus(inProgress)).toBe('in-progress')
  expect(isEligibleForStats(inProgress)).toBe(false)
  const won = points(start(), 0, 48)
  expect(isEligibleForStats(won)).toBe(false)
  const oneApproval = reviewResult(won, 'alice', 'approve')!
  expect(isEligibleForStats(oneApproval)).toBe(false)
  const disputed = reviewResult(oneApproval, 'bob', 'dispute')!
  expect(isEligibleForStats(disputed)).toBe(false)
  const final = reviewResult(oneApproval, 'bob', 'approve')!
  expect(resultStatus(final)).toBe('final')
  expect(isEligibleForStats(final)).toBe(true)
})

it('rejects duplicate players within or across teams when loading a match', () => {
  const valid = createMatchScore([['alice', 'partner'], ['bob', 'opponent']])
  expect(readMatchScore(JSON.stringify(valid))).toEqual(valid)
  expect(readMatchScore(JSON.stringify({ ...valid, teams: [['alice', 'alice'], ['bob']] }))).toBeNull()
  expect(readMatchScore(JSON.stringify({ ...valid, teams: [['alice'], ['bob', 'alice']] }))).toBeNull()
})

it('rejects malformed team identities before creating a score through the command schema', async () => {
  const { scoreEditSchema } = await import('./rally-score')
  expect(scoreEditSchema.safeParse({ operation: 'startMatch', teams: [['alice'], ['alice']] }).success).toBe(false)
  expect(scoreEditSchema.safeParse({ operation: 'startMatch', teams: [['alice', 'partner'], ['bob']] }).success).toBe(true)
})
