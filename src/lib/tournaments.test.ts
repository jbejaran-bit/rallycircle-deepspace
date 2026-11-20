import { describe, expect, it } from 'vitest'
import {
  computeStandings,
  generateRoundRobin,
  generateSingleEliminationFirstRound,
  nextPowerOfTwo,
  nextRoundPairings,
  seedingOrder,
  singleEliminationRounds,
  validateTournament,
  type StandingInput,
} from './tournaments.js'

const players4 = ['p1', 'p2', 'p3', 'p4']
const players5 = ['p1', 'p2', 'p3', 'p4', 'p5']

describe('validateTournament', () => {
  it('accepts both formats within the player cap', () => {
    expect(validateTournament({ name: 'Spring Ladder', format: 'round-robin', maxPlayers: 8 })).toBeNull()
    expect(validateTournament({ name: 'Cup', format: 'single-elimination' })).toBeNull()
  })

  it('rejects bad names, formats, and player limits', () => {
    expect(validateTournament({ name: '', format: 'round-robin' })).toMatch(/name/)
    expect(validateTournament({ name: 'x'.repeat(73), format: 'round-robin' })).toMatch(/name/)
    expect(validateTournament({ name: 'Cup', format: 'knockout' })).toMatch(/format/)
    expect(validateTournament({ name: 'Cup', format: 'round-robin', maxPlayers: 1 })).toMatch(/player limit/)
    expect(validateTournament({ name: 'Cup', format: 'round-robin', maxPlayers: 17 })).toMatch(/player limit/)
  })
})

describe('generateRoundRobin', () => {
  it('4 players: 3 rounds, every pair meets exactly once', () => {
    const fixtures = generateRoundRobin(players4)
    expect(fixtures).toHaveLength(6)
    const rounds = new Map<number, string[][]>()
    for (const { round, players } of fixtures) {
      rounds.set(round, [...(rounds.get(round) ?? []), [...players].sort()])
    }
    expect([...rounds.keys()].sort()).toEqual([1, 2, 3])
    for (const matches of rounds.values()) expect(matches).toHaveLength(2)
    const pairs = fixtures.map(({ players }) => [...players].sort().join('-')).sort()
    expect(pairs).toEqual(['p1-p2', 'p1-p3', 'p1-p4', 'p2-p3', 'p2-p4', 'p3-p4'])
  })

  it('5 players: 10 matches, 5 rounds, every player sits out exactly once', () => {
    const fixtures = generateRoundRobin(players5)
    expect(fixtures).toHaveLength(10)
    const rounds = new Map<number, string[]>()
    for (const { round, players } of fixtures) {
      rounds.set(round, [...(rounds.get(round) ?? []), ...players])
    }
    expect([...rounds.keys()].sort()).toEqual([1, 2, 3, 4, 5])
    const byes = new Map<string, number>()
    for (const [round, playing] of rounds) {
      expect(playing).toHaveLength(4)
      for (const player of players5) {
        if (!playing.includes(player)) byes.set(player, (byes.get(player) ?? 0) + 1)
      }
      expect(round).toBeGreaterThan(0)
    }
    expect([...byes.values()].sort()).toEqual([1, 1, 1, 1, 1])
    const pairs = fixtures.map(({ players }) => [...players].sort().join('-')).sort()
    expect(new Set(pairs).size).toBe(10)
  })

  it('2 players: a single match; duplicates and out-of-range counts throw', () => {
    expect(generateRoundRobin(['a', 'b'])).toEqual([{ round: 1, slot: 0, players: ['a', 'b'] }])
    expect(() => generateRoundRobin(['a', 'a'])).toThrow(/distinct/)
    expect(() => generateRoundRobin(['a'])).toThrow(/2–16/)
    expect(() => generateRoundRobin(Array.from({ length: 17 }, (_, i) => `p${i}`))).toThrow(/2–16/)
  })
})

