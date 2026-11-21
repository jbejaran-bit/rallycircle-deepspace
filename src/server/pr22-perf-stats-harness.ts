/**
 * Perf harness — stats/history side. Extracted verbatim from
 * pr22-stats-aggregation.test.ts (feature/muse-pr22-stats-aggregation),
 * describe blocks removed, exported as createStatsHarness for the
 * package-8 benchmarks. In-memory RecordRoom, 1 ms per fetch, session
 * GETs counted on the ActionTools side.
 */

import { expect } from 'vitest'
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

export function createStatsHarness() {
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
