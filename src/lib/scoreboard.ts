/**
 * Live Match Scoreboard — shared types and pure validation.
 *
 * Data model (collection `matchScores`, one record per session):
 *   - `sets` is an array of completed set scores, e.g. [{a:6,b:4},{a:3,b:6}].
 *     A set score is games only — there is deliberately no point-by-point
 *     engine in this MVP. A future point-by-point mode can add a
 *     `points`/`games` structure inside each set entry (and bump
 *     `formatVersion`) without changing the collection or the write path.
 *   - `matchTiebreak` is the optional deciding tiebreak (first to 10, win
 *     by 2), kept distinct from ordinary game scores. It is only valid
 *     when the sets are split 1–1.
 *   - `version` is the optimistic-concurrency token: a write must carry
 *     the version it read. A stale version is a conflict, never a silent
 *     overwrite (see `rally-command-room.ts`).
 *   - `updatedBy` is the verified user id the server action stamped on
 *     the last write; `updatedAt` comes from the record itself.
 *
 * Scores are shared by the session host and are NOT official or validated
 * by any sports organization — the UI must say so.
 */

export type ScoreboardStatus = 'not_started' | 'in_progress' | 'final'

export interface SetScore {
  a: number
  b: number
}

export interface MatchTiebreak {
  a: number
  b: number
}

export interface ScoreboardInput {
  teamAName: string
  teamBName: string
  status: ScoreboardStatus
  sets: SetScore[]
  matchTiebreak: MatchTiebreak | null
}

export interface MatchScoreboard extends ScoreboardInput {
  sessionId: string
  version: number
  updatedBy: string
}

/** Current record state the validator needs for transitions and conflicts. */
export interface ScoreboardCurrent {
  status: ScoreboardStatus
  version: number
  teamAName: string
  teamBName: string
  sets: SetScore[]
  matchTiebreak: MatchTiebreak | null
}

export const SCOREBOARD_STATUSES: ScoreboardStatus[] = ['not_started', 'in_progress', 'final']
export const MAX_SETS = 3
export const MAX_TEAM_NAME_LENGTH = 40

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

/** Games won by each team across completed sets. */
export function setsWon(sets: SetScore[]): { a: number; b: number } {
  let a = 0
  let b = 0
  for (const set of sets) {
    if (set.a > set.b) a += 1
    else if (set.b > set.a) b += 1
  }
  return { a, b }
}

/** Match winner once somebody has won 2 sets — a deciding tiebreak win counts as the third set. */
export function scoreboardWinner(input: Pick<ScoreboardInput, 'sets' | 'matchTiebreak'>): 'A' | 'B' | null {
  const won = matchSetsWon(input)
  if (won.a >= 2) return 'A'
  if (won.b >= 2) return 'B'
  return null
}

/** Sets won, counting a decided match tiebreak as the deciding set (1–1 becomes 2–1). */
export function matchSetsWon(input: Pick<ScoreboardInput, 'sets' | 'matchTiebreak'>): { a: number; b: number } {
  const won = setsWon(input.sets)
  const tiebreakWinner = matchTiebreakWinner(input.matchTiebreak ?? null)
  if (won.a === 1 && won.b === 1 && tiebreakWinner === 'A') won.a = 2
  if (won.a === 1 && won.b === 1 && tiebreakWinner === 'B') won.b = 2
  return won
}

/** A completed set: 6–0..4, 7–5, or 7–6 (a tiebreak set). No partial sets in the MVP. */
export function isValidSetScore(set: SetScore): boolean {
  if (!isInteger(set.a) || !isInteger(set.b)) return false
  if (set.a < 0 || set.b < 0 || set.a > 7 || set.b > 7) return false
  if (set.a === 0 && set.b === 0) return false
  const winner = Math.max(set.a, set.b)
  const loser = Math.min(set.a, set.b)
  if (winner === 6) return loser <= 4
  if (winner === 7) return loser === 5 || loser === 6
  return false
}

/** Deciding tiebreak: first to 10, win by 2. A null tiebreak is always shaped-valid. */
export function isValidMatchTiebreak(tiebreak: MatchTiebreak | null): boolean {
  if (tiebreak === null) return true
  if (!isInteger(tiebreak.a) || !isInteger(tiebreak.b)) return false
  if (tiebreak.a < 0 || tiebreak.b < 0 || tiebreak.a > 99 || tiebreak.b > 99) return false
  if (tiebreak.a === 0 && tiebreak.b === 0) return false
  return true
}

