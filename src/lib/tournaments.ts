/**
 * Tournaments / leagues — pure fixture generation, bracket progression, and
 * standings. No imports, no I/O: every function is deterministic in its
 * inputs, so the same player list always produces the same fixtures.
 *
 * Ground rules (see docs/track-ij-contracts.md):
 *
 * - Player order is seed order. The host supplies players in seed order;
 *   `sortPlayersBySeed` makes that explicit at the action layer.
 * - A tournament match is an ordinary RallyCircle session (linked by
 *   `sessionId`) scored through the existing scoreboard flow. A result
 *   counts only once it is genuinely finalized: winner set, not disputed,
 *   every recorded participant approved (`resultStatus() === 'final'`).
 * - A bye is a free advance, never a win: bye matches are excluded from
 *   standings. No rating is ever consulted.
 * - Standings tiebreakers, in order: match wins, set difference, game
 *   difference, then player id ascending (deterministic, never random).
 */

export type TournamentFormat = 'round-robin' | 'single-elimination'
export type TournamentStatus = 'created' | 'in_progress' | 'completed' | 'cancelled'
export type TournamentMatchStatus = 'pending' | 'scheduled' | 'final' | 'cancelled'

/** Cap on players in one tournament; keeps fixtures and standings bounded. */
export const TOURNAMENT_MAX_PLAYERS = 16
export const TOURNAMENT_MIN_PLAYERS = 2
export const TOURNAMENT_NAME_MAX_LENGTH = 72

export interface Tournament {
  name: string
  format: TournamentFormat
  status: TournamentStatus
  hostId: string
  maxPlayers: number
}

export interface TournamentPlayer {
  tournamentId: string
  userId: string
  /** 1-based seed; players are ordered by seed before fixtures are drawn. */
  seed: number
  status: 'active' | 'withdrawn'
}

export interface TournamentMatchInput {
  tournamentId: string
  /** 1-based round number. */
  round: number
  /** 0-based slot within the round. */
  slot: number
  /** One player (a bye) or two players. */
  playerIds: string[]
  sessionId: string
  status: TournamentMatchStatus
  /** Winner user id once the match is final; '' otherwise. */
  winnerId: string
}

/** One set score, [side 0 games, side 1 games], in the match's team order. */
export type SetScore = readonly [number, number]

export interface FinalizedMatchResult {
  /** The two teams' player ids, in the same order as `sets` sides. */
  teams: readonly (readonly string[])[]
  sets: readonly SetScore[]
  winnerId: string
}

export function validateTournament(input: { name?: unknown; format?: unknown; maxPlayers?: unknown }): string | null {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > TOURNAMENT_NAME_MAX_LENGTH) {
    return 'Use a tournament name between 1 and 72 characters.'
  }
  if (input.format !== 'round-robin' && input.format !== 'single-elimination') {
    return 'Choose a tournament format.'
  }
  if (
    input.maxPlayers !== undefined &&
    (typeof input.maxPlayers !== 'number' ||
      !Number.isInteger(input.maxPlayers) ||
      input.maxPlayers < TOURNAMENT_MIN_PLAYERS ||
      input.maxPlayers > TOURNAMENT_MAX_PLAYERS)
  ) {
    return `Choose a player limit between ${TOURNAMENT_MIN_PLAYERS} and ${TOURNAMENT_MAX_PLAYERS}.`
  }
  return null
}

