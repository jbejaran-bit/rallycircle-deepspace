/**
 * PR #22 stats aggregation — getPlayerStats unbounded session scan.
 *
 * Defect (adversarial audit): `getPlayerStats` calls `loadVerifiedResults`
 * with `limit: Infinity`, which issues one `tools.get('sessions', …)` per
 * matchResults row (65 results → 65 session GETs, no cap). Capping the read
 * would silently undercount statistics, so the fix moves the staleness
 * signal into the row: the serialized command room maintains a `status`
 * (`final` | `pending` | `disputed`) on each matchResults row, and the read
 * path trusts the stored outcome for `final` rows — zero session GETs for
 * statistics. History fetches the session only for `pending` rows, to show
 * the corrected outcome (bounded by the history limit, at most 50).
 *
 * SDK limitation (proven from node_modules/deepspace/dist/worker.js):
 * `where` values must be primitives, equality only
 * (refuseUnknownWhere, "where values must be primitives (equality only)");
 * there is no IN operator and no aggregate query, so no batched session
 * read is expressible through ActionTools. The per-row session GET is
 * therefore unavoidable read-side — the only exact fix is the write-side
 * status, maintained where the session is already in hand and the
 * operation is serialized (the per-session command room).
 *
 * Tests are test-first: on unfixed e6ff2d9 the GET-count assertions fail
 * (65/300 GETs) and the pending-history assertions fail (rows dropped).
 */

import { describe, expect, it } from 'vitest'
import type { ActionTools } from 'deepspace/worker'
import { createMatchScore } from '../lib/rally-score.js'
import type { Env } from '../../worker.js'
import { getMatchHistoryAction, getPlayerStatsAction } from './profile-actions.js'
import { rallyCommandAction, RallyCommandRoom } from './rally-command-room.js'

type Row = { recordId: string; createdBy: string; data: Record<string, unknown> }

const USER_BOUND = new Set(['profiles', 'playerStats', 'matchResults', 'resultAudits'])

function createStore() {
  const collections = new Map<string, Map<string, Row>>()
  const getCollection = (name: string) => {
    let collection = collections.get(name)
    if (!collection) {
      collection = new Map()
      collections.set(name, collection)
    }
    return collection
  }
  return { collections, getCollection }
}

type Store = ReturnType<typeof createStore>

/** In-memory RecordRoom fetch over the shared store, with fault injection for the session score write. */
function createRecordRoom(store: Store, faults: { failMatchScoreWriteOnce: boolean }) {
  return {
    async fetch(request: Request) {
      const { tool, params } = (await request.json()) as {
        tool: string
        params: Record<string, unknown>
      }
      await new Promise((resolve) => setTimeout(resolve, 1))
      const collection = String(params.collection ?? '')
      const rows = store.getCollection(collection)
      if (tool === 'records.query') {
        const where = (params.where ?? {}) as Record<string, unknown>
        let records = [...rows.values()].filter((row) =>
          Object.entries(where).every(([key, value]) => row.data[key] === value),
        )
        const orderBy = params.orderBy as string | undefined
        if (orderBy) {
          const dir = params.orderDir === 'desc' ? -1 : 1
          records = [...records].sort((a, b) => {
            const av = String(a.data[orderBy] ?? '')
            const bv = String(b.data[orderBy] ?? '')
            return av < bv ? -dir : av > bv ? dir : 0
          })
        }
        const offset = Number(params.offset ?? 0)
        const limit = Number(params.limit ?? 100)
        const page = records.slice(offset, offset + limit)
        const nextOffset = records.length > offset + limit ? offset + limit : undefined
        return Response.json({ success: true, data: { records: page, count: page.length, nextOffset } })
      }
      if (tool === 'records.get') {
        const row = rows.get(String(params.recordId))
        return row
          ? Response.json({ success: true, data: { record: row } })
          : Response.json({ success: false, error: 'Record not found' })
      }
      if (tool === 'records.create') {
        const recordId = `row-${Math.random().toString(36).slice(2, 8)}-${rows.size + 1}`
        const userId = request.headers.get('X-User-Id') ?? ''
        const data = USER_BOUND.has(collection)
          ? { ...(params.data as Record<string, unknown>), userId }
          : { ...(params.data as Record<string, unknown>) }
        rows.set(recordId, { recordId, createdBy: userId, data })
        return Response.json({ success: true, data: { recordId } })
      }
      if (tool === 'records.update') {
        if (collection === 'sessions' && faults.failMatchScoreWriteOnce
          && params.data && typeof params.data === 'object' && 'matchScore' in (params.data as Record<string, unknown>)) {
          faults.failMatchScoreWriteOnce = false
          return Response.json({ success: false, error: 'Injected score write failure' })
        }
        const row = rows.get(String(params.recordId))
        if (!row) return Response.json({ success: false, error: 'Record not found' })
        Object.assign(row.data, params.data as Record<string, unknown>)
        return Response.json({ success: true, data: { recordId: String(params.recordId) } })
      }
      if (tool === 'records.delete') {
        return Response.json(rows.delete(String(params.recordId))
          ? { success: true, data: { recordId: String(params.recordId) } }
          : { success: false, error: 'Not found' })
      }
      return Response.json({ success: false, error: 'Unexpected tool request' })
    },
  }
}