export function matchTiebreakWinner(tiebreak: MatchTiebreak | null): 'A' | 'B' | null {
  if (!tiebreak) return null
  const winner = Math.max(tiebreak.a, tiebreak.b)
  const loser = Math.min(tiebreak.a, tiebreak.b)
  if (winner >= 10 && winner - loser >= 2) return tiebreak.a > tiebreak.b ? 'A' : 'B'
  return null
}

function sameScore(a: ScoreboardInput, b: ScoreboardCurrent): boolean {
  return (
    a.teamAName.trim() === b.teamAName &&
    a.teamBName.trim() === b.teamBName &&
    a.status === b.status &&
    a.matchTiebreak?.a === b.matchTiebreak?.a &&
    a.matchTiebreak?.b === b.matchTiebreak?.b &&
    a.sets.length === b.sets.length &&
    a.sets.every((set, i) => set.a === b.sets[i]?.a && set.b === b.sets[i]?.b)
  )
}

/**
 * Validate a scoreboard write. Returns an error message or null.
 * `current` is null when no scoreboard record exists yet for the session.
 * `correction` must be true to change the score of an already-final match.
 * Version conflicts are checked by the server, not here.
 */
export function validateScoreboardInput(
  input: ScoreboardInput,
  current: ScoreboardCurrent | null,
  correction = false,
): string | null {
  const teamA = typeof input.teamAName === 'string' ? input.teamAName.trim() : ''
  const teamB = typeof input.teamBName === 'string' ? input.teamBName.trim() : ''
  if (!teamA || teamA.length > MAX_TEAM_NAME_LENGTH) return 'Enter a Team A name (1–40 characters).'
  if (!teamB || teamB.length > MAX_TEAM_NAME_LENGTH) return 'Enter a Team B name (1–40 characters).'
  if (!SCOREBOARD_STATUSES.includes(input.status)) return 'Select a valid match status.'
  if (!Array.isArray(input.sets) || input.sets.length > MAX_SETS) return 'Enter at most 3 sets.'
  for (const set of input.sets) {
    if (!set || typeof set !== 'object' || !isValidSetScore(set)) {
      return 'Each set needs a valid completed score (6–0 to 6–4, 7–5, or 7–6).'
    }
  }
  if (input.matchTiebreak !== null && !isValidMatchTiebreak(input.matchTiebreak)) {
    return 'The match tiebreak needs valid point totals.'
  }

  const won = setsWon(input.sets)
  const setsSplit = won.a === 1 && won.b === 1
  if (input.matchTiebreak !== null && !setsSplit) {
    return 'A deciding match tiebreak is only used when the sets are split 1–1.'
  }

  // Finality dominates: once final, only a confirmed correction may change the score.
  if (current?.status === 'final') {
    if (input.status !== 'final') return 'A final match stays final — correct the score instead of reopening it.'
    if (!sameScore(input, current) && !correction) {
      return 'This match is final. Confirm this is a correction to change the score.'
    }
  }

  if (input.status === 'not_started') {
    if (input.sets.length > 0 || input.matchTiebreak !== null) {
      return 'A match that has not started cannot have set scores.'
    }
  }

  if (input.status === 'in_progress') {
    if (scoreboardWinner(input) !== null) {
      return 'The match already has a winner — mark it final instead of in progress.'
    }
    if (input.matchTiebreak !== null && matchTiebreakWinner(input.matchTiebreak) !== null) {
      return 'The deciding tiebreak already has a winner — mark the match final.'
    }
  }

  if (input.status === 'final') {
    if (setsSplit && input.matchTiebreak !== null && matchTiebreakWinner(input.matchTiebreak) === null) {
      return 'The deciding match tiebreak needs a winner (first to 10, win by 2).'
    }
    const winner = scoreboardWinner(input)
    if (winner === null) return 'A final match needs a winner — someone must win 2 sets.'
    if (input.matchTiebreak !== null) {
      const tiebreakWinner = matchTiebreakWinner(input.matchTiebreak)
      if (tiebreakWinner !== winner) return 'The match tiebreak winner must match the match winner.'
    }
  }

  return null
}

/** Human-readable set list, e.g. "6–4, 3–6". Empty when no sets are recorded. */
export function formatSetScores(sets: SetScore[]): string {
  return sets.map(set => `${set.a}–${set.b}`).join(', ')
}

export function formatMatchTiebreak(tiebreak: MatchTiebreak | null): string {
  return tiebreak ? `${tiebreak.a}–${tiebreak.b}` : ''
}

/** Short status label for display. */
export function scoreboardStatusLabel(status: ScoreboardStatus): string {
  return status === 'not_started' ? 'Not started' : status === 'in_progress' ? 'In progress' : 'Final'
}
