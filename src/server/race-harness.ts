/**
 * Shared command-room test harness (extracted from the PR #19 data-race
 * reproductions, `pr19-races.test.ts` lines 1–726, as adapted for PR #22
 * in the pr22-reconcile worktree: fake DurableObjectStorage + room env
 * with RALLY_COMMAND_ROOMS).
 *
 * Each scenario runs against the REAL command-room code paths
 * (rallyCommandAction -> RallyCommandRoom.fetch -> applyCommand) with a
 * mock RecordRoom that reproduces the SDK's verified query semantics
 * (orderBy/orderDir/limit/offset with nextOffset, unknown orderBy
 * rejected, default newest-first) and deterministic fault injection
 * (fail / throw / hold the Nth matching tool call). Nothing here touches
 * a live app, production data, or any credential: every identity is an
 * explicit userId passed through the real action path, exactly as the
 * action would call it after Bearer verification in production.
 *
 * Harness fidelity notes:
 * - One RallyCommandRoom per session (and per series), exactly like
 *   production, where the room is keyed `rally:<appId>:<sessionId>`. A
 *   single shared room would serialize cross-session commands and HIDE
 *   the cross-session races.
 * - `uniqueOn` is enforced for rsvps, waitlists, polls, pollVotes,
 *   notifications, notificationPreferences, playerStats and matchResults,
 *   so a double-apply fails loudly instead of silently duplicating rows.
 * - userBound columns are stamped from the tool call's X-User-Id header,
 *   never from the payload — mirroring the RecordRoom.
 * - Pagination helpers in production code must terminate even against a
 *   store that ignores `offset` (older mocks do): the tests seed >100 /
 *   >500 rows and assert exact counts, so a non-terminating page loop
 *   would hang the suite instead of failing it.
 *
 * What this file CANNOT prove (needs a live authorized session):
 * - Real RecordRoom enforcement of uniqueOn / read permissions.
 * - Real Durable Object queue behaviour under eviction.
 * - Two-browser real-time sync.
 */

import { expect } from 'vitest'
import type { ActionHandler, ActionResult, ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker.js'
import {
  awardPoint,
  createMatchScore,
  readMatchScore,
  type MatchScore,
} from '../lib/rally-score.js'
import type { RallySession } from '../lib/rally.js'
import { parsePollTally } from '../lib/polls.js'
import {
  applyFinalization,
  type FinalizationTool,
} from './result-finalization.js'
import { getPlayerStatsAction } from './profile-actions.js'
import {
  rallyCommandAction,
  RallyCommandRoom,
  schedulingAction,
} from './rally-command-room.js'

/** PR #22 adaptation: PR #20 added Durable Object recovery (armRecovery /
 * recover / alarm) that calls state.storage. The PR #19 harnesses built rooms
 * with `{}` as the state, so every finalize/correct path threw
 * "state.storage is undefined" and the action masked it as "temporarily
 * unavailable". This in-memory stand-in mirrors the storage surface the
 * room uses (get/put/delete/setAlarm/deleteAlarm/transaction); it is test
 * scaffolding only, not product code. */
function fakeDurableObjectState(): DurableObjectState {
  const store = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => store.get(key),
    put: async (key: string, value: unknown) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    setAlarm: async (_when: number) => undefined,
    deleteAlarm: async () => undefined,
    transaction: async (fn: (s: unknown) => Promise<unknown>) => fn(storage),
  }
  return { storage } as unknown as DurableObjectState
}

type Row = {
  recordId: string
  createdBy: string
  createdAt: number
  updatedAt: number
  seq: number
  data: Record<string, unknown>
}

type FailureMode = 'fail' | 'throw'

interface FailureRule {
  tool: string
  collection: string
  remaining: number
  mode: FailureMode
  error: string
  predicate?: (params: Record<string, unknown>) => boolean
  callIndex?: number
  seen: number
}

interface HoldRule {
  tool: string
  collection: string
  callIndex: number
  seen: number
  release: (() => void) | null
  waiting: number
}

