/**
 * Finalization tests — mock RecordTool over in-memory maps.
 *
 * The mock reproduces the properties applyFinalization relies on:
 *  - userBound `userId` is stamped from the tool call's userId argument
 *    (never from the payload), mirroring the RecordRoom;
 *  - `uniqueOn` is enforced for `playerStats` (userId+format) and
 *    `matchResults` (sessionId+userId), so a double-apply fails loudly
 *    instead of silently duplicating rows;
 *  - queries filter on every `where` key and honour `limit`.
 */

import { describe, expect, it } from 'vitest'
import type { ActionResult } from 'deepspace/worker'
import { awardPoint, createMatchScore, reviewResult, type MatchScore } from '../lib/rally-score.js'
import type { RallySession } from '../lib/rally.js'
import {
  applyFinalization,
  reconcilePlayerStats,
  reverseFinalization,
  type FinalizationTool,
} from './result-finalization.js'

type Row = { recordId: string; createdBy: string; data: Record<string, unknown> }

function createToolHarness() {
  const collections = new Map<string, Map<string, Row>>()
  let nextId = 0
  let writesUntilFailure = 0
  const getCollection = (name: string) => {
    let collection = collections.get(name)
    if (!collection) {
      collection = new Map()
      collections.set(name, collection)
    }
    return collection
  }
  const userBound = new Set(['profiles', 'playerStats', 'matchResults', 'resultAudits'])

  const tool = (async <T>(name: string, params: Record<string, unknown>, userId: string): Promise<ActionResult<T>> => {
    if (name !== 'records.query' && writesUntilFailure > 0 && --writesUntilFailure === 0) {
      return { success: false, error: 'Injected write failure' }
    }
    if (name === 'records.query') {
      const where = (params.where ?? {}) as Record<string, unknown>
      const records = [...getCollection(String(params.collection)).values()].filter((row) =>
        Object.entries(where).every(([key, value]) => row.data[key] === value),
      ).slice(0, Number(params.limit ?? 100))
      return { success: true, data: { records, count: records.length } } as ActionResult<T>
    }
    if (name === 'records.create') {
      const collection = String(params.collection)
      const data = { ...(params.data as Record<string, unknown>) }
      if (userBound.has(collection)) data.userId = userId
      if (collection === 'playerStats') {
        const dup = [...getCollection(collection).values()].some(
          (row) => row.data.userId === data.userId && row.data.format === data.format,
        )
        if (dup) return { success: false, error: 'Duplicate stats row' } as ActionResult<T>
      }
      if (collection === 'matchResults') {
        const dup = [...getCollection(collection).values()].some(
          (row) => row.data.sessionId === data.sessionId && row.data.userId === data.userId,
        )
        if (dup) return { success: false, error: 'Duplicate result row' } as ActionResult<T>
      }
      const recordId = `row-${++nextId}`
      getCollection(collection).set(recordId, { recordId, createdBy: userId, data })
      return { success: true, data: { recordId } } as ActionResult<T>
    }
    if (name === 'records.delete') {
      const recordId = String(params.recordId)
      if (getCollection(String(params.collection)).delete(recordId)) {
        return { success: true, data: { recordId } } as ActionResult<T>
      }
      return { success: false, error: 'Not found' } as ActionResult<T>
    }
    if (name === 'records.update') {
      const row = getCollection(String(params.collection)).get(String(params.recordId))
      if (!row) return { success: false, error: 'Not found' } as ActionResult<T>
      Object.assign(row.data, params.data as Record<string, unknown>)
      return { success: true, data: { recordId: row.recordId } } as ActionResult<T>
    }
    return { success: false, error: `Unexpected tool ${name}` } as ActionResult<T>
  }) as FinalizationTool

  const rows = (collection: string) => [...getCollection(collection).values()]
  const seedProfile = (userId: string, visibility: 'public' | 'private') => {
    const recordId = `profile-${userId}`
    getCollection('profiles').set(recordId, {
      recordId,
      createdBy: userId,
      data: { userId, displayName: userId, bio: '', formats: [], preferredArea: '', selfReportedLevel: 'Unrated', visibility },
    })
  }
  return { tool, rows, seedProfile, failWrite: (when: number) => { writesUntilFailure = when } }
}

