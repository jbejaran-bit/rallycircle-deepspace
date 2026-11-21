/**
 * Match scoring — point-by-point engine plus the result lifecycle.
 *
 * Result states (C02). The names 'proposed' and 'confirmed' are kept from
 * the existing integrated model so existing UI/tests do not break; their
 * meanings are:
 * - 'in-progress': no winner yet.
 * - 'proposed': winner decided, no approvals yet.
 * - 'confirmed': some (but not all) recorded participants approved —
 *   this is the "pending confirmation" state.
 * - 'final': every recorded participant approved. Only final results feed
 *   statistics (see result-finalization.ts).
 * - 'disputed': a participant disputed; the result is locked. Disputed
 *   results never affect statistics.
 * - 'corrected': a previously finalized (or disputed) result was corrected
 *   by the host and now awaits fresh approval from every participant.
 *   The superseded outcome survives only in `resultAudits`.
 *
 * Correction rules (C06): only the host may correct (enforced in the
 * command room — this module cannot know the host), only from 'final' or
 * 'disputed', and only with a complete corrected set scoreline. A
 * correction resets approvals, clears the dispute flag, bumps the
 * revision, and increments `correctionCount`. Stats written for the old
 * outcome are reversed by the command room before the corrected result
 * can finalize again.
 */

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
  approvals: z.array(z.string()).max(4).default([]),
  disputed: z.boolean().default(false),
  correctionCount: z.number().int().min(0).default(0),
})

export type MatchScore = z.infer<typeof scoreSchema>
export type MatchTeams = MatchScore['teams']
export type ScoreSide = z.infer<typeof side>

export const scoreEditSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('startMatch'), teams }),
  z.object({ operation: z.literal('scorePoint'), side, revision: z.number().int().min(0) }),
  z.object({ operation: z.literal('reviewResult'), decision: z.enum(['approve', 'dispute']), revision: z.number().int().min(0).optional() }),
  z.object({
    operation: z.literal('correctResult'),
    revision: z.number().int().min(0),
    sets: z.array(pair).min(2).max(3),
    winner: side,
  }),
])

export type ResultStatus = 'in-progress' | 'proposed' | 'confirmed' | 'disputed' | 'final' | 'corrected'

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
  return { revision: 0, teams: players, points: [0, 0], games: [0, 0], sets: [], winner: null, approvals: [], disputed: false, correctionCount: 0 }
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

export function resultStatus(score: MatchScore): ResultStatus {
  if (score.winner === null) return 'in-progress'
  if (score.disputed) return 'disputed'
  if (score.teams.flat().every(player => score.approvals.includes(player))) return 'final'
  if (score.approvals.length > 0) return 'confirmed'
  if (score.correctionCount > 0) return 'corrected'
  return 'proposed'
}

/**
 * Only a finalized result may feed match statistics or a rating (Tracks C/D).
 * Proposed, partially confirmed, in-progress and disputed results are never
 * eligible — a dispute locks the result out of statistics until resolved.
 * There is currently no statistics consumer; this predicate is the single
 * gate every future consumer must use.
 */
export function isEligibleForStats(score: MatchScore): boolean {
  return resultStatus(score) === 'final'
}

export function reviewResult(score: MatchScore, userId: string, decision: 'approve' | 'dispute'): MatchScore | null {
  const status = resultStatus(score)
  if (status !== 'proposed' && status !== 'confirmed' && status !== 'corrected') return null
  if (!score.teams.flat().includes(userId) || score.approvals.includes(userId)) return null
  return decision === 'dispute'
    ? { ...score, disputed: true }
    : { ...score, approvals: [...score.approvals, userId] }
}

/** True when this transition moves a result into 'final' for the first time at this revision. */
export function isFinalTransition(previous: MatchScore, next: MatchScore): boolean {
  return resultStatus(previous) !== 'final' && resultStatus(next) === 'final'
}

/** A completed set scoreline: 6–0..6–4, 7–5, or 7–6 (either side). */
export function isValidSetScore(set: [number, number]): boolean {
  const [a, b] = set
  const winner = Math.max(a, b)
  const loser = Math.min(a, b)
  if (winner === 6) return loser <= 4
  if (winner === 7) return loser === 5 || loser === 6
  return false
}

/**
 * Validate a host-supplied corrected scoreline. Returns null when valid,
 * otherwise a human-readable reason. The declared winner must have won
 * exactly two sets, and every set must be a valid completed set.
 */
export function validateCorrectedSets(
  sets: Array<[number, number]>,
  winner: ScoreSide,
): string | null {
  if (sets.length < 2 || sets.length > 3) return 'A corrected result needs two or three sets.'
  for (const set of sets) {
    if (!isValidSetScore(set)) return 'Each set must be a completed set (6–0 to 6–4, 7–5, or 7–6).'
  }
  const loser: ScoreSide = winner === 0 ? 1 : 0
  const winnerSets = sets.filter((set) => set[winner] > set[loser]).length
  if (winnerSets !== 2) return 'The winning side must have won exactly two sets.'
  return null
}

/**
 * Host correction of a finalized or disputed result. Returns null when the
 * current state cannot be corrected. The caller (command room) must verify
 * the caller is the session host — this module cannot know the host.
 * Approvals reset so every recorded participant must approve the corrected
 * result before it can finalize again.
 */
export function correctResult(
  score: MatchScore,
  sets: Array<[number, number]>,
  winner: ScoreSide,
): MatchScore | null {
  const status = resultStatus(score)
  if (status !== 'final' && status !== 'disputed') return null
  if (validateCorrectedSets(sets, winner) !== null) return null
  return {
    ...score,
    revision: score.revision + 1,
    points: [0, 0],
    games: [0, 0],
    sets: sets.map((set) => [...set] as [number, number]),
    winner,
    approvals: [],
    disputed: false,
    correctionCount: score.correctionCount + 1,
  }
}