const USER_BOUND: Record<string, string> = {
  sessions: 'hostId',
  rsvps: 'userId',
  waitlists: 'userId',
  profiles: 'userId',
  playerStats: 'userId',
  matchResults: 'userId',
  resultAudits: 'userId',
  polls: 'hostId',
  pollVotes: 'userId',
  notifications: 'recipientId',
  notificationPreferences: 'userId',
  recurringSeries: 'hostId',
}

const UNIQUE_ON: Record<string, string[]> = {
  rsvps: ['sessionId', 'userId'],
  waitlists: ['sessionId', 'userId'],
  polls: ['sessionId'],
  pollVotes: ['pollId', 'optionId', 'userId'],
  notifications: ['recipientId', 'idempotencyKey'],
  notificationPreferences: ['userId'],
  profiles: ['userId'],
  playerStats: ['userId', 'format'],
  matchResults: ['sessionId', 'userId'],
}

const COLLECTIONS = [
  'sessions', 'rsvps', 'waitlists', 'profiles', 'playerStats',
  'matchResults', 'resultAudits', 'polls', 'pollVotes',
  'notifications', 'notificationPreferences', 'recurringSeries',
]

function sortKey(row: Row, orderBy: string): number | string {
  if (orderBy === 'createdAt') return row.createdAt
  if (orderBy === 'updatedAt') return row.updatedAt
  const value = row.data[orderBy]
  if (typeof value === 'number' || typeof value === 'string') return value
  return String(value ?? '')
}