function createHarness() {
  const store = createStore()
  const faults = { failMatchScoreWriteOnce: false }
  const recordRoom = createRecordRoom(store, faults)
  let nextId = 0

  const env = {
    DEEPSPACE_APP_ID: 'test-app',
    RECORD_ROOMS: { idFromName: (name: string) => name, get: () => recordRoom },
  } as unknown as Env
  const storageMap = new Map<string, unknown>()
  const state = {
    storage: {
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      put: async (key: string, value: unknown) => { storageMap.set(key, value) },
      get: async (key: string) => storageMap.get(key),
      delete: async (key: string) => { storageMap.delete(key) },
    },
  } as unknown as DurableObjectState
  const room = new RallyCommandRoom(state, env)
  const actionEnv = {
    ...env,
    RALLY_COMMAND_ROOMS: { idFromName: (name: string) => name, get: () => ({ fetch: (request: Request) => room.fetch(request) }) },
  } as unknown as Env

  // ActionTools over the same store, counting session GETs — the metric
  // this fix bounds. The room's internal reads go through recordRoom.fetch
  // and are deliberately NOT counted here.
  const counters = { sessionGets: 0, queries: 0 }
  const toolsFor = (callerId: string) => {
    const wrap = (collection: string, data: Record<string, unknown>) =>
      USER_BOUND.has(collection) ? { ...data, userId: callerId } : { ...data }
    return {
      create: async (collection: string, data: Record<string, unknown>) => {
        const rows = store.getCollection(collection)
        const recordId = `row-${++nextId}`
        rows.set(recordId, { recordId, createdBy: callerId, data: wrap(collection, data) })
        return { success: true as const, data: { recordId } }
      },
      update: async (collection: string, recordId: string, data: Record<string, unknown>) => {
        const row = store.getCollection(collection).get(recordId)
        if (!row) return { success: false as const, error: 'Not found' }
        Object.assign(row.data, data)
        return { success: true as const, data: { recordId } }
      },
      remove: async (collection: string, recordId: string) => {
        return store.getCollection(collection).delete(recordId)
          ? { success: true as const, data: { recordId } }
          : { success: false as const, error: 'Not found' }
      },
      get: async (collection: string, recordId: string) => {
        if (collection === 'sessions') counters.sessionGets++
        const row = store.getCollection(collection).get(recordId)
        return row
          ? { success: true as const, data: { record: row } }
          : { success: false as const, error: 'Record not found' }
      },
      query: async (collection: string, options: Record<string, unknown>) => {
        counters.queries++
        const where = (options.where ?? {}) as Record<string, unknown>
        let records = [...store.getCollection(collection).values()].filter((row) =>
          Object.entries(where).every(([key, value]) => row.data[key] === value),
        )
        const orderBy = options.orderBy as string | undefined
        if (orderBy) {
          const dir = options.orderDir === 'desc' ? -1 : 1
          records = [...records].sort((a, b) => {
            const av = String(a.data[orderBy] ?? '')
            const bv = String(b.data[orderBy] ?? '')
            return av < bv ? -dir : av > bv ? dir : 0
          })
        }
        const offset = Number(options.offset ?? 0)
        const limit = Number(options.limit ?? 100)
        const page = records.slice(offset, offset + limit)
        const nextOffset = records.length > offset + limit ? offset + limit : undefined
        return { success: true as const, data: { records: page, count: page.length, nextOffset } }
      },
    } as unknown as ActionTools
  }

  const callAction = (
    action: (ctx: { userId: string; params: Record<string, unknown>; tools: ActionTools; env: Env; callerJwt: string }) => Promise<unknown>,
    userId: string,
    params: Record<string, unknown> = {},
  ) => action({ userId, params, tools: toolsFor(userId), env: {} as Env, callerJwt: 'test-token' })

  async function command(userId: string, params: Record<string, unknown>) {
    return rallyCommandAction({
      userId,
      params,
      env: actionEnv,
      callerJwt: 'test-token',
      tools: {
        get: async (_collection: string, recordId: string) => {
          const record = store.getCollection('sessions').get(recordId)
          return record
            ? { success: true as const, data: { record: { ...record, createdAt: '', updatedAt: '' } } }
            : { success: false as const, error: 'Record not found' }
        },
      } as ActionTools,
    })
  }

  const seed = (collection: string, data: Record<string, unknown>, ownerId: string, recordId?: string) => {
    const rows = store.getCollection(collection)
    const id = recordId ?? `seed-${++nextId}`
    rows.set(id, { recordId: id, createdBy: ownerId, data: { ...data, userId: ownerId } })
    return id
  }

  const seedProfile = (userId: string, visibility: 'public' | 'private' = 'public') =>
    seed('profiles', { displayName: userId, bio: '', formats: [], preferredArea: '', selfReportedLevel: 'Unrated', visibility }, userId)

  /** Seed one finalized match: a session with a final score plus the complete matchResults row finalization writes. */
  const seedFinalMatch = (
    userId: string,
    opponent: string,
    index: number,
    options: {
      won?: boolean
      format?: 'Singles' | 'Doubles'
      revision?: number
      status?: string
      sets?: Array<[number, number]>
      finalizedAt?: string
    } = {},
  ) => {
    const won = options.won ?? index % 2 === 0
    const format = options.format ?? 'Singles'
    const revision = options.revision ?? 1
    const sets: Array<[number, number]> = options.sets ?? (won ? [[6, 3], [6, 3]] : [[3, 6], [3, 6]])
    const base = createMatchScore([[userId], [opponent]])
    const score = { ...base, sets, winner: won ? 0 : 1, revision, approvals: [userId, opponent] }
    const sessionId = `session-${index}`
    seed('sessions', {
      format, matchScore: JSON.stringify(score), pendingResult: '',
      hostId: 'host', status: 'open', title: `Match ${index}`,
    }, 'host', sessionId)
    const row: Record<string, unknown> = {
      sessionId, format: format === 'Singles' ? 'singles' : 'doubles',
      won: won ? 1 : 0, sets: JSON.stringify(sets), resultRevision: revision,
      finalizedAt: options.finalizedAt ?? '2026-11-01T18:00:00.000Z', visibility: 'public',
    }
    if (options.status !== undefined) row.status = options.status
    seed('matchResults', row, userId)
    return sessionId
  }

  const readStats = async (callerId: string, targetUserId: string) => {
    const result = await callAction(getPlayerStatsAction, callerId, { userId: targetUserId }) as {
      success: boolean
      data?: { stats: { singles: { wins: number; losses: number; matchesPlayed: number; provisional: boolean }; doubles: { wins: number; losses: number; matchesPlayed: number; provisional: boolean } } }
    }
    expect(result.success).toBe(true)
    return result.data!.stats
  }

  const readHistory = async (callerId: string, targetUserId: string, limit = 50) => {
    const result = await callAction(getMatchHistoryAction, callerId, { userId: targetUserId, limit }) as {
      success: boolean
      data?: { entries: Array<{ sessionId: string; won: boolean; sets: Array<[number, number]>; status: string; resultRevision: number }> }
    }
    expect(result.success).toBe(true)
    return result.data!.entries
  }

  return { store, counters, faults, command, seed, seedProfile, seedFinalMatch, readStats, readHistory }
}

