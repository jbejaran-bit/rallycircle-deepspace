import { z } from 'zod'

const pair = z.tuple([z.number().int().min(0), z.number().int().min(0)])
const teams = z.tuple([z.array(z.string().min(1).max(200)).min(1).max(2), z.array(z.string().min(1).max(200)).min(1).max(2)])
const side = z.union([z.literal(0), z.literal(1)])
const scoreSchema = z.object({
  revision: z.number().int().min(0),
  teams,
  points: pair,
  games: pair,
  sets: z.array(pair).max(3),
  winner: side.nullable(),
})

export type MatchScore = z.infer<typeof scoreSchema>
export type MatchTeams = MatchScore['teams']
export type ScoreSide = z.infer<typeof side>

export const scoreEditSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('startMatch'), teams }),
  z.object({ operation: z.literal('scorePoint'), side, revision: z.number().int().min(0) }),
])

export function readMatchScore(raw: string | undefined): MatchScore | null {
  if (!raw) return null
  try {
    const result = scoreSchema.safeParse(JSON.parse(raw))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

export function createMatchScore(players: MatchTeams): MatchScore {
  return { revision: 0, teams: players, points: [0, 0], games: [0, 0], sets: [], winner: null }
}

export function isTiebreak(score: MatchScore) {
  return score.games[0] === 6 && score.games[1] === 6
}

export function awardPoint(score: MatchScore, team: ScoreSide): MatchScore {
  if (score.winner !== null) return score
  const opponent = team === 0 ? 1 : 0
  const points: [number, number] = [...score.points]
  const games: [number, number] = [...score.games]
  points[team]++
  const next = { ...score, revision: score.revision + 1, points, games }
  const tiebreak = isTiebreak(score)
  if (points[team] < (tiebreak ? 7 : 4) || points[team] - points[opponent] < 2) return next

  games[team]++
  next.points = [0, 0]
  if (tiebreak || (games[team] >= 6 && games[team] - games[opponent] >= 2)) {
    next.sets = [...score.sets, games]
    next.games = [0, 0]
    if (next.sets.filter(set => set[team] > set[opponent]).length === 2) next.winner = team
  }
  return next
}

export function displayPoints(score: MatchScore, team: ScoreSide): string {
  const own = score.points[team]
  const other = score.points[team === 0 ? 1 : 0]
  if (isTiebreak(score)) return String(own)
  if (own >= 3 && other >= 3) return own > other ? 'Ad' : '40'
  return ['0', '15', '30', '40'][own] ?? '40'
}