function singlesSession(): RallySession {
  return {
    format: 'Singles',
    title: 'Test rally',
    court: 'Test court',
    location: 'Pittsburgh',
    startsAt: '2030-01-01T12:00:00.000Z',
    durationMinutes: 90,
    targetPlayers: 2,
    level: 'All levels',
    notes: '',
    hostId: 'host',
    chatChannelId: '',
    status: 'open',
  }
}

function finalizedScore(): MatchScore {
  let score = createMatchScore([['alice'], ['bob']])
  for (let point = 0; point < 48; point++) score = awardPoint(score, 0)
  for (const player of ['alice', 'bob']) score = reviewResult(score, player, 'approve')!
  return score
}

describe('applyFinalization', () => {
  it('applies a finalized singles result to stats, history, and audit exactly once', async () => {
    const harness = createToolHarness()
    const score = finalizedScore()
    const result = await applyFinalization(harness.tool, singlesSession(), 'session-1', score, 'bob', () => '2026-11-18T18:00:00.000Z')
    expect(result).toEqual({ ok: true, applied: true })
    const stats = harness.rows('playerStats')
    expect(stats).toHaveLength(2)
    expect(stats.find((row) => row.data.userId === 'alice')?.data).toMatchObject({ wins: 1, losses: 0, matchesPlayed: 1, visibility: 'private' })
    expect(stats.find((row) => row.data.userId === 'bob')?.data).toMatchObject({ wins: 0, losses: 1, matchesPlayed: 1 })
    const results = harness.rows('matchResults')
    expect(results).toHaveLength(2)
    expect(results.find((row) => row.data.userId === 'alice')?.data).toMatchObject({ sessionId: 'session-1', won: 1, resultRevision: score.revision })
    expect(harness.rows('resultAudits')).toHaveLength(1)
    expect(harness.rows('resultAudits')[0].data).toMatchObject({ kind: 'finalized', sessionId: 'session-1' })

    // A retry for the same revision repairs instead of double-counting.
    const retry = await applyFinalization(harness.tool, singlesSession(), 'session-1', score, 'bob')
    expect(retry).toEqual({ ok: true, applied: false })
    expect(harness.rows('playerStats').find((row) => row.data.userId === 'alice')?.data).toMatchObject({ wins: 1, matchesPlayed: 1 })
    expect(harness.rows('resultAudits')).toHaveLength(1)
  })

  it('skips practice matches entirely', async () => {
    const harness = createToolHarness()
    const session = { ...singlesSession(), format: 'Practice' as const }
    const result = await applyFinalization(harness.tool, session, 'session-1', finalizedScore(), 'bob')
    expect(result).toEqual({ ok: true, applied: false, skipped: 'practice' })
    expect(harness.rows('playerStats')).toHaveLength(0)
    expect(harness.rows('matchResults')).toHaveLength(0)
  })

  it('keeps doubles statistics separate from singles', async () => {
    const harness = createToolHarness()
    let score = createMatchScore([['alice', 'carol'], ['bob', 'dave']])
    for (let point = 0; point < 48; point++) score = awardPoint(score, 0)
    for (const player of ['alice', 'carol', 'bob', 'dave']) score = reviewResult(score, player, 'approve')!
    const session = { ...singlesSession(), format: 'Doubles' as const }
    await expect(applyFinalization(harness.tool, session, 'session-2', score, 'dave')).resolves.toEqual({ ok: true, applied: true })
    const stats = harness.rows('playerStats')
    expect(stats).toHaveLength(4)
    expect(stats.every((row) => row.data.format === 'doubles')).toBe(true)
    expect(stats.find((row) => row.data.userId === 'carol')?.data).toMatchObject({ wins: 1, matchesPlayed: 1 })
  })

  it('marks a private player’s stats rows private so public listings exclude them', async () => {
    const harness = createToolHarness()
    harness.seedProfile('bob', 'private')
    await applyFinalization(harness.tool, singlesSession(), 'session-1', finalizedScore(), 'alice')
    expect(harness.rows('playerStats').find((row) => row.data.userId === 'bob')?.data.visibility).toBe('private')
    expect(harness.rows('playerStats').find((row) => row.data.userId === 'alice')?.data.visibility).toBe('private')
    expect(harness.rows('matchResults').find((row) => row.data.userId === 'bob')?.data.visibility).toBe('private')
  })
})