describe('generateSingleEliminationFirstRound', () => {
  it('8 players: 4 matches, no byes, top seed meets bottom seed', () => {
    const matches = generateSingleEliminationFirstRound(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'])
    expect(matches).toHaveLength(4)
    expect(matches.every(m => !m.bye)).toBe(true)
    expect(matches.map(m => [...m.players].sort().join('-')).sort()).toEqual([
      's1-s8', 's2-s7', 's3-s6', 's4-s5',
    ])
  })

  it('6 players: bracket of 8, the top 2 seeds get byes', () => {
    const matches = generateSingleEliminationFirstRound(['s1', 's2', 's3', 's4', 's5', 's6'])
    expect(matches).toHaveLength(4)
    const byes = matches.filter(m => m.bye)
    expect(byes.map(m => m.players[0]).sort()).toEqual(['s1', 's2'])
    const played = matches.filter(m => !m.bye).map(m => [...m.players].sort().join('-')).sort()
    expect(played).toEqual(['s3-s6', 's4-s5'])
  })

  it('3 players: bracket of 4, only the top seed gets a bye', () => {
    const matches = generateSingleEliminationFirstRound(['s1', 's2', 's3'])
    expect(matches).toHaveLength(2)
    expect(matches.filter(m => m.bye).map(m => m.players[0])).toEqual(['s1'])
    expect(matches.filter(m => !m.bye).map(m => m.players)).toEqual([['s2', 's3']])
  })

  it('2 players: a single final; 5 players: 3 byes, one played match', () => {
    expect(generateSingleEliminationFirstRound(['a', 'b'])).toEqual([
      { round: 1, slot: 0, players: ['a', 'b'], bye: false },
    ])
    const five = generateSingleEliminationFirstRound(['s1', 's2', 's3', 's4', 's5'])
    expect(five.filter(m => m.bye)).toHaveLength(3)
    expect(five.filter(m => !m.bye).map(m => m.players)).toEqual([['s4', 's5']])
  })

  it('bracket sizes: 5 players need 3 rounds', () => {
    expect(nextPowerOfTwo(5)).toBe(8)
    expect(nextPowerOfTwo(8)).toBe(8)
    expect(singleEliminationRounds(5)).toBe(3)
    expect(singleEliminationRounds(16)).toBe(4)
  })

  it('seeding order keeps the top seeds apart until the late rounds', () => {
    expect(seedingOrder(2)).toEqual([1, 2])
    expect(seedingOrder(4)).toEqual([1, 4, 2, 3])
    expect(seedingOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6])
    expect(seedingOrder(16)).toEqual([1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11])
  })
})

describe('nextRoundPairings', () => {
  it('pairs winners in slot order', () => {
    expect(nextRoundPairings([
      { slot: 0, winnerId: 'a' },
      { slot: 1, winnerId: 'b' },
      { slot: 2, winnerId: 'c' },
      { slot: 3, winnerId: 'd' },
    ])).toEqual([
      { slot: 0, players: ['a', 'b'] },
      { slot: 1, players: ['c', 'd'] },
    ])
  })

  it('refuses to advance when a match is not final or the round is odd-sized', () => {
    expect(() => nextRoundPairings([{ slot: 0, winnerId: '' }, { slot: 1, winnerId: 'b' }])).toThrow(/not final/)
    expect(() => nextRoundPairings([{ slot: 0, winnerId: 'a' }])).toThrow(/even number/)
  })
})

function finalized(
  playerIds: string[],
  winnerId: string,
  teams: [string[], string[]],
  sets: [number, number][],
): StandingInput {
  return {
    playerIds,
    status: 'final',
    winnerId,
    result: { teams, sets, winnerId },
  }
}

describe('computeStandings', () => {
  it('ranks by wins, then set difference, then game difference', () => {
    // a beats b 6-4 6-4; a beats c 6-0 6-0; b beats c 7-6 6-7 7-6.
    const standings = computeStandings(['a', 'b', 'c'], [
      finalized(['a', 'b'], 'a', [['a'], ['b']], [[6, 4], [6, 4]]),
      finalized(['a', 'c'], 'a', [['a'], ['c']], [[6, 0], [6, 0]]),
      finalized(['b', 'c'], 'b', [['b'], ['c']], [[7, 6], [6, 7], [7, 6]]),
    ])
    expect(standings.map(row => row.userId)).toEqual(['a', 'b', 'c'])
    expect(standings[0]).toMatchObject({ played: 2, wins: 2, setsWon: 4, setsLost: 0, gamesWon: 24, gamesLost: 8 })
    expect(standings[1]).toMatchObject({ played: 2, wins: 1, setsWon: 2, setsLost: 3 })
    expect(standings[2]).toMatchObject({ played: 2, wins: 0 })
  })

  it('counts a win for the side-1 winner correctly', () => {
    const standings = computeStandings(['a', 'b'], [
      finalized(['a', 'b'], 'b', [['a'], ['b']], [[4, 6], [3, 6]]),
    ])
    expect(standings.map(row => row.userId)).toEqual(['b', 'a'])
    expect(standings[0]).toMatchObject({ wins: 1, setsWon: 2, gamesWon: 12, gamesLost: 7 })
  })

  it('ignores disputed, unfinalized, and bye matches entirely', () => {
    const standings = computeStandings(['a', 'b', 'c'], [
      finalized(['a', 'b'], 'a', [['a'], ['b']], [[6, 4], [6, 4]]),
      { playerIds: ['a', 'c'], status: 'final', winnerId: 'c', result: undefined },
      { playerIds: ['b', 'c'], status: 'pending', winnerId: '', result: undefined },
      { playerIds: ['a'], status: 'final', winnerId: 'a', result: undefined },
    ])
    // b and c tie on wins (0) and set difference (0); c ranks above b on
    // game difference (0 vs −4), which is the documented tiebreaker order.
    expect(standings.map(row => row.userId)).toEqual(['a', 'c', 'b'])
    expect(standings[0]).toMatchObject({ played: 1, wins: 1 })
    expect(standings[1]).toMatchObject({ played: 0, wins: 0 })
    expect(standings[2]).toMatchObject({ played: 1, wins: 0 })
  })

  it('breaks exact ties by player id, deterministically', () => {
    const standings = computeStandings(['b', 'a'], [])
    expect(standings.map(row => row.userId)).toEqual(['a', 'b'])
  })
})
