import { expect, it } from 'vitest'
import { awardPoint, createMatchScore, displayPoints, isTiebreak, readMatchScore, type ScoreSide } from './rally-score'

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