describe('PR22-STATS-AGG getPlayerStats session scan', () => {
  it('stats for 65 verified results: exact totals with 0 session GETs', async () => {
    const h = createHarness()
    h.seedProfile('alice')
    for (let i = 0; i < 65; i++) h.seedFinalMatch('alice', 'bob', i, { won: i < 40 })
    const stats = await h.readStats('alice', 'alice')
    expect(stats.singles).toEqual({ userId: 'alice', format: 'singles', wins: 40, losses: 25, matchesPlayed: 65, winRate: 40 / 65, provisional: false, visibility: 'public' })
    expect(stats.doubles.matchesPlayed).toBe(0)
    expect(h.counters.sessionGets).toBe(0)
  })

  it('stats for 300 verified results: exact totals with 0 session GETs', async () => {
    const h = createHarness()
    h.seedProfile('alice')
    for (let i = 0; i < 300; i++) h.seedFinalMatch('alice', 'bob', i, { won: i % 3 !== 0 })
    const stats = await h.readStats('alice', 'alice')
    expect(stats.singles).toMatchObject({ wins: 200, losses: 100, matchesPlayed: 300, provisional: false })
    expect(h.counters.sessionGets).toBe(0)
  })

  it('stats exclude pending and disputed rows and count per format', async () => {
    const h = createHarness()
    h.seedProfile('alice')
    for (let i = 0; i < 40; i++) h.seedFinalMatch('alice', 'bob', i, { won: i < 25 })
    for (let i = 40; i < 60; i++) h.seedFinalMatch('alice', 'bob', i, { won: true, format: 'Doubles' })
    // Pending: corrected, awaiting re-approval — visible in history, never counted.
    const pendingSession = h.seedFinalMatch('alice', 'bob', 100, { won: true, status: 'pending' })
    const pendingScore = JSON.parse(String(h.store.getCollection('sessions').get(pendingSession)!.data.matchScore))
    h.store.getCollection('sessions').get(pendingSession)!.data.matchScore = JSON.stringify({
      ...pendingScore, revision: 2, winner: 1, sets: [[3, 6], [3, 6]], approvals: [],
    })
    // Disputed: hidden from both stats and history.
    h.seedFinalMatch('alice', 'bob', 101, { won: true, status: 'disputed' })
    const stats = await h.readStats('alice', 'alice')
    expect(stats.singles).toMatchObject({ wins: 25, losses: 15, matchesPlayed: 40, provisional: false })
    expect(stats.doubles).toMatchObject({ wins: 20, losses: 0, matchesPlayed: 20, provisional: false })
    expect(h.counters.sessionGets).toBe(0)
  })

  it('history shows a pending row with the corrected outcome for exactly 1 session GET', async () => {
    const h = createHarness()
    h.seedProfile('alice')
    h.seedFinalMatch('alice', 'bob', 0, { won: true })
    h.seedFinalMatch('alice', 'bob', 1, { won: false })
    const pendingSession = h.seedFinalMatch('alice', 'bob', 2, { won: true, status: 'pending' })
    const pendingScore = JSON.parse(String(h.store.getCollection('sessions').get(pendingSession)!.data.matchScore))
    h.store.getCollection('sessions').get(pendingSession)!.data.matchScore = JSON.stringify({
      ...pendingScore, revision: 2, winner: 1, sets: [[3, 6], [3, 6]], approvals: [],
    })
    const entries = await h.readHistory('alice', 'alice')
    expect(entries).toHaveLength(3)
    const pending = entries.find((entry) => entry.sessionId === pendingSession)!
    expect(pending).toMatchObject({ status: 'pending', won: false, sets: [[3, 6], [3, 6]], resultRevision: 2 })
    expect(entries.filter((entry) => entry.status === 'final')).toHaveLength(2)
    expect(h.counters.sessionGets).toBe(1)
  })

  it('history hides disputed rows with 0 session GETs', async () => {
    const h = createHarness()
    h.seedProfile('alice')
    h.seedFinalMatch('alice', 'bob', 0, { won: true })
    const disputedSession = h.seedFinalMatch('alice', 'bob', 1, { won: true, status: 'disputed' })
    const disputedScore = JSON.parse(String(h.store.getCollection('sessions').get(disputedSession)!.data.matchScore))
    h.store.getCollection('sessions').get(disputedSession)!.data.matchScore = JSON.stringify({
      ...disputedScore, disputed: true,
    })
    const entries = await h.readHistory('alice', 'alice')
    expect(entries.map((entry) => entry.sessionId)).toEqual(['session-0'])
    expect(h.counters.sessionGets).toBe(0)
  })

  it('migration: rows written before the status column count as final', async () => {
    const h = createHarness()
    h.seedProfile('alice')
    for (let i = 0; i < 10; i++) {
      const sessionId = h.seedFinalMatch('alice', 'bob', i, { won: i < 6 })
      // Strip the status field to mimic a pre-migration row.
      for (const row of h.store.getCollection('matchResults').values()) {
        if (row.data.sessionId === sessionId) delete row.data.status
      }
    }
    const stats = await h.readStats('alice', 'alice')
    expect(stats.singles).toMatchObject({ wins: 6, losses: 4, matchesPlayed: 10, provisional: false })
    expect(h.counters.sessionGets).toBe(0)
  })

  it('corrupt stored sets drop the row from stats and history without failing the call', async () => {
    const h = createHarness()
    h.seedProfile('alice')
    h.seedFinalMatch('alice', 'bob', 0, { won: true })
    const badSession = h.seedFinalMatch('alice', 'bob', 1, { won: true })
    for (const row of h.store.getCollection('matchResults').values()) {
      if (row.data.sessionId === badSession) row.data.sets = 'not-json{{{'
    }
    const stats = await h.readStats('alice', 'alice')
    expect(stats.singles).toMatchObject({ wins: 1, losses: 0, matchesPlayed: 1 })
    const entries = await h.readHistory('alice', 'alice')
    expect(entries.map((entry) => entry.sessionId)).toEqual(['session-0'])
    expect(h.counters.sessionGets).toBe(0)
  })

  it('documented window: a final row whose session commit is still in flight counts, and stays exact after the retry', async () => {
    const h = createHarness()
    h.seedProfile('alice')
    // Finalization wrote the row at revision 2, but the session score commit
    // failed and is awaiting the recovery retry: the session is still at
    // revision 1 with pendingResult set. The row counts optimistically until
    // the retry lands — bounded by the alarm retry, and self-healing. This
    // is a deliberate, documented deviation from the old read-side check
    // (which dropped the row while pendingResult was set); see the log.
    const sessionId = h.seedFinalMatch('alice', 'bob', 0, { won: true, revision: 2 })
    const session = h.store.getCollection('sessions').get(sessionId)!
    const score = JSON.parse(String(session.data.matchScore))
    session.data.matchScore = JSON.stringify({ ...score, revision: 1, approvals: [] })
    session.data.pendingResult = '["reviewResult","alice",1,"approve"]'
    const before = await h.readStats('alice', 'alice')
    expect(before.singles).toMatchObject({ wins: 1, matchesPlayed: 1 })
    // The retry completes the commit: session reaches revision 2.
    session.data.matchScore = JSON.stringify({ ...score, revision: 2, approvals: ['alice', 'bob'] })
    session.data.pendingResult = ''
    const after = await h.readStats('alice', 'alice')
    expect(after.singles).toMatchObject({ wins: 1, matchesPlayed: 1 })
    expect(h.counters.sessionGets).toBe(0)
  })
})

