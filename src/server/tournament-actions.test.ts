import { describe, expect, it } from 'vitest'
import { tournamentAction } from './tournament-actions.js'
import { createMockStore, mockToolsFor } from './action-test-harness.js'
import { awardPoint, createMatchScore, reviewResult } from '../lib/rally-score.js'
import type { Env } from '../../worker.js'

function call(
  store: ReturnType<typeof createMockStore>,
  userId: string,
  params: Record<string, unknown>,
) {
  return tournamentAction({
    userId,
    params,
    tools: mockToolsFor(store, userId),
    env: {} as Env,
    callerJwt: 'test-token',
  })
}

async function createTournament(
  store: ReturnType<typeof createMockStore>,
  host: string,
  overrides: Record<string, unknown> = {},
) {
  const result = await call(store, host, {
    operation: 'createTournament',
    name: 'Spring Cup',
    format: 'round-robin',
    ...overrides,
  })
  if (!result.success || !result.data || typeof result.data !== 'object' || !('recordId' in result.data)) {
    throw new Error(`Tournament creation failed: ${JSON.stringify(result)}`)
  }
  return result.data.recordId as string
}

async function addPlayers(store: ReturnType<typeof createMockStore>, host: string, tournamentId: string, players: string[]) {
  for (const userId of players) {
    const result = await call(store, host, { operation: 'addPlayer', tournamentId, userId })
    expect(result.success).toBe(true)
  }
}

async function getTournament(store: ReturnType<typeof createMockStore>, userId: string, tournamentId: string) {
  const result = await call(store, userId, { operation: 'getTournament', tournamentId })
  if (!result.success) throw new Error(`getTournament failed: ${JSON.stringify(result)}`)
  return result.data as {
    tournament: { status: string; format: string }
    players: { userId: string; seed: number }[]
    matches: { recordId: string; round: number; slot: number; playerIds: string[]; sessionId: string; status: string; winnerId: string }[]
    standings: { userId: string; played: number; wins: number }[]
  }
}

/** Play a session's scoreboard to a final result for `winnerSide` (0 or 1). */
function finalizeSessionScore(store: ReturnType<typeof createMockStore>, sessionId: string, winnerSide: 0 | 1) {
  const row = store.get('sessions')?.get(sessionId)
  if (!row) throw new Error(`Session ${sessionId} not found`)
  const players = (row.data as { title: string }).title
  void players
  const match = store.get('tournamentMatches')
  const matchRow = [...(match?.values() ?? [])].find(r => r.data.sessionId === sessionId)
  if (!matchRow) throw new Error(`No tournament match for session ${sessionId}`)
  const playerIds = JSON.parse(matchRow.data.playerIds as string) as string[]
  const teams: [string[], string[]] = [[playerIds[0]], [playerIds[1]]]
  let score = createMatchScore(teams)
  while (score.winner === null) score = awardPoint(score, winnerSide)
  let reviewed = reviewResult(score, playerIds[0], 'approve')
  if (!reviewed) throw new Error('First approval failed')
  reviewed = reviewResult(reviewed, playerIds[1], 'approve')
  if (!reviewed) throw new Error('Second approval failed')
  row.data.matchScore = JSON.stringify(reviewed)
}

/** Dispute a session's result as one of its players. */
function disputeSessionScore(store: ReturnType<typeof createMockStore>, sessionId: string, playerId: string) {
  const row = store.get('sessions')?.get(sessionId)
  if (!row) throw new Error(`Session ${sessionId} not found`)
  const match = store.get('tournamentMatches')
  const matchRow = [...(match?.values() ?? [])].find(r => r.data.sessionId === sessionId)
  if (!matchRow) throw new Error(`No tournament match for session ${sessionId}`)
  const playerIds = JSON.parse(matchRow.data.playerIds as string) as string[]
  const teams: [string[], string[]] = [[playerIds[0]], [playerIds[1]]]
  let score = createMatchScore(teams)
  while (score.winner === null) score = awardPoint(score, 0)
  const disputed = reviewResult(score, playerId, 'dispute')
  if (!disputed) throw new Error('Dispute failed')
  row.data.matchScore = JSON.stringify(disputed)
}