/** Sort tournament players into seed order (seed ascending, then user id). */
export function sortPlayersBySeed(players: readonly TournamentPlayer[]): TournamentPlayer[] {
  return [...players].sort((a, b) => a.seed - b.seed || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
}

/**
 * Round-robin fixtures by the circle method.
 *
 * `playerIds` must already be in seed order and contain 2–16 distinct ids.
 * Returns one entry per pairing; `round` is 1-based, `slot` 0-based within
 * the round. With an odd count every round has exactly one bye: the bye
 * player sits out that round and no match row is produced for them.
 * Every pair meets exactly once; every player has exactly one bye when the
 * count is odd.
 */
export function generateRoundRobin(
  playerIds: readonly string[],
): { round: number; slot: number; players: [string, string] }[] {
  const players = [...playerIds]
  if (players.length < TOURNAMENT_MIN_PLAYERS || players.length > TOURNAMENT_MAX_PLAYERS) {
    throw new Error(`Round-robin needs ${TOURNAMENT_MIN_PLAYERS}–${TOURNAMENT_MAX_PLAYERS} players.`)
  }
  if (new Set(players).size !== players.length) throw new Error('Players must be distinct.')

  const withBye = players.length % 2 === 1 ? [...players, null] : players
  const rounds = withBye.length - 1
  const fixtures: { round: number; slot: number; players: [string, string] }[] = []
  const circle = [...withBye]
  for (let round = 0; round < rounds; round++) {
    let slot = 0
    for (let i = 0; i < circle.length / 2; i++) {
      const a = circle[i]
      const b = circle[circle.length - 1 - i]
      if (a !== null && b !== null) fixtures.push({ round: round + 1, slot: slot++, players: [a, b] })
    }
    // Rotate every position except the first (the fixed pivot).
    circle.splice(1, 0, circle.pop() as string | null)
  }
  return fixtures
}

/** Smallest power of two >= n (n >= 2). */
export function nextPowerOfTwo(n: number): number {
  let size = 2
  while (size < n) size *= 2
  return size
}

/**
 * First-round matches for a single-elimination bracket.
 *
 * `playerIds` must already be in seed order and contain 2–16 distinct ids.
 * The bracket is the next power of two; the top seeds receive byes first
 * (seed 1, then 2, …). Matches are emitted in standard bracket order:
 * positions are seeded so the strongest seeds meet as late as possible
 * (for a bracket of 8 the position order is 1, 8, 4, 5, 2, 7, 3, 6), and
 * adjacent positions are paired. A pair with one absent seed is a bye,
 * returned as a one-player match with `bye: true` — the player advances
 * without playing. Because byes sit in their proper bracket positions,
 * pairing round winners in slot order always reproduces the bracket.
 */
export function generateSingleEliminationFirstRound(
  playerIds: readonly string[],
): { round: number; slot: number; players: string[]; bye: boolean }[] {
  const players = [...playerIds]
  if (players.length < TOURNAMENT_MIN_PLAYERS || players.length > TOURNAMENT_MAX_PLAYERS) {
    throw new Error(`Single elimination needs ${TOURNAMENT_MIN_PLAYERS}–${TOURNAMENT_MAX_PLAYERS} players.`)
  }
  if (new Set(players).size !== players.length) throw new Error('Players must be distinct.')

  const size = nextPowerOfTwo(players.length)
  const seeding = seedingOrder(size)
  const matches: { round: number; slot: number; players: string[]; bye: boolean }[] = []
  let slot = 0
  for (let i = 0; i < size; i += 2) {
    const first = seeding[i] <= players.length ? players[seeding[i] - 1] : null
    const second = seeding[i + 1] <= players.length ? players[seeding[i + 1] - 1] : null
    if (first !== null && second !== null) {
      matches.push({ round: 1, slot: slot++, players: [first, second], bye: false })
    } else if (first !== null || second !== null) {
      matches.push({ round: 1, slot: slot++, players: [first ?? second as string], bye: true })
    }
    // Both absent cannot happen: more than half the bracket is filled.
  }
  return matches
}

/**
 * Standard seeding order for a bracket of `size` (a power of two >= 2):
 * the seed placed at each bracket position, so adjacent positions pair
 * seed 1 with the last seed, 4 with 5, and so on. Built recursively:
 * order(2n) interleaves order(n) with its mirror (2n + 1 − seed).
 */
export function seedingOrder(size: number): number[] {
  if (size === 2) return [1, 2]
  const half = seedingOrder(size / 2)
  return half.flatMap(seed => [seed, size + 1 - seed])
}

/**
 * Pair the winners of one round into the next round, in slot order.
 * Throws when a match has no winner — a round may only advance once every
 * match in it is final (byes count as final: their single player is the
 * winner).
 */
export function nextRoundPairings(
  previousRound: readonly { slot: number; winnerId: string }[],
): { slot: number; players: [string, string] }[] {
  const ordered = [...previousRound].sort((a, b) => a.slot - b.slot)
  if (ordered.length === 0) throw new Error('Cannot advance an empty round.')
  if (ordered.length % 2 !== 0) throw new Error('A round must have an even number of matches to advance.')
  const winners = ordered.map(match => {
    if (!match.winnerId) throw new Error('A match in this round is not final yet.')
    return match.winnerId
  })
  const pairings: { slot: number; players: [string, string] }[] = []
  for (let i = 0; i < winners.length; i += 2) {
    pairings.push({ slot: i / 2, players: [winners[i], winners[i + 1]] })
  }
  return pairings
}

/** How many rounds a single-elimination bracket of `size` players needs. */
export function singleEliminationRounds(size: number): number {
  return Math.log2(nextPowerOfTwo(size))
}

export interface StandingRow {
  userId: string
  played: number
  wins: number
  losses: number
  setsWon: number
  setsLost: number
  gamesWon: number
  gamesLost: number
}

export interface StandingInput {
  /** Match participants in team order; one player means a bye. */
  playerIds: readonly string[]
  /** Only 'final' matches with a winner reach this function; see below. */
  status: TournamentMatchStatus
  winnerId: string
  /** Finalized result, if the match was played through the scoreboard. */
  result?: FinalizedMatchResult
}

/**
 * Standings from eligible finalized results only.
 *
 * The caller must pass only matches whose result is genuinely finalized
 * (`resultStatus() === 'final'`). A match passed here without a `result`
 * (for example a bye) is skipped: byes never count as wins. Disputed or
 * unfinalized results must never be passed in — the server action filters
 * them out before calling this function, and this function refuses any
 * match whose status is not 'final'.
 *
 * Sorting: wins desc, set difference desc, game difference desc, then
 * player id ascending (deterministic, never random).
 */
export function computeStandings(
  playerIds: readonly string[],
  matches: readonly StandingInput[],
): StandingRow[] {
  const table = new Map<string, StandingRow>()
  for (const userId of playerIds) {
    table.set(userId, {
      userId, played: 0, wins: 0, losses: 0, setsWon: 0, setsLost: 0, gamesWon: 0, gamesLost: 0,
    })
  }
  for (const match of matches) {
    if (match.status !== 'final') continue
    if (match.playerIds.length < 2 || !match.result) continue
    if (!match.winnerId || !match.playerIds.includes(match.winnerId)) continue
    const { teams, sets } = match.result
    const loserTeams = teams.filter(team => !team.includes(match.winnerId))
    if (teams.length !== 2 || loserTeams.length !== 1) continue
    const winnerTeam = teams.find(team => team.includes(match.winnerId)) as readonly string[]
    const loserTeam = loserTeams[0]
    let winnerSets = 0
    let loserSets = 0
    let winnerGames = 0
    let loserGames = 0
    for (const [a, b] of sets) {
      winnerGames += a
      loserGames += b
      if (a > b) winnerSets++
      else if (b > a) loserSets++
    }
    // `sets` are recorded in team order: side 0 is teams[0]. If the winner
    // is side 1, the tallies above are backwards — swap them.
    const winnerIsSideOne = teams[1].includes(match.winnerId)
    const wSets = winnerIsSideOne ? loserSets : winnerSets
    const lSets = winnerIsSideOne ? winnerSets : loserSets
    const wGames = winnerIsSideOne ? loserGames : winnerGames
    const lGames = winnerIsSideOne ? winnerGames : loserGames
    for (const userId of winnerTeam) {
      const row = table.get(userId)
      if (!row) continue
      row.played++
      row.wins++
      row.setsWon += wSets
      row.setsLost += lSets
      row.gamesWon += wGames
      row.gamesLost += lGames
    }
    for (const userId of loserTeam) {
      const row = table.get(userId)
      if (!row) continue
      row.played++
      row.losses++
      row.setsWon += lSets
      row.setsLost += wSets
      row.gamesWon += lGames
      row.gamesLost += wGames
    }
  }
  return [...table.values()].sort(
    (a, b) =>
      b.wins - a.wins ||
      (b.setsWon - b.setsLost) - (a.setsWon - a.setsLost) ||
      (b.gamesWon - b.gamesLost) - (a.gamesWon - a.gamesLost) ||
      (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
  )
}