function compareValues(a: number | string, b: number | string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

export function createRaceHarness({
  yieldRecordRoom = () => new Promise<void>(resolve => setTimeout(resolve, 1)),
}: { yieldRecordRoom?: () => Promise<void> } = {}) {
  const store = new Map<string, Map<string, Row>>()
  for (const name of COLLECTIONS) store.set(name, new Map())
  let nextRecordId = 0
  let nextStamp = 0
  let nextSeq = 0
  const failures: FailureRule[] = []
  const holds: HoldRule[] = []
  const callCounts = new Map<string, number>()

  function collection(name: string): Map<string, Row> {
    let map = store.get(name)
    if (!map) {
      map = new Map()
      store.set(name, map)
    }
    return map
  }

  function countCall(tool: string, coll: string): number {
    const key = `${tool}:${coll}`
    const next = (callCounts.get(key) ?? 0) + 1
    callCounts.set(key, next)
    return next
  }

  /** Fail the next `times` matching calls (or, with callIndex, only the Nth). */
  function failTool(
    tool: string,
    coll: string,
    times = 1,
    opts: {
      mode?: FailureMode
      error?: string
      predicate?: (params: Record<string, unknown>) => boolean
      callIndex?: number
    } = {},
  ) {
    failures.push({
      tool, collection: coll, remaining: times,
      mode: opts.mode ?? 'fail', error: opts.error ?? 'Simulated tool failure',
      predicate: opts.predicate, callIndex: opts.callIndex, seen: 0,
    })
  }

  /** Hold the Nth matching call until releaseHeld() is called. */
  function holdTool(tool: string, coll: string, callIndex = 1) {
    holds.push({ tool, collection: coll, callIndex, seen: 0, release: null, waiting: 0 })
  }

  function releaseHeld() {
    for (const hold of holds) {
      if (hold.release) {
        const release = hold.release
        hold.release = null
        release()
      }
    }
  }

  function heldCount(): number {
    return holds.reduce((sum, hold) => sum + hold.waiting, 0)
  }

  function toolCallCount(tool: string, coll: string): number {
    return callCounts.get(`${tool}:${coll}`) ?? 0
  }

  function consumeFailure(
    tool: string,
    coll: string,
    params: Record<string, unknown>,
  ): { error: string; mode: FailureMode } | null {
    for (const rule of failures) {
      if (rule.tool !== tool || rule.collection !== coll || rule.remaining <= 0) continue
      if (rule.predicate && !rule.predicate(params)) continue
      rule.seen++
      if (rule.callIndex !== undefined && rule.seen !== rule.callIndex) continue
      rule.remaining--
      return { error: rule.error, mode: rule.mode }
    }
    return null
  }

  async function maybeHold(tool: string, coll: string): Promise<void> {
    for (const hold of holds) {
      if (hold.tool !== tool || hold.collection !== coll) continue
      hold.seen++
      if (hold.seen !== hold.callIndex || hold.release) continue
      await new Promise<void>(resolve => { hold.release = resolve; hold.waiting++ })
      hold.waiting--
    }
  }

  function orderRows(
    rows: Row[],
    params: Record<string, unknown>,
  ): { ok: true; records: Row[]; nextOffset?: number } | { ok: false; error: string } {
    const { orderBy, orderDir, limit, offset } = params
    if (orderBy !== undefined && typeof orderBy !== 'string') {
      return { ok: false, error: 'orderBy must be a string' }
    }
    if (orderBy !== undefined) {
      const known = orderBy === 'createdAt' || orderBy === 'updatedAt' ||
        rows.some(row => orderBy in row.data)
      if (!known) return { ok: false, error: `Unknown orderBy: ${JSON.stringify(orderBy)}` }
    }
    if (orderDir !== undefined && orderDir !== 'asc' && orderDir !== 'desc') {
      return { ok: false, error: `orderDir must be "asc" or "desc", not ${JSON.stringify(orderDir)}` }
    }
    if (limit !== undefined && !(Number.isInteger(limit) && (limit as number) >= 1)) {
      return { ok: false, error: 'limit must be an integer >= 1' }
    }
    if (offset !== undefined && !(Number.isInteger(offset) && (offset as number) >= 0)) {
      return { ok: false, error: 'offset must be a whole number of at least 0' }
    }
    const ordered = [...rows]
    const descending = orderDir !== 'asc'
    if (orderBy === undefined) {
      ordered.sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq)
    } else {
      ordered.sort((a, b) => {
        const cmp = compareValues(sortKey(a, orderBy as string), sortKey(b, orderBy as string))
        if (cmp !== 0) return descending ? -cmp : cmp
        return descending ? b.seq - a.seq : a.seq - b.seq
      })
    }
    const start = typeof offset === 'number' ? offset : 0
    const page = typeof limit === 'number' ? ordered.slice(start, start + limit) : ordered.slice(start)
    const nextOffset = start + page.length < ordered.length ? start + page.length : undefined
    return { ok: true, records: page, nextOffset }
  }

  function publicRecord(row: Row) {
    return {
      recordId: row.recordId,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      data: { ...row.data },
    }
  }

  const recordRoom = {
    async fetch(request: Request) {
      const { tool, params } = (await request.json()) as {
        tool: string
        params: Record<string, unknown>
      }
      await yieldRecordRoom()
      const coll = typeof params.collection === 'string' ? params.collection : ''
      const callNumber = countCall(tool, coll)
      void callNumber
      const failure = consumeFailure(tool, coll, params)
      if (failure) {
        if (failure.mode === 'throw') throw new Error(failure.error)
        return Response.json({ success: false, error: failure.error })
      }
      await maybeHold(tool, coll)

      if (tool === 'records.get') {
        const record = collection(coll).get(String(params.recordId))
        return record
          ? Response.json({ success: true, data: { record: publicRecord(record) } })
          : Response.json({ success: false, error: 'Record not found' })
      }

      if (tool === 'records.query') {
        const where = (params.where ?? {}) as Record<string, unknown>
        const filtered = [...collection(coll).values()].filter(record =>
          Object.entries(where).every(([key, value]) => record.data[key] === value),
        )
        const ordered = orderRows(filtered, params)
        if (!ordered.ok) return Response.json({ success: false, error: ordered.error })
        const records = ordered.records.map(publicRecord)
        return Response.json({
          success: true,
          data: { records, count: records.length, nextOffset: ordered.nextOffset },
        })
      }

      if (tool === 'records.create') {
        const data = { ...(params.data as Record<string, unknown>) }
        const userId = request.headers.get('X-User-Id') ?? ''
        const bound = USER_BOUND[coll]
        if (bound && !(bound in data)) data[bound] = userId
        const unique = UNIQUE_ON[coll]
        if (unique && [...collection(coll).values()].some(row =>
          unique.every(key => row.data[key] === data[key]),
        )) {
          return Response.json({ success: false, error: `Duplicate ${coll} record` })
        }
        const recordId = typeof params.recordId === 'string' && params.recordId
          ? params.recordId
          : `${coll}-${++nextRecordId}`
        if (collection(coll).has(recordId)) {
          return Response.json({ success: false, error: `Duplicate ${coll} record` })
        }
        const stamp = ++nextStamp
        collection(coll).set(recordId, {
          recordId, createdBy: userId, createdAt: stamp, updatedAt: stamp, seq: ++nextSeq, data,
        })
        return Response.json({ success: true, data: { recordId } })
      }

      if (tool === 'records.update') {
        const record = collection(coll).get(String(params.recordId))
        if (!record) return Response.json({ success: false, error: 'Record not found' })
        Object.assign(record.data, params.data as Record<string, unknown>)
        record.updatedAt = ++nextStamp
        return Response.json({ success: true, data: { recordId: record.recordId } })
      }

      if (tool === 'records.delete') {
        const deleted = collection(coll).delete(String(params.recordId))
        return Response.json(deleted
          ? { success: true, data: { recordId: String(params.recordId) } }
          : { success: false, error: 'Not found' })
      }

      return Response.json({ success: false, error: 'Unexpected tool request' })
    },
  }

  const env = {
    DEEPSPACE_APP_ID: 'test-app',
    RECORD_ROOMS: {
      idFromName: (name: string) => name,
      get: () => recordRoom,
    },
  } as unknown as Env

  // One room per session / series, exactly like production.
  const rooms = new Map<string, RallyCommandRoom>()
  function roomFor(name: string): RallyCommandRoom {
    let room = rooms.get(name)
    if (!room) {
      room = new RallyCommandRoom(fakeDurableObjectState(), actionEnv)
      rooms.set(name, room)
    }
    return room
  }
  const commandNamespace = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: (request: Request) => roomFor(name).fetch(request),
    }),
  }
  const actionEnv = { ...env, RALLY_COMMAND_ROOMS: commandNamespace } as unknown as Env

  function sessionRow(recordId: string): Row | undefined {
    return collection('sessions').get(recordId)
  }

  function addSession(
    recordId: string,
    hostId: string,
    overrides: Partial<RallySession> = {},
  ): void {
    const stamp = ++nextStamp
    collection('sessions').set(recordId, {
      recordId,
      createdBy: hostId,
      createdAt: stamp,
      updatedAt: stamp,
      seq: ++nextSeq,
      data: {
        format: 'Singles',
        title: 'Test rally',
        court: 'Test court',
        location: 'Pittsburgh',
        startsAt: '2031-01-01T12:00:00.000Z',
        durationMinutes: 90,
        targetPlayers: 2,
        capacity: 4,
        level: 'All levels',
        notes: '',
        hostId,
        chatChannelId: '',
        status: 'open',
        seriesId: '',
        scheduleRevision: 0,
        pendingResult: '',
        ...overrides,
      },
    })
  }

  function addRsvp(sessionId: string, userId: string, status: 'going' | 'maybe'): void {
    const stamp = ++nextStamp
    collection('rsvps').set(`rsvp-${++nextRecordId}`, {
      recordId: `rsvp-${nextRecordId}`,
      createdBy: userId,
      createdAt: stamp,
      updatedAt: stamp,
      seq: ++nextSeq,
      data: { sessionId, userId, status },
    })
  }

  function addPollVote(pollId: string, optionId: string, userId: string): void {
    const stamp = ++nextStamp
    collection('pollVotes').set(`pv-${++nextRecordId}`, {
      recordId: `pv-${nextRecordId}`,
      createdBy: userId,
      createdAt: stamp,
      updatedAt: stamp,
      seq: ++nextSeq,
      data: { pollId, optionId, userId },
    })
  }

  function addProfile(userId: string, visibility: 'public' | 'private' = 'public'): void {
    const stamp = ++nextStamp
    collection('profiles').set(`profile-${userId}`, {
      recordId: `profile-${userId}`,
      createdBy: userId,
      createdAt: stamp,
      updatedAt: stamp,
      seq: ++nextSeq,
      data: {
        userId, displayName: userId, bio: '', formats: [],
        preferredArea: '', selfReportedLevel: 'Unrated', visibility,
      },
    })
  }

  function addMatchResult(
    sessionId: string,
    userId: string,
    won: 0 | 1,
    revision = 1,
  ): void {
    const stamp = ++nextStamp
    collection('matchResults').set(`mr-${++nextRecordId}`, {
      recordId: `mr-${nextRecordId}`,
      createdBy: userId,
      createdAt: stamp,
      updatedAt: stamp,
      seq: ++nextSeq,
      data: {
        sessionId, userId, format: 'singles', won,
        sets: JSON.stringify([[6, 0], [6, 0]]),
        resultRevision: revision, finalizedAt: '2031-01-01T00:00:00.000Z',
        visibility: 'public',
      },
    })
  }

  function addPlayerStats(userId: string, wins: number, losses: number): void {
    const stamp = ++nextStamp
    collection('playerStats').set(`ps-${userId}`, {
      recordId: `ps-${userId}`,
      createdBy: userId,
      createdAt: stamp,
      updatedAt: stamp,
      seq: ++nextSeq,
      data: { userId, format: 'singles', wins, losses, matchesPlayed: wins + losses, visibility: 'public' },
    })
  }

  /** A direct client write to a session, bypassing the command room. */
  function directUpdateSession(recordId: string, patch: Record<string, unknown>): boolean {
    const row = sessionRow(recordId)
    if (!row) return false
    Object.assign(row.data, patch)
    row.updatedAt = ++nextStamp
    return true
  }

  async function command(userId: string, params: Record<string, unknown>) {
    return rallyCommandAction({
      userId,
      params,
      env: actionEnv,
      callerJwt: 'test-token',
      tools: {
        get: async (_collection: string, recordId: string) => {
          const record = sessionRow(recordId)
          return record
            ? {
              success: true as const,
              data: { record: { ...publicRecord(record), createdAt: '', updatedAt: '' } },
            }
            : { success: false as const, error: 'Record not found' }
        },
      } as ActionTools,
    })
  }

  async function schedule(userId: string, params: Record<string, unknown>) {
    return schedulingAction({ userId, params, env: actionEnv } as Parameters<typeof schedulingAction>[0])
  }

  /** A raw fetch straight to a command room, as an unauthenticated caller
   *  could make it — no action, no Bearer check, no marker unless given. */
  async function roomFetch(
    roomName: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: unknown }> {
    const response = await roomFor(roomName).fetch(
      new Request(`https://internal${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    )
    let json: unknown = null
    try { json = await response.json() } catch { /* non-JSON body */ }
    return { status: response.status, json }
  }

  async function queryRaw(
    collectionName: string,
    where: Record<string, unknown>,
    userId = 'reader',
    extra: Record<string, unknown> = {},
  ): Promise<Row[]> {
    const response = await recordRoom.fetch(
      new Request('https://internal/api/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify({ tool: 'records.query', params: { collection: collectionName, where, ...extra } }),
      }),
    )
    const body = (await response.json()) as { success: boolean; data?: { records?: Row[] } }
    if (!body.success) return []
    return (body.data?.records ?? []) as Row[]
  }

  async function queryAllRaw(
    collectionName: string,
    where: Record<string, unknown>,
    userId = 'reader',
  ): Promise<Row[]> {
    const all: Row[] = []
    let offset = 0
    for (let page = 0; page < 50; page++) {
      const response = await recordRoom.fetch(
        new Request('https://internal/api/tools/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
          body: JSON.stringify({
            tool: 'records.query',
            params: { collection: collectionName, where, limit: 100, offset },
          }),
        }),
      )
      const body = (await response.json()) as {
        success: boolean
        data?: { records?: Row[]; nextOffset?: number }
      }
      if (!body.success) break
      const records = (body.data?.records ?? []) as Row[]
      const fresh = records.filter(row => !all.some(seen => seen.recordId === row.recordId))
      all.push(...fresh)
      if (body.data?.nextOffset === undefined || fresh.length === 0) break
      offset = body.data.nextOffset
    }
    return all
  }

  function readSession(recordId: string): RallySession | null {
    const row = sessionRow(recordId)
    return row ? (JSON.parse(JSON.stringify(row.data)) as RallySession) : null
  }

  /** ActionTools stub over the same store (actions run RBAC-off in production). */
  function actionTools(callerId: string): ActionTools {
    const readRows = async <T>(collectionName: string, where: Record<string, unknown>, limit = 100, offset = 0) => {
      const rows = await queryRaw(collectionName, where, callerId, { limit, offset })
      return rows as unknown as T[]
    }
    return {
      query: (async (collectionName: string, params: Record<string, unknown>) => {
        const where = (params.where ?? {}) as Record<string, unknown>
        const records = await readRows(
          collectionName, where,
          typeof params.limit === 'number' ? params.limit : 100,
          typeof params.offset === 'number' ? params.offset : 0,
        )
        return { success: true as const, data: { records, count: records.length } }
      }) as ActionTools['query'],
      get: (async (collectionName: string, recordId: string) => {
        const row = collection(collectionName).get(recordId)
        return row
          ? { success: true as const, data: { record: publicRecord(row) } }
          : { success: false as const, error: 'Record not found' }
      }) as ActionTools['get'],
      create: (async (collectionName: string, data: Record<string, unknown>, recordId?: string) => {
        const stamped = { ...data }
        const bound = USER_BOUND[collectionName]
        if (bound && !(bound in stamped)) stamped[bound] = callerId
        const id = recordId ?? `${collectionName}-${++nextRecordId}`
        const stamp = ++nextStamp
        collection(collectionName).set(id, {
          recordId: id, createdBy: callerId, createdAt: stamp, updatedAt: stamp, seq: ++nextSeq, data: stamped,
        })
        return { success: true as const, data: { recordId: id } }
      }) as ActionTools['create'],
      update: (async (collectionName: string, recordId: string, data: Record<string, unknown>) => {
        const row = collection(collectionName).get(recordId)
        if (!row) return { success: false as const, error: 'Record not found' }
        Object.assign(row.data, data)
        row.updatedAt = ++nextStamp
        return { success: true as const, data: { recordId } }
      }) as ActionTools['update'],
      remove: (async (collectionName: string, recordId: string) => {
        const deleted = collection(collectionName).delete(recordId)
        return deleted
          ? { success: true as const, data: { recordId } }
          : { success: false as const, error: 'Not found' }
      }) as ActionTools['remove'],
    } as ActionTools
  }

  return {
    addSession, addRsvp, addProfile, addMatchResult, addPlayerStats, addPollVote,
    directUpdateSession, command, schedule, roomFetch, queryRaw, queryAllRaw,
    readSession, actionTools, failTool, holdTool, releaseHeld, heldCount,
    toolCallCount, store,
  }
}

export type RaceHarness = ReturnType<typeof createRaceHarness>

/** A Singles score with a winner decided and no approvals yet. */
export function decidedScore(
  teams: [[string], [string]],
  winner: 0 | 1,
  revision = 0,
): MatchScore {
  let score = createMatchScore(teams)
  // 48 points at 4-points-a-game wins two 6-0 sets for the winner's side.
  for (let point = 0; point < 48; point++) score = awardPoint(score, winner)
  return { ...score, revision }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<boolean> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) return false
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return true
}

/** Create the standard two-option poll and return its record id. */
export async function createTestPoll(h: RaceHarness, sessionId: string): Promise<string> {
  const created = await h.command('host', {
    operation: 'createPoll', sessionId,
    options: [
      { id: 'opt-1', startsAt: '2031-02-01T19:00:00.000Z' },
      { id: 'opt-2', startsAt: '2031-02-08T19:00:00.000Z' },
    ],
  })
  expect(created.success).toBe(true)
  const pollId = (created as { data?: { recordId?: string } }).data?.recordId
  expect(typeof pollId).toBe('string')
  return pollId as string
}