const MATCH_SESSION = {
  court: 'Schenley Oval',
  location: 'Pittsburgh',
  startsAt: '2030-01-01T12:00:00.000Z',
  durationMinutes: 90,
}

async function scheduleAllRoundOne(
  store: ReturnType<typeof createMockStore>,
  host: string,
  tournamentId: string,
) {
  const view = await getTournament(store, host, tournamentId)
  for (const match of view.matches.filter(m => m.round === 1 && m.status === 'pending')) {
    const result = await call(store, host, {
      operation: 'scheduleMatch',
      tournamentId,
      round: match.round,
      slot: match.slot,
      ...MATCH_SESSION,
    })
    expect(result.success).toBe(true)
  }
}

describe('tournament creation and players', () => {
  it('creates a tournament with the default 16-player cap', async () => {
    const store = createMockStore()
    const tournamentId = await createTournament(store, 'host')
    const view = await getTournament(store, 'host', tournamentId)
    expect(view.tournament).toMatchObject({ status: 'created', format: 'round-robin' })
    expect(store.get('tournaments')?.get(tournamentId)?.data).toMatchObject({ maxPlayers: 16, hostId: 'host' })
  })

  it('rejects invalid tournaments and non-host player management', async () => {
    const store = createMockStore()
    await expect(call(store, 'host', { operation: 'createTournament', name: '', format: 'round-robin' }))
      .resolves.toMatchObject({ success: false, error: expect.stringMatching(/name/) })
    await expect(call(store, 'host', { operation: 'createTournament', name: 'Cup', format: 'knockout' }))
      .resolves.toMatchObject({ success: false, error: expect.stringMatching(/format/) })
    const tournamentId = await createTournament(store, 'host')
    await expect(call(store, 'alice', { operation: 'addPlayer', tournamentId, userId: 'alice' }))
      .resolves.toMatchObject({ success: false, error: expect.stringMatching(/host/) })
  })

  it('adds players with seeds, is idempotent, and enforces the cap', async () => {
    const store = createMockStore()
    const tournamentId = await createTournament(store, 'host', { maxPlayers: 2 })
    await addPlayers(store, 'host', tournamentId, ['alice', 'bob'])
    const first = await call(store, 'host', { operation: 'addPlayer', tournamentId, userId: 'alice' })
    expect(first.success).toBe(true)
    await expect(call(store, 'host', { operation: 'addPlayer', tournamentId, userId: 'carol' }))
      .resolves.toMatchObject({ success: false, error: expect.stringMatching(/full/) })
    const view = await getTournament(store, 'host', tournamentId)
    expect(view.players.map(p => [p.userId, p.seed])).toEqual([['alice', 1], ['bob', 2]])
    await expect(call(store, 'host', { operation: 'removePlayer', tournamentId, userId: 'alice' }))
      .resolves.toMatchObject({ success: true })
    await expect(call(store, 'host', { operation: 'addPlayer', tournamentId, userId: 'carol' }))
      .resolves.toMatchObject({ success: true })
  })
})