describe('correction reversal and repair', () => {
  it('reverses the old outcome before a correction and re-applies the new one', async () => {
    const harness = createToolHarness()
    const session = singlesSession()
    const first = finalizedScore()
    await applyFinalization(harness.tool, session, 'session-1', first, 'bob')
    expect(harness.rows('playerStats').find((row) => row.data.userId === 'alice')?.data).toMatchObject({ wins: 1, matchesPlayed: 1 })

    await expect(reverseFinalization(harness.tool, 'session-1', 'bob', session, first)).resolves.toBe(true)
    expect(harness.rows('playerStats').find((row) => row.data.userId === 'alice')?.data).toMatchObject({ wins: 0, matchesPlayed: 0 })
    expect(harness.rows('playerStats').find((row) => row.data.userId === 'bob')?.data).toMatchObject({ losses: 0, matchesPlayed: 0 })

    // Corrected result: bob wins. Re-finalize at the new revision.
    let corrected = { ...first, revision: first.revision + 1, sets: [[4, 6], [3, 6]] as Array<[number, number]>, winner: 1 as const, approvals: ['alice', 'bob'], correctionCount: 1 }
    const result = await applyFinalization(harness.tool, session, 'session-1', corrected, 'alice')
    expect(result).toEqual({ ok: true, applied: true })
    expect(harness.rows('playerStats').find((row) => row.data.userId === 'bob')?.data).toMatchObject({ wins: 1, matchesPlayed: 1 })
    expect(harness.rows('playerStats').find((row) => row.data.userId === 'alice')?.data).toMatchObject({ wins: 0, losses: 1, matchesPlayed: 1 })
    expect(harness.rows('matchResults')).toHaveLength(2)
    expect(harness.rows('matchResults').find((row) => row.data.userId === 'alice')?.data).toMatchObject({ won: 0, resultRevision: corrected.revision })
  })

  it('repairs a corrupted stats row from the finalized result rows', async () => {
    const harness = createToolHarness()
    await applyFinalization(harness.tool, singlesSession(), 'session-1', finalizedScore(), 'bob')
    const aliceStats = harness.rows('playerStats').find((row) => row.data.userId === 'alice')!
    aliceStats.data.wins = 99
    aliceStats.data.matchesPlayed = 99
    expect(await reconcilePlayerStats(harness.tool, 'alice', 'singles')).toBe(true)
    expect(harness.rows('playerStats').find((row) => row.data.userId === 'alice')?.data).toMatchObject({ wins: 1, matchesPlayed: 1 })
    expect(await reconcilePlayerStats(harness.tool, 'alice', 'singles')).toBe(false)
  })
})

it.each([1, 2, 3, 4, 5])('retries a finalization after write %i fails without duplicate contributions', async (write) => {
  const harness = createToolHarness()
  const apply = () => applyFinalization(harness.tool, singlesSession(), 'session-1', finalizedScore(), 'bob')
  harness.failWrite(write)
  await expect(apply()).resolves.toMatchObject({ ok: false })
  await expect(apply()).resolves.toMatchObject({ ok: true })
  await expect(apply()).resolves.toMatchObject({ ok: true, applied: false })
  expect(harness.rows('matchResults')).toHaveLength(2)
  expect(harness.rows('resultAudits')).toHaveLength(1)
  expect(harness.rows('playerStats').map(row => row.data.matchesPlayed)).toEqual([1, 1])
})

it.each([1, 2, 3, 4])('retries reversal after write %i fails without subtracting other matches', async (write) => {
  const harness = createToolHarness()
  const session = singlesSession()
  const score = finalizedScore()
  await applyFinalization(harness.tool, session, 'session-1', score, 'bob')
  await applyFinalization(harness.tool, session, 'session-2', score, 'bob')
  const reverse = () => reverseFinalization(harness.tool, 'session-1', 'bob', session, score)
  harness.failWrite(write)
  await expect(reverse()).resolves.toBe(false)
  await expect(reverse()).resolves.toBe(true)
  await expect(reverse()).resolves.toBe(true)
  expect(harness.rows('matchResults').map(row => row.data.sessionId)).toEqual(['session-2', 'session-2'])
  expect(harness.rows('playerStats').map(row => row.data.matchesPlayed)).toEqual([1, 1])
})