describe('PR22-STATS-AGG differential and room lifecycle', () => {
  /** Deterministic PRNG so the differential fixtures are reproducible. */
  function rng(seed: number) {
    let state = seed >>> 0
    return () => {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('differential: seeded fixtures across five shapes agree with an independent oracle, 0 session GETs', async () => {
    // Shapes: all-final, mixed pending/disputed, multi-format, empty, correction-reapproved.
    const shapes = [
      { final: 12, pending: 0, disputed: 0, doubles: 0 },
      { final: 9, pending: 4, disputed: 2, doubles: 3 },
      { final: 0, pending: 0, disputed: 0, doubles: 0 },
      { final: 30, pending: 6, disputed: 1, doubles: 12 },
      { final: 5, pending: 5, disputed: 5, doubles: 5 },
    ]
    for (let shapeIndex = 0; shapeIndex < shapes.length; shapeIndex++) {
      const shape = shapes[shapeIndex]
      const next = rng(1000 + shapeIndex)
      const h = createHarness()
      h.seedProfile('alice')
      // Oracle: expected totals from the fixture spec itself, not from the implementation.
      let singlesWins = 0
      let singlesPlayed = 0
      let doublesWins = 0
      let doublesPlayed = 0
      let index = 0
      const seedOne = (kind: 'final' | 'pending' | 'disputed', isDoubles: boolean) => {
        const won = next() < 0.5
        const sessionId = h.seedFinalMatch('alice', 'bob', index, {
          won, format: isDoubles ? 'Doubles' : 'Singles', status: kind === 'final' ? 'final' : kind,
        })
        if (kind === 'final') {
          if (isDoubles) { doublesPlayed++; if (won) doublesWins++ } else { singlesPlayed++; if (won) singlesWins++ }
        } else {
          // Pending/disputed rows carry a moved-on session score so the old
          // code would drop them by revision/eligibility; the new code must
          // exclude them by status alone.
          const session = h.store.getCollection('sessions').get(sessionId)!
          const score = JSON.parse(String(session.data.matchScore))
          session.data.matchScore = JSON.stringify(kind === 'pending'
            ? { ...score, revision: 2, winner: won ? 1 : 0, sets: [[3, 6], [3, 6]], approvals: [] }
            : { ...score, disputed: true })
        }
        index++
      }
      for (let i = 0; i < shape.final; i++) seedOne('final', i < shape.doubles)
      for (let i = 0; i < shape.pending; i++) seedOne('pending', false)
      for (let i = 0; i < shape.disputed; i++) seedOne('disputed', false)
      // Correction-reapproved shape: pending rows whose sessions were
      // re-finalized — the row was updated in place to final with the new outcome.
      if (shapeIndex === 4) {
        for (const row of h.store.getCollection('matchResults').values()) {
          if (row.data.status === 'pending') {
            row.data.status = 'final'
            row.data.won = 1
            row.data.resultRevision = 2
            if (row.data.format === 'singles') { singlesPlayed++; singlesWins++ }
          }
        }
      }
      const stats = await h.readStats('alice', 'alice')
      expect(stats.singles).toMatchObject({
        wins: singlesWins, losses: singlesPlayed - singlesWins, matchesPlayed: singlesPlayed,
        provisional: singlesPlayed < 5,
      })
      expect(stats.doubles).toMatchObject({
        wins: doublesWins, losses: doublesPlayed - doublesWins, matchesPlayed: doublesPlayed,
        provisional: doublesPlayed < 5,
      })
      expect(h.counters.sessionGets).toBe(0)
    }
  })

  it('lifecycle: finalization writes final rows; correction flips to pending fail-closed; re-approval restores final', async () => {
    const h = createHarness()
    h.seedProfile('alice')
    h.seedProfile('bob')
    // Seed a proposed final score (winner set, no approvals yet) and drive the approvals through the room.
    const base = createMatchScore([['alice'], ['bob']])
    const proposed = { ...base, sets: [[6, 3], [6, 3]] as Array<[number, number]>, winner: 0 as const, revision: 5, approvals: [] as string[] }
    h.seed('sessions', {
      format: 'Singles', matchScore: JSON.stringify(proposed), pendingResult: '',
      hostId: 'host', status: 'open', title: 'Lifecycle',
    }, 'host', 'life-1')
    const rowStatus = () => {
      const rows = [...h.store.getCollection('matchResults').values()].filter((row) => row.data.sessionId === 'life-1')
      return rows.map((row) => `${row.data.userId}:${String(row.data.status ?? '(missing)')}`).sort()
    }
    const readScore = () => JSON.parse(String(h.store.getCollection('sessions').get('life-1')!.data.matchScore))

    await expect(h.command('bob', { operation: 'reviewResult', sessionId: 'life-1', decision: 'approve', revision: 5 }))
      .resolves.toMatchObject({ success: true })
    await expect(h.command('alice', { operation: 'reviewResult', sessionId: 'life-1', decision: 'approve', revision: 5 }))
      .resolves.toMatchObject({ success: true })
    expect(readScore().approvals).toEqual(['bob', 'alice'])
    expect(rowStatus()).toEqual(['alice:final', 'bob:final'])
    expect((await h.readStats('alice', 'alice')).singles).toMatchObject({ wins: 1, matchesPlayed: 1 })
    expect(h.counters.sessionGets).toBe(0)

    // Host corrects, but the session score commit fails: the flip to pending
    // already landed, so the match must be excluded (fail-closed), and the
    // old score must still be committed.
    h.faults.failMatchScoreWriteOnce = true
    await expect(h.command('host', {
      operation: 'correctResult', sessionId: 'life-1', revision: 5, winner: 1, sets: [[3, 6], [4, 6]],
    })).resolves.toMatchObject({ success: false })
    expect(rowStatus()).toEqual(['alice:pending', 'bob:pending'])
    expect(readScore().revision).toBe(5)
    expect(readScore().winner).toBe(0)
    expect((await h.readStats('alice', 'alice')).singles).toMatchObject({ wins: 0, matchesPlayed: 0 })
    expect(h.counters.sessionGets).toBe(0)

    // Retry the same correction: the flip is a no-op, the audit is
    // idempotent, and the commit lands.
    await expect(h.command('host', {
      operation: 'correctResult', sessionId: 'life-1', revision: 5, winner: 1, sets: [[3, 6], [4, 6]],
    })).resolves.toMatchObject({ success: true })
    expect(readScore().revision).toBe(6)
    expect(readScore().winner).toBe(1)
    expect(rowStatus()).toEqual(['alice:pending', 'bob:pending'])
    expect((await h.readStats('alice', 'alice')).singles).toMatchObject({ wins: 0, matchesPlayed: 0 })
    const history = await h.readHistory('alice', 'alice')
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ status: 'pending', won: false, sets: [[3, 6], [4, 6]], resultRevision: 6 })
    expect(h.counters.sessionGets).toBe(1)

    // Fresh approvals at the new revision finalize the corrected result in place.
    await expect(h.command('bob', { operation: 'reviewResult', sessionId: 'life-1', decision: 'approve', revision: 6 }))
      .resolves.toMatchObject({ success: true })
    await expect(h.command('alice', { operation: 'reviewResult', sessionId: 'life-1', decision: 'approve', revision: 6 }))
      .resolves.toMatchObject({ success: true })
    expect(rowStatus()).toEqual(['alice:final', 'bob:final'])
    expect((await h.readStats('alice', 'alice')).singles).toMatchObject({ wins: 0, losses: 1, matchesPlayed: 1 })
    expect((await h.readHistory('alice', 'alice'))[0]).toMatchObject({ status: 'final', won: false, resultRevision: 6 })
    expect(h.counters.sessionGets).toBe(1)
  })

  it('lifecycle: a dispute flips rows to disputed (hidden), a correction reopens them as pending', async () => {
    const h = createHarness()
    h.seedProfile('alice')
    h.seedProfile('bob')
    const base = createMatchScore([['alice'], ['bob']])
    const proposed = { ...base, sets: [[6, 3], [6, 3]] as Array<[number, number]>, winner: 0 as const, revision: 5, approvals: [] as string[] }
    h.seed('sessions', {
      format: 'Singles', matchScore: JSON.stringify(proposed), pendingResult: '',
      hostId: 'host', status: 'open', title: 'Dispute lifecycle',
    }, 'host', 'life-2')
    const rowStatus = () =>
      [...h.store.getCollection('matchResults').values()]
        .filter((row) => row.data.sessionId === 'life-2')
        .map((row) => `${row.data.userId}:${String(row.data.status ?? '(missing)')}`).sort()
    const readScore = () => JSON.parse(String(h.store.getCollection('sessions').get('life-2')!.data.matchScore))

    for (const user of ['bob', 'alice']) {
      await expect(h.command(user, { operation: 'reviewResult', sessionId: 'life-2', decision: 'approve', revision: 5 }))
        .resolves.toMatchObject({ success: true })
    }
    expect(rowStatus()).toEqual(['alice:final', 'bob:final'])

    // Host corrects; bob disputes the corrected score.
    await expect(h.command('host', {
      operation: 'correctResult', sessionId: 'life-2', revision: 5, winner: 1, sets: [[3, 6], [4, 6]],
    })).resolves.toMatchObject({ success: true })
    expect(rowStatus()).toEqual(['alice:pending', 'bob:pending'])
    await expect(h.command('bob', { operation: 'reviewResult', sessionId: 'life-2', decision: 'dispute', revision: 6 }))
      .resolves.toMatchObject({ success: true })
    expect(readScore().disputed).toBe(true)
    expect(rowStatus()).toEqual(['alice:disputed', 'bob:disputed'])
    expect((await h.readStats('alice', 'alice')).singles).toMatchObject({ wins: 0, matchesPlayed: 0 })
    expect(await h.readHistory('alice', 'alice')).toHaveLength(0)
    expect(h.counters.sessionGets).toBe(0)

    // The host corrects the disputed score; rows reopen as pending, then re-approval finalizes.
    await expect(h.command('host', {
      operation: 'correctResult', sessionId: 'life-2', revision: 6, winner: 0, sets: [[6, 4], [6, 4]],
    })).resolves.toMatchObject({ success: true })
    expect(readScore().disputed).toBe(false)
    expect(rowStatus()).toEqual(['alice:pending', 'bob:pending'])
    for (const user of ['bob', 'alice']) {
      await expect(h.command(user, { operation: 'reviewResult', sessionId: 'life-2', decision: 'approve', revision: 7 }))
        .resolves.toMatchObject({ success: true })
    }
    expect(rowStatus()).toEqual(['alice:final', 'bob:final'])
    expect((await h.readStats('alice', 'alice')).singles).toMatchObject({ wins: 1, matchesPlayed: 1 })
    expect(h.counters.sessionGets).toBe(0)
  })
})