describe('round-robin tournaments', () => {
  it('starts with every pairing exactly once and completes when all matches are final', async () => {
    const store = createMockStore()
    const tournamentId = await createTournament(store, 'host')
    await addPlayers(store, 'host', tournamentId, ['a', 'b', 'c', 'd'])
    await expect(call(store, 'host', { operation: 'startTournament', tournamentId }))
      .resolves.toMatchObject({ success: true })
    await expect(call(store, 'host', { operation: 'startTournament', tournamentId }))
      .resolves.toMatchObject({ success: false })
    let view = await getTournament(store, 'host', tournamentId)
    expect(view.tournament.status).toBe('in_progress')
    expect(view.matches).toHaveLength(6)
    expect(new Set(view.matches.map(m => m.round))).toEqual(new Set([1, 2, 3]))
    const pairs = view.matches.map(m => [...m.playerIds].sort().join('-')).sort()
    expect(pairs).toEqual(['a-b', 'a-c', 'a-d', 'b-c', 'b-d', 'c-d'])

    // Schedule and finalize every match; the winner is always side 0.
    for (const match of view.matches) {
      const scheduled = await call(store, 'host', {
        operation: 'scheduleMatch',
        tournamentId,
        round: match.round,
        slot: match.slot,
        ...MATCH_SESSION,
      })
      expect(scheduled.success).toBe(true)
    }
    view = await getTournament(store, 'host', tournamentId)
    for (const match of view.matches) {
      finalizeSessionScore(store, match.sessionId, 0)
    }
    const synced = await call(store, 'host', { operation: 'syncTournament', tournamentId })
    expect(synced).toMatchObject({ success: true, data: { status: 'completed', finalized: 6 } })
    view = await getTournament(store, 'host', tournamentId)
    expect(view.tournament.status).toBe('completed')
    expect(view.standings.map(row => row.userId)).toEqual(['a', 'b', 'c', 'd'])
    expect(view.standings[0]).toMatchObject({ played: 3, wins: 3 })
  })

  it('scheduling a match twice returns the same session', async () => {
    const store = createMockStore()
    const tournamentId = await createTournament(store, 'host')
    await addPlayers(store, 'host', tournamentId, ['a', 'b'])
    await call(store, 'host', { operation: 'startTournament', tournamentId })
    const first = await call(store, 'host', { operation: 'scheduleMatch', tournamentId, round: 1, slot: 0, ...MATCH_SESSION })
    const second = await call(store, 'host', { operation: 'scheduleMatch', tournamentId, round: 1, slot: 0, ...MATCH_SESSION })
    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    if (!first.success || !second.success) throw new Error('Expected scheduling to succeed')
    expect((first.data as { recordId: string }).recordId).toBe((second.data as { recordId: string }).recordId)
    expect(store.get('sessions')?.size).toBe(1)
  })
})

describe('single-elimination tournaments', () => {
  it('gives byes to top seeds, advances on finalized results, and completes at the final', async () => {
    const store = createMockStore()
    const tournamentId = await createTournament(store, 'host', { format: 'single-elimination', name: 'Knockout Cup' })
    await addPlayers(store, 'host', tournamentId, ['s1', 's2', 's3', 's4', 's5', 's6'])
    await call(store, 'host', { operation: 'startTournament', tournamentId })
    let view = await getTournament(store, 'host', tournamentId)
    expect(view.matches).toHaveLength(4)
    const byes = view.matches.filter(m => m.status === 'final')
    expect(byes.map(m => m.playerIds[0]).sort()).toEqual(['s1', 's2'])
    expect(byes.every(m => m.sessionId === '')).toBe(true)

    // Advancing too early is refused.
    await expect(call(store, 'host', { operation: 'advanceRound', tournamentId, round: 1 }))
      .resolves.toMatchObject({ success: false, error: expect.stringMatching(/final/) })

    // Finalize the two played round-1 matches (side 0 wins both).
    await scheduleAllRoundOne(store, 'host', tournamentId)
    view = await getTournament(store, 'host', tournamentId)
    for (const match of view.matches.filter(m => m.round === 1 && m.status === 'scheduled')) {
      finalizeSessionScore(store, match.sessionId, 0)
    }
    // Sync must NOT complete the tournament after round 1: round 2 does not exist yet.
    const syncedEarly = await call(store, 'host', { operation: 'syncTournament', tournamentId })
    expect(syncedEarly).toMatchObject({ success: true, data: { status: 'in_progress' } })

    await expect(call(store, 'host', { operation: 'advanceRound', tournamentId, round: 1 }))
      .resolves.toMatchObject({ success: true })
    view = await getTournament(store, 'host', tournamentId)
    const round2 = view.matches.filter(m => m.round === 2)
    expect(round2).toHaveLength(2)
    // Round 1 in bracket order: bye s1, s4-s5, bye s2, s3-s6. Winners in
    // slot order are s1, s4, s2, s3, so round 2 pairs s1-s4 and s2-s3 —
    // the top seeds still cannot meet before the final.
    expect(round2.map(m => [...m.playerIds].sort().join('-')).sort()).toEqual(['s1-s4', 's2-s3'])

    for (const match of round2) {
      const scheduled = await call(store, 'host', {
        operation: 'scheduleMatch', tournamentId, round: 2, slot: match.slot, ...MATCH_SESSION,
      })
      expect(scheduled.success).toBe(true)
      finalizeSessionScore(store, (scheduled.data as { recordId: string }).recordId, 0)
    }
    await expect(call(store, 'host', { operation: 'advanceRound', tournamentId, round: 2 }))
      .resolves.toMatchObject({ success: true })
    view = await getTournament(store, 'host', tournamentId)
    const final = view.matches.filter(m => m.round === 3)
    expect(final).toHaveLength(1)
    expect(final[0].playerIds).toEqual(['s1', 's2'])
    const scheduled = await call(store, 'host', {
      operation: 'scheduleMatch', tournamentId, round: 3, slot: 0, ...MATCH_SESSION,
    })
    expect(scheduled.success).toBe(true)
    finalizeSessionScore(store, (scheduled.data as { recordId: string }).recordId, 1)
    const synced = await call(store, 'host', { operation: 'syncTournament', tournamentId })
    expect(synced).toMatchObject({ success: true, data: { status: 'completed' } })
    view = await getTournament(store, 'host', tournamentId)
    expect(view.standings[0].userId).toBe('s2')
    expect(view.standings[0]).toMatchObject({ played: 2, wins: 2 })
    // Byes never count as wins: s1 played 2 (won semi, lost final), s2 played 2.
    expect(view.standings.find(row => row.userId === 's1')).toMatchObject({ played: 2, wins: 1 })
  })

  it('a disputed result never finalizes and never touches standings', async () => {
    const store = createMockStore()
    const tournamentId = await createTournament(store, 'host', { format: 'single-elimination' })
    await addPlayers(store, 'host', tournamentId, ['a', 'b'])
    await call(store, 'host', { operation: 'startTournament', tournamentId })
    await scheduleAllRoundOne(store, 'host', tournamentId)
    const view = await getTournament(store, 'host', tournamentId)
    const match = view.matches.find(m => m.round === 1 && m.status === 'scheduled')
    if (!match) throw new Error('Expected a scheduled match')
    disputeSessionScore(store, match.sessionId, match.playerIds[1])
    const synced = await call(store, 'host', { operation: 'syncTournament', tournamentId })
    expect(synced).toMatchObject({ success: true, data: { status: 'in_progress', finalized: 0 } })
    const after = await getTournament(store, 'host', tournamentId)
    expect(after.matches.find(m => m.recordId === match.recordId)?.status).toBe('scheduled')
    expect(after.standings.every(row => row.played === 0)).toBe(true)
    await expect(call(store, 'host', { operation: 'advanceRound', tournamentId, round: 1 }))
      .resolves.toMatchObject({ success: false })
  })
})

