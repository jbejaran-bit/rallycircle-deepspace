import { describe, expect, it } from 'vitest'
import {
  applyFinalizedResultToStore,
  finalizedResultsFromSessions,
  readPlayerRating,
  reverseRatingEffect,
  type RatingRecordTool,
} from './rating-records.js'
import { createMatchScore, awardPoint, reviewResult } from '../lib/rally-score.js'
import { resultIdFor } from '../lib/rating.js'
import type { RallySession } from '../lib/rally.js'

/** In-memory stand-in for the records tools API (`records.query/create/update`). */
function createMockTool() {
  const tables = new Map<string, { recordId: string; data: Record<string, unknown> }[]>()
  let nextId = 1
  const tool = (async (name: string, params: Record<string, unknown>) => {
    const collection = params.collection as string
    const rows = tables.get(collection) ?? []
    if (name === 'records.query') {
      const where = (params.where ?? {}) as Record<string, unknown>
      const limit = (params.limit as number | undefined) ?? 100
      const matches = rows.filter(row =>
        Object.entries(where).every(([key, value]) => row.data[key] === value),
      )
      return { success: true, data: { records: matches.slice(0, limit) } }
    }
    if (name === 'records.create') {
      const recordId = `rec_${nextId++}`
      rows.push({ recordId, data: params.data as Record<string, unknown> })
      tables.set(collection, rows)
      return { success: true, data: { recordId } }
    }
    if (name === 'records.update') {
      const row = rows.find(r => r.recordId === params.recordId)
      if (!row) return { success: false, error: 'Record not found.' }
      row.data = { ...row.data, ...(params.data as Record<string, unknown>) }
      return { success: true, data: { recordId: row.recordId } }
    }
    return { success: false, error: `Unknown tool ${name}.` }
  }) as unknown as RatingRecordTool
  return { tool, tables }
}

const session = (matchScore: string | undefined, format: RallySession['format'] = 'Singles'): {
  recordId: string
  data: RallySession
} => ({
  recordId: 'sess1',
  data: {
    format, matchScore, title: 'Saturday hit', court: 'Schenley', location: 'Pittsburgh',
    startsAt: '2026-11-21T14:00:00Z', durationMinutes: 90, targetPlayers: 2,
    level: 'Intermediate', notes: '', hostId: 'ana', chatChannelId: '', status: 'open',
  },
})

/** A finalized singles score: Ana beats Bea, both approved. */
function finalizedScore() {
  let score = createMatchScore([['ana'], ['bea']])
  // Ana wins two sets 6–0 (8 straight points per set: 4 points × 6 games,
  // simplified by awarding points until the winner is set).
  while (score.winner === null) score = awardPoint(score, 0)
  const approved = reviewResult(score, 'ana', 'approve')
  if (!approved) throw new Error('ana approval failed in fixture')
  const final = reviewResult(approved, 'bea', 'approve')
  if (!final) throw new Error('bea approval failed in fixture')
  return final
}

describe('finalizedResultsFromSessions', () => {
  it('counts only finalized results', () => {
    const final = finalizedScore()
    expect(final.winner).toBe(0)
    const results = finalizedResultsFromSessions([
      session(JSON.stringify(final)),
      session(JSON.stringify(createMatchScore([['ana'], ['bea']]))), // in progress
      session(JSON.stringify({ ...final, approvals: ['ana'] })), // confirmed, not final
      session(JSON.stringify({ ...final, disputed: true })), // disputed
    ])
    expect(results).toHaveLength(1)
    expect(results[0].format).toBe('Singles')
    expect(results[0].winner).toBe(0)
    expect(results[0].resultId).toBe(resultIdFor('sess1', final.revision))
  })

  it('ignores practice sessions and missing scores', () => {
    const results = finalizedResultsFromSessions([
      session(JSON.stringify(finalizedScore()), 'Practice'),
      session(undefined),
    ])
    expect(results).toHaveLength(0)
  })
})