describe('PR22-STATS-AGG final-row verification on read (matrix follow-up)', () => {
  it('stats: a recently finalized row whose session score is not final yet is excluded until the retry lands (ADAPT S1/S3)', async () => {
    const h = createHarness()
    h.seedProfile('alice')
    // Mid-state of a failed final session commit: the row is written
    // 'final' with a fresh timestamp, but the session score still shows
    // only the first approval (the second approval never committed).
    const base = createMatchScore([['alice'], ['bob']])
    const partial = { ...base, sets: [[6, 3], [6, 3]], winner: 0, revision: 7, approvals: ['bob'] }
    h.seed('sessions', {
      format: 'Singles', matchScore: JSON.stringify(partial),
      pendingResult: '["reviewResult","alice",7,"approve"]',
      hostId: 'host', status: 'open', title: 'Mid-state',
    }, 'host', 'session-mid')
    h.seed('matchResults', {
      sessionId: 'session-mid', format: 'singles', won: 1, sets: JSON.stringify([[6, 3], [6, 3]]),
      resultRevision: 7, finalizedAt: new Date().toISOString(), visibility: 'public', status: 'final',
    }, 'alice')
    const mid = await h.readStats('alice', 'alice')
    expect(mid.singles.matchesPlayed).toBe(0)
    expect(h.counters.sessionGets).toBe(1)
    // The retry lands: the session score is now final at the same revision.
    const session = h.store.getCollection('sessions').get('session-mid')!
    session.data.matchScore = JSON.stringify({ ...partial, approvals: ['alice', 'bob'] })
    session.data.pendingResult = ''
    const after = await h.readStats('alice', 'alice')
    expect(after.singles).toMatchObject({ wins: 1, matchesPlayed: 1 })
  })

  it('stats: a recent final row whose session is gone is dropped, while an old orphaned row still counts (window boundary)', async () => {
    const h = createHarness()
    h.seedProfile('alice')
    h.seed('matchResults', {
      sessionId: 'gone-recent', format: 'singles', won: 1, sets: JSON.stringify([[6, 3], [6, 3]]),
      resultRevision: 1, finalizedAt: new Date().toISOString(), visibility: 'public', status: 'final',
    }, 'alice')
    h.seed('matchResults', {
      sessionId: 'gone-old', format: 'singles', won: 1, sets: JSON.stringify([[6, 3], [6, 3]]),
      resultRevision: 1, finalizedAt: '2026-11-01T18:00:00.000Z', visibility: 'public', status: 'final',
    }, 'alice')
    const stats = await h.readStats('alice', 'alice')
    expect(stats.singles).toMatchObject({ wins: 1, matchesPlayed: 1 })
    expect(h.counters.sessionGets).toBe(1)
  })

  it('stats: a final row older than the verification window is trusted even when its session score is not final (documented trade-off)', async () => {
    const h = createHarness()
    h.seedProfile('alice')
    // A failed commit unretried past the window: the row counts again.
    // The window (10 minutes) covers prompt retries and the bounded DO
    // alarm-recovery window (~5 minutes); past it, the stored row is the
    // durable record and statistics trust it with zero session GETs.
    const base = createMatchScore([['alice'], ['bob']])
    const partial = { ...base, sets: [[6, 3], [6, 3]], winner: 0, revision: 7, approvals: ['bob'] }
    h.seed('sessions', {
      format: 'Singles', matchScore: JSON.stringify(partial), pendingResult: '',
      hostId: 'host', status: 'open', title: 'Stale mid-state',
    }, 'host', 'session-stale')
    h.seed('matchResults', {
      sessionId: 'session-stale', format: 'singles', won: 1, sets: JSON.stringify([[6, 3], [6, 3]]),
      resultRevision: 7, finalizedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      visibility: 'public', status: 'final',
    }, 'alice')
    const stats = await h.readStats('alice', 'alice')
    expect(stats.singles).toMatchObject({ wins: 1, matchesPlayed: 1 })
    expect(h.counters.sessionGets).toBe(0)
  })

  it('history: a corrupt stored sets value is derived from the session score (ADAPT D1/F6)', async () => {
    const h = createHarness()
    h.seedProfile('alice')
    h.seedFinalMatch('alice', 'bob', 0, { won: true })
    h.seedFinalMatch('alice', 'bob', 1, { won: false })
    const bad = [...h.store.getCollection('matchResults').values()]
      .find(row => row.data.sessionId === 'session-1')!
    bad.data.sets = 'not-json{{{'
    const entries = await h.readHistory('alice', 'alice')
    expect(entries.map(entry => entry.sessionId).sort()).toEqual(['session-0', 'session-1'])
    expect(entries.find(entry => entry.sessionId === 'session-1')).toMatchObject({
      won: false, sets: [[3, 6], [3, 6]], status: 'final',
    })
  })

  it('history: a corrupt session score hides the row even when stored sets are valid (R-D1/F6)', async () => {
    const h = createHarness()
    h.seedProfile('alice')
    for (let i = 0; i < 4; i++) h.seedFinalMatch('alice', 'bob', i, { won: true })
    const session = h.store.getCollection('sessions').get('session-3')!
    session.data.matchScore = 'corrupt{{{'
    const entries = await h.readHistory('alice', 'alice')
    expect(entries.map(entry => entry.sessionId).sort()).toEqual(['session-0', 'session-1', 'session-2'])
  })

  it('history: a valid final row whose session is gone is dropped (history verifies; stats trusts old rows)', async () => {
    const h = createHarness()
    h.seedProfile('alice')
    h.seed('matchResults', {
      sessionId: 'gone-session', format: 'singles', won: 1, sets: JSON.stringify([[6, 4], [6, 3]]),
      resultRevision: 2, finalizedAt: '2030-06-06T15:00:00.000Z', userId: 'alice', visibility: 'public',
    }, 'alice')
    expect(await h.readHistory('alice', 'alice')).toHaveLength(0)
    expect((await h.readStats('alice', 'alice')).singles).toMatchObject({ wins: 1, matchesPlayed: 1 })
  })
})