describe('tournament cancellation', () => {
  it('cancels pending and scheduled matches and their sessions, but keeps finalized results', async () => {
    const store = createMockStore()
    const tournamentId = await createTournament(store, 'host')
    await addPlayers(store, 'host', tournamentId, ['a', 'b', 'c'])
    await call(store, 'host', { operation: 'startTournament', tournamentId })
    await scheduleAllRoundOne(store, 'host', tournamentId)
    let view = await getTournament(store, 'host', tournamentId)
    // Finalize one match, leave the others scheduled/pending.
    const first = view.matches.find(m => m.status === 'scheduled')
    if (!first) throw new Error('Expected a scheduled match')
    finalizeSessionScore(store, first.sessionId, 0)
    await call(store, 'host', { operation: 'syncTournament', tournamentId })
    await expect(call(store, 'alice', { operation: 'cancelTournament', tournamentId }))
      .resolves.toMatchObject({ success: false })
    await expect(call(store, 'host', { operation: 'cancelTournament', tournamentId }))
      .resolves.toMatchObject({ success: true })
    view = await getTournament(store, 'host', tournamentId)
    expect(view.tournament.status).toBe('cancelled')
    const finalMatch = view.matches.find(m => m.recordId === first.recordId)
    expect(finalMatch?.status).toBe('final')
    expect(view.matches.filter(m => m.status === 'cancelled').length).toBeGreaterThan(0)
    expect(store.get('sessions')?.get(first.sessionId)?.data.status).toBe('open')
    const cancelledSession = view.matches.find(m => m.status === 'cancelled' && m.sessionId)
    if (cancelledSession) {
      expect(store.get('sessions')?.get(cancelledSession.sessionId)?.data.status).toBe('cancelled')
    }
    await expect(call(store, 'host', { operation: 'cancelTournament', tournamentId }))
      .resolves.toMatchObject({ success: true })
  })
})