describe('applyFinalizedResultToStore', () => {
  const input = {
    resultId: resultIdFor('sess1', 3),
    sessionId: 'sess1',
    format: 'Singles' as const,
    teams: [['ana'], ['bea']] as [string[], string[]],
    winner: 0 as const,
  }

  it('applies a finalized result and writes current ratings + history', async () => {
    const { tool } = createMockTool()
    const outcome = await applyFinalizedResultToStore(input, tool, 'system')
    expect(outcome.applied).toBe(true)
    expect(outcome.error).toBeUndefined()
    expect(outcome.changes.map(c => [c.playerId, c.before, c.after, c.delta])).toEqual([
      ['ana', 1200, 1220, 20],
      ['bea', 1200, 1180, -20],
    ])
    const ana = await readPlayerRating('ana', 'Singles', tool, 'system')
    expect(ana).toMatchObject({ rating: 1220, matchesPlayed: 1, provisional: true, status: 'experimental' })
    const bea = await readPlayerRating('bea', 'Singles', tool, 'system')
    expect(bea).toMatchObject({ rating: 1180, matchesPlayed: 1 })
    expect(await readPlayerRating('nobody', 'Singles', tool, 'system')).toBeNull()
  })

  it('applying the same result twice is a no-op (idempotency)', async () => {
    const { tool, tables } = createMockTool()
    const first = await applyFinalizedResultToStore(input, tool, 'system')
    expect(first.applied).toBe(true)
    const second = await applyFinalizedResultToStore(input, tool, 'system')
    expect(second.applied).toBe(false)
    expect(second.changes).toHaveLength(0)
    expect(second.skipped).toEqual(['ana', 'bea'])
    expect(tables.get('ratingChanges')).toHaveLength(2)
    expect(tables.get('playerRatings')).toHaveLength(2)
  })

  it('rejects an invalid result and writes nothing', async () => {
    const { tool, tables } = createMockTool()
    const outcome = await applyFinalizedResultToStore(
      { ...input, teams: [['ana'], ['ana']] },
      tool, 'system',
    )
    expect(outcome.applied).toBe(false)
    expect(outcome.error).toMatch(/both sides/)
    expect(tables.get('ratingChanges') ?? []).toHaveLength(0)
    expect(tables.get('playerRatings') ?? []).toHaveLength(0)
  })

  it('halves K on the 4th match against the same opponent (repeat dampening via history)', async () => {
    const { tool } = createMockTool()
    const deltas: number[] = []
    const ks: number[] = []
    for (let rev = 1; rev <= 4; rev++) {
      const outcome = await applyFinalizedResultToStore(
        { ...input, resultId: resultIdFor('sess1', rev), sessionId: `sess${rev}` },
        tool, 'system',
      )
      expect(outcome.applied).toBe(true)
      deltas.push(outcome.changes[0].delta)
      ks.push(outcome.changes[0].k)
    }
    // Ana wins four straight: +20, +18, +16, then K halved to 20 → +7.
    expect(deltas).toEqual([20, 18, 16, 7])
    expect(ks).toEqual([40, 40, 40, 20])
    const ana = await readPlayerRating('ana', 'Singles', tool, 'system')
    expect(ana?.rating).toBe(1200 + 20 + 18 + 16 + 7)
    expect(ana?.matchesPlayed).toBe(4)
  })
})

describe('reverseRatingEffect', () => {
  const input = {
    resultId: resultIdFor('sess1', 3),
    sessionId: 'sess1',
    format: 'Singles' as const,
    teams: [['ana'], ['bea']] as [string[], string[]],
    winner: 0 as const,
  }

  it('reverses a result and returns ratings to their prior values', async () => {
    const { tool, tables } = createMockTool()
    await applyFinalizedResultToStore(input, tool, 'system')
    const reversed = await reverseRatingEffect(input.resultId, tool, 'system')
    expect(reversed.reversed).toBe(true)
    expect(reversed.changes.map(c => [c.playerId, c.delta])).toEqual([['ana', -20], ['bea', 20]])
    expect((await readPlayerRating('ana', 'Singles', tool, 'system'))?.rating).toBe(1200)
    expect((await readPlayerRating('ana', 'Singles', tool, 'system'))?.matchesPlayed).toBe(0)
    expect(tables.get('ratingChanges')).toHaveLength(4) // 2 results + 2 reversals
    // Reversing again is a no-op.
    const again = await reverseRatingEffect(input.resultId, tool, 'system')
    expect(again.reversed).toBe(false)
    expect(again.changes).toHaveLength(0)
  })

  it('reversal applies the negated delta to the CURRENT rating, not the old one', async () => {
    const { tool } = createMockTool()
    await applyFinalizedResultToStore(input, tool, 'system')
    // Ana beats Bea again (second result): 1220 vs 1180 → Ana +18 → 1238.
    await applyFinalizedResultToStore(
      { ...input, resultId: resultIdFor('sess1', 4), sessionId: 'sess2' },
      tool, 'system',
    )
    expect((await readPlayerRating('ana', 'Singles', tool, 'system'))?.rating).toBe(1238)
    // Reverse only the FIRST result (+20): 1238 − 20 = 1218, not 1200.
    const reversed = await reverseRatingEffect(input.resultId, tool, 'system')
    expect(reversed.reversed).toBe(true)
    expect((await readPlayerRating('ana', 'Singles', tool, 'system'))?.rating).toBe(1218)
    expect((await readPlayerRating('ana', 'Singles', tool, 'system'))?.matchesPlayed).toBe(1)
  })

  it('reversing a result with no rating effect reports an error', async () => {
    const { tool } = createMockTool()
    const outcome = await reverseRatingEffect('session:nope:rev:1', tool, 'system')
    expect(outcome.reversed).toBe(false)
    expect(outcome.error).toMatch(/No rating effect/)
  })
})
