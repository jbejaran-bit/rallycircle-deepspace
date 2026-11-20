/**
 * RallyCircle Rating — pure deterministic engine (algorithm version 1).
 *
 * Original Elo-style system. See docs/RATING_SPEC.md for the full
 * specification, assumptions, and worked example. This module is pure: no
 * imports, no I/O, no timestamps, no randomness — the same inputs always
 * produce the same outputs, which is what makes it testable.
 *
 * EXPERIMENTAL: ratings are RallyCircle's own community rating. Never a UTR
 * score, never equivalent to NTRP/UTR or any proprietary ranking, never
 * presented as scientifically validated.
 */

export const RATING_ALGORITHM_VERSION = 1
export const RATING_START = 1200
export const RATING_MIN = 100
export const RATING_MAX = 3000
/** Fewer finalized matches than this in a format means provisional. */
export const PROVISIONAL_MATCH_THRESHOLD = 10
/** Prior finalized matches vs the same opponent before K is halved. */
export const REPEAT_OPPONENT_THRESHOLD = 3

export type RatingFormat = 'Singles' | 'Doubles'

export interface PlayerRatingState {
  playerId: string
  rating: number
  /** Finalized matches already played in this format, before this result. */
  matchesPlayed: number
}

export interface FinalizedResultInput {
  /** Unique idempotency key: `session:<sessionId>:rev:<revision>`. */
  resultId: string
  sessionId: string
  format: RatingFormat
  /** [team A player ids, team B player ids]; 1 each for singles, 2 for doubles. */
  teams: [string[], string[]]
  /** 0 if team A won, 1 if team B won. */
  winner: 0 | 1
}

export interface RatingChange {
  playerId: string
  format: RatingFormat
  before: number
  after: number
  delta: number
  /** K used for this update (after repeat-opponent dampening, if any). */
  k: number
  /** Expected score (win probability) before the match, 0..1. */
  expected: number
  /** Opponent player ids, for repeat-opponent counting and explanation. */
  opponentIds: string[]
  /** Matches played in this format after this result is applied. */
  matchesPlayedAfter: number
  provisionalAfter: boolean
  explanation: string
}

export type RatingOutcome =
  | { ok: true; changes: RatingChange[] }
  | { ok: false; error: string }

export function resultIdFor(sessionId: string, revision: number): string {
  return `session:${sessionId}:rev:${revision}`
}

export function isProvisional(matchesPlayed: number): boolean {
  return matchesPlayed < PROVISIONAL_MATCH_THRESHOLD
}

/** Confidence indicator: share of the provisional threshold reached, 0..1. */
export function provisionalConfidence(matchesPlayed: number): number {
  return Math.min(1, Math.max(0, matchesPlayed / PROVISIONAL_MATCH_THRESHOLD))
}

/** Expected score for a player rated `rating` against `opponentRating`. */
export function expectedScore(rating: number, opponentRating: number): number {
  return 1 / (1 + Math.pow(10, (opponentRating - rating) / 400))
}

/**
 * K-factor schedule. New players move fast (rating mostly unknown);
 * established players move slowly. Halved after REPEAT_OPPONENT_THRESHOLD
 * prior finalized matches against the same opponent (dampens farming one
 * opponent or staging repeated matches).
 */
export function kFactor(matchesPlayed: number, repeatCount: number): number {
  const base = matchesPlayed < 10 ? 40 : matchesPlayed < 30 ? 32 : 24
  return repeatCount >= REPEAT_OPPONENT_THRESHOLD ? base / 2 : base
}

export function clampRating(value: number): number {
  return Math.min(RATING_MAX, Math.max(RATING_MIN, Math.round(value)))
}

function displayName(playerId: string): string {
  // Player ids are opaque auth ids; the UI replaces them with display names.
  // The explanation keeps the id so it is never ambiguous in logs/history.
  return playerId
}

/** Validate a finalized result before it can affect any rating. */
export function validateFinalizedInput(input: FinalizedResultInput): string | null {
  if (!input.resultId || !input.sessionId) return 'A finalized result needs a session and a result id.'
  if (input.format !== 'Singles' && input.format !== 'Doubles') return 'Ratings only apply to Singles and Doubles results.'
  if (input.winner !== 0 && input.winner !== 1) return 'A finalized result needs a winner.'
  const [teamA, teamB] = input.teams
  const want = input.format === 'Singles' ? 1 : 2
  if (!Array.isArray(teamA) || !Array.isArray(teamB) || teamA.length !== want || teamB.length !== want) {
    return `A ${input.format} result needs ${want} player${want > 1 ? 's' : ''} per side.`
  }
  const all = [...teamA, ...teamB]
  if (all.some(player => typeof player !== 'string' || !player)) return 'Every player needs a valid authenticated id.'
  if (new Set(all).size !== all.length) return 'A player cannot appear on both sides of a match.'
  return null
}

function explainChange(
  playerId: string,
  format: RatingFormat,
  won: boolean,
  opponentIds: string[],
  opponentRating: number,
  expected: number,
  k: number,
  delta: number,
): string {
  const opponents = opponentIds.map(displayName).join(' and ')
  const verb = won ? 'Beat' : 'Lost to'
  const chance = `${Math.round(expected * 100)}%`
  const signed = delta >= 0 ? `+${delta}` : `${delta}`
  return `${verb} ${opponents} (${opponentRating}) in ${format.toLowerCase()} · expected win chance ${chance} · K ${k} · ${signed} (player ${playerId})`
}

/**
 * Apply one finalized result to the given per-player states.
 *
 * @param input the finalized result (already checked to be final by the caller)
 * @param states current rating state per player id (missing = new player at RATING_START, 0 matches)
 * @param repeatCounts prior finalized matches per player against the opponent(s)
 *   of this result: for singles, vs that exact opponent; for doubles, matches
 *   in which the player faced at least one member of the opposing team.
 */
export function applyFinalizedResult(
  input: FinalizedResultInput,
  states: ReadonlyMap<string, PlayerRatingState>,
  repeatCounts: ReadonlyMap<string, number> = new Map(),
): RatingOutcome {
  const invalid = validateFinalizedInput(input)
  if (invalid) return { ok: false, error: invalid }

  const [teamA, teamB] = input.teams
  const stateOf = (playerId: string): PlayerRatingState =>
    states.get(playerId) ?? { playerId, rating: RATING_START, matchesPlayed: 0 }
  const ratingOf = (playerId: string): number => stateOf(playerId).rating

  // Team rating is the mean of its partners (doubles); for singles it is the
  // single player's rating. Each player is updated against the opposing
  // team's mean, with their own K and expected score.
  const teamMean = (team: string[]): number =>
    team.reduce((sum, playerId) => sum + ratingOf(playerId), 0) / team.length
  const meanA = teamMean(teamA)
  const meanB = teamMean(teamB)

  const changes: RatingChange[] = []
  for (const side of [0, 1] as const) {
    const team = side === 0 ? teamA : teamB
    const opponents = side === 0 ? teamB : teamA
    const opponentMean = side === 0 ? meanB : meanA
    const won = input.winner === side
    const outcome = won ? 1 : 0
    for (const playerId of team) {
      const state = stateOf(playerId)
      const k = kFactor(state.matchesPlayed, repeatCounts.get(playerId) ?? 0)
      const expected = expectedScore(state.rating, opponentMean)
      const delta = Math.round(k * (outcome - expected))
      const after = clampRating(state.rating + delta)
      const matchesPlayedAfter = state.matchesPlayed + 1
      changes.push({
        playerId,
        format: input.format,
        before: state.rating,
        after,
        delta: after - state.rating,
        k,
        expected,
        opponentIds: [...opponents],
        matchesPlayedAfter,
        provisionalAfter: isProvisional(matchesPlayedAfter),
        explanation: explainChange(
          playerId, input.format, won, opponents, Math.round(opponentMean), expected, k, after - state.rating,
        ),
      })
    }
  }
  return { ok: true, changes }
}

/** Negate a recorded change (correction/invalidation). History is never edited.
 *  The reversed match no longer counts toward matches played either. */
export function reverseChange(change: RatingChange): RatingChange {
  const matchesPlayedAfter = Math.max(0, change.matchesPlayedAfter - 1)
  return {
    ...change,
    before: change.after,
    after: change.before,
    delta: -change.delta,
    matchesPlayedAfter,
    provisionalAfter: isProvisional(matchesPlayedAfter),
    explanation: `Reversal of ${change.explanation}`,
  }
}
