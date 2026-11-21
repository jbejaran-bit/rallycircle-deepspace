/**
 * PR #22 adversarial testing, part B item 7 — serialized rally creation,
 * plus the duplicate-creation fix (feature/muse-pr22-dup-create-fixes).
 *
 * Target: `review/rallycircle-serialized-session-time` @ e6ff2d9 (PR #22).
 * PR #22 closes direct session start-time writes (member/admin create
 * false, 'startsAt' removed from writableFields) and routes creation
 * through the `createRally` server action (zod-strict draft +
 * validateSession). What it did NOT add is any serialization,
 * idempotency, or duplicate check for creation itself: the action called
 * tools.create directly, with no command-room hop, no per-user queue,
 * and no uniqueOn on (hostId, startsAt) — so two identical concurrent
 * creates both succeeded as distinct sessions (DUPLICATE-CONFIRMED on
 * unfixed e6ff2d9; see IMPLEMENTATION_LOG.md).
 *
 * The fix routes creation through a per-user command room
 * (`rally:<appId>:user:<userId>`), which serializes the host's creates
 * and returns the existing open session when the incoming draft exactly
 * matches one — so a double-submit and a retry after a transient failure
 * both land on one session, while distinct drafts (different host, time,
 * or details) still create distinct sessions.
 *
 * Every test here is local simulation (mock tools / in-memory record
 * room). Nothing touches live auth, production data, or a real
 * RecordRoom.
 */

import { canCreate, checkFieldPermissions } from 'deepspace/worker'
import type { ActionTools } from 'deepspace/worker'
import { describe, expect, it, vi } from 'vitest'
import { sessionsSchema } from '../schemas/rally-schema.js'
import type { RallySession } from '../lib/rally.js'
import type { Env } from '../../worker.js'
import { createRallyAction } from './create-rally-action.js'
import { rallyCommandAction, RallyCommandRoom, schedulingAction } from './rally-command-room.js'

type Row = { recordId: string; createdAt: number; data: Record<string, unknown> }

function createFakeState() {
  const store = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => store.get(key),
    put: async (key: string, value: unknown) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    setAlarm: async (_when: number) => undefined,
    deleteAlarm: async () => undefined,
    transaction: async (fn: (s: unknown) => Promise<boolean>) => fn(storage),
  }
  return { storage } as unknown as DurableObjectState
}

/** Minimal record room: sessions + rsvps + polls + notifications, shared by create + cancel paths. */
function createHarness() {
  const sessions = new Map<string, Row>()
  const rsvps = new Map<string, Row>()
  const polls = new Map<string, Row>()
  const notifications = new Map<string, Row>()
  const recurringSeries = new Map<string, Row>()
  const stores: Record<string, Map<string, Row>> = { sessions, rsvps, polls, notifications, recurringSeries }
  let nextRecordId = 0
  let nextCreatedAt = 0
  /** Artificial write latency (ms) applied to session creates, to force overlap in the race tests. */
  let createDelayMs = 0
  /** Fail the next N session creates at the record layer (transient-failure injection). */
  let failNextSessionCreate = 0

  const recordRoom = {
    async fetch(request: Request) {
      const { tool, params } = await request.json() as { tool: string; params: Record<string, unknown> }
      await new Promise(resolve => setTimeout(resolve, 1))
      const caller = request.headers.get('X-User-Id') ?? ''
      const store = stores[String(params.collection)]
      if (!store) return Response.json({ success: false, error: 'Unknown collection' })
      if (tool === 'records.get') {
        const record = store.get(String(params.recordId))
        return record
          ? Response.json({ success: true, data: { record } })
          : Response.json({ success: false, error: 'Record not found' })
      }
      if (tool === 'records.query') {
        const where = (params.where ?? {}) as Record<string, unknown>
        let records = [...store.values()].filter(r => Object.entries(where).every(([k, v]) => r.data[k] === v))
        if (typeof params.offset === 'number') records = records.slice(params.offset)
        if (typeof params.limit === 'number') records = records.slice(0, params.limit)
        return Response.json({ success: true, data: { records, count: records.length } })
      }
      if (tool === 'records.create') {
        if (createDelayMs > 0) await new Promise(resolve => setTimeout(resolve, createDelayMs))
        if (failNextSessionCreate > 0 && String(params.collection) === 'sessions') {
          failNextSessionCreate--
          return Response.json({ success: false, error: 'Injected write failure' })
        }
        const data = { ...(params.data as Record<string, unknown>) }
        // hostId is userBound on sessions and recurringSeries: the real
        // RecordRoom stamps it from the caller, so the harness does too.
        if ((String(params.collection) === 'sessions' || String(params.collection) === 'recurringSeries') && !('hostId' in data)) data.hostId = caller
        if (String(params.collection) === 'notifications' && !('recipientId' in data)) data.recipientId = caller
        const recordId = typeof params.recordId === 'string' && params.recordId
          ? params.recordId
          : `rec-${++nextRecordId}`
        if (store.has(recordId)) return Response.json({ success: false, error: 'Duplicate: record id' })
        store.set(recordId, { recordId, createdAt: ++nextCreatedAt, data })
        return Response.json({ success: true, data: { recordId } })
      }
      if (tool === 'records.update') {
        const record = store.get(String(params.recordId))
        if (!record) return Response.json({ success: false, error: 'Record not found' })
        Object.assign(record.data, params.data as Record<string, unknown>)
        return Response.json({ success: true, data: { recordId: record.recordId } })
      }
      if (tool === 'records.delete') {
        return Response.json(store.delete(String(params.recordId))
          ? { success: true, data: { recordId: String(params.recordId) } }
          : { success: false, error: 'Not found' })
      }
      return Response.json({ success: false, error: 'Unexpected tool request' })
    },
  }

  const env = {
    DEEPSPACE_APP_ID: 'test-app',
    OWNER_USER_ID: 'app-owner',
    RECORD_ROOMS: { idFromName: (name: string) => name, get: () => recordRoom },
  } as unknown as Env
  const rooms = new Map<string, RallyCommandRoom>()
  function roomFor(id: string): RallyCommandRoom {
    let found = rooms.get(id)
    if (!found) {
      found = new RallyCommandRoom(createFakeState(), env)
      rooms.set(id, found)
    }
    return found
  }
  const commandNamespace = {
    idFromName: (name: string) => name,
    get: (id: string) => ({ fetch: (request: Request) => roomFor(id).fetch(request) }),
  }
  ;(env as unknown as Record<string, unknown>).RALLY_COMMAND_ROOMS = commandNamespace
  const actionEnv = { ...env, RALLY_COMMAND_ROOMS: commandNamespace } as unknown as Env

  function toolFetch(tool: string, params: Record<string, unknown>, userId: string) {
    return recordRoom.fetch(new Request('https://internal/api/tools/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': userId, 'X-App-Action': 'true' },
      body: JSON.stringify({ tool, params }),
    })).then(r => r.json()) as Promise<never>
  }

  function actionTools(userId: string): ActionTools {
    return {
      get: (c: string, id: string) => toolFetch('records.get', { collection: c, recordId: id }, userId),
      query: (c: string, o: Record<string, unknown>) => toolFetch('records.query', { collection: c, ...o }, userId),
      update: (c: string, id: string, d: Record<string, unknown>) => toolFetch('records.update', { collection: c, recordId: id, data: d }, userId),
      create: (c: string, d: Record<string, unknown>, id?: string) => toolFetch('records.create', { collection: c, data: d, recordId: id }, userId),
      remove: (c: string, id: string) => toolFetch('records.delete', { collection: c, recordId: id }, userId),
    } as unknown as ActionTools
  }

  async function createRally(userId: string, params: Record<string, unknown>) {
    return createRallyAction({ userId, params, tools: actionTools(userId), env: actionEnv, callerJwt: 'test-token' })
  }

  async function scheduleCommand(userId: string, params: Record<string, unknown>) {
    return schedulingAction({
      userId, params, env: actionEnv, callerJwt: 'test-token', tools: {} as ActionTools,
    })
  }

  async function command(userId: string, params: Record<string, unknown>) {
    return rallyCommandAction({
      userId, params, env: actionEnv, callerJwt: 'test-token',
      tools: {
        get: async (_collection: string, recordId: string) => {
          const record = sessions.get(recordId)
          return record
            ? { success: true as const, data: { record: { ...record, createdAt: '', updatedAt: '' } } }
            : { success: false as const, error: 'Record not found' }
        },
      } as ActionTools,
    })
  }

  function addSession(recordId: string, hostId: string, startsAt = '2030-01-01T12:00:00.000Z') {
    sessions.set(recordId, {
      recordId, createdAt: ++nextCreatedAt,
      data: {
        title: 'Test rally', court: 'Test court', location: 'Pittsburgh',
        startsAt, durationMinutes: 90, targetPlayers: 4,
        level: 'All levels', notes: '', hostId, chatChannelId: '', status: 'open',
      },
    })
  }

  return {
    createRally, command, scheduleCommand, addSession,
    setCreateDelay: (ms: number) => { createDelayMs = ms },
    setFailNextSessionCreate: (n: number) => { failNextSessionCreate = n },
    sessions, rsvps, polls, notifications, recurringSeries,
  }
}

const draft = () => ({
  format: 'Singles',
  title: 'Evening rally',
  court: 'Public courts',
  location: 'Pittsburgh',
  startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  durationMinutes: 90,
  targetPlayers: 2,
  level: 'All levels',
  notes: '',
})

describe('item 7a — duplicate creation race (FIXED: per-user room hop)', () => {
  it('two simultaneous identical creates return the same session', async () => {
    const harness = createHarness()
    harness.setCreateDelay(20)
    // One shared draft object: draft() mints a fresh startsAt per call, so
    // two separate draft() calls would not be identical.
    const params = draft()
    const [first, second] = await Promise.all([
      harness.createRally('host', params),
      harness.createRally('host', params),
    ])
    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    const firstId = (first as unknown as { data: { recordId: string } }).data.recordId
    const secondId = (second as unknown as { data: { recordId: string } }).data.recordId
    // FIXED (was DUPLICATE-CONFIRMED on unfixed e6ff2d9): the per-user
    // room serializes the host's creates and the second identical draft
    // returns the session the first one just created.
    expect(secondId).toBe(firstId)
    expect([...harness.sessions.values()].filter(r =>
      r.data.hostId === 'host' && r.data.title === 'Evening rally')).toHaveLength(1)
  })

  it('ten rapid sequential identical creates make exactly one session', async () => {
    const harness = createHarness()
    const params = draft()
    let firstId: string | undefined
    for (let i = 0; i < 10; i++) {
      const result = await harness.createRally('host', params)
      expect(result.success).toBe(true)
      const id = (result as unknown as { data: { recordId: string } }).data.recordId
      if (firstId === undefined) firstId = id
      expect(id).toBe(firstId)
    }
    expect(harness.sessions.size).toBe(1)
  })
})

describe('item 7b — time validation on creation (SECURE)', () => {
  it('rejects a start time in the past', async () => {
    const harness = createHarness()
    const result = await harness.createRally('host', { ...draft(), startsAt: '2020-01-01T12:00:00.000Z' })
    expect(result.success).toBe(false)
    expect(harness.sessions.size).toBe(0)
  })

  it('rejects an invalid duration, so end-before-start is impossible by construction', async () => {
    const harness = createHarness()
    // Duration is a whitelist (60/90/120/150); end is always start + a
    // positive duration, so no draft can express end <= start.
    for (const durationMinutes of [0, -90, 45, 61, 200]) {
      const result = await harness.createRally('host', { ...draft(), durationMinutes })
      expect(result.success).toBe(false)
    }
    expect(harness.sessions.size).toBe(0)
    for (const durationMinutes of [60, 90, 120, 150]) {
      await expect(harness.createRally('host', { ...draft(), durationMinutes }))
        .resolves.toMatchObject({ success: true })
    }
    expect(harness.sessions.size).toBe(4)
  })

  it('rejects privileged draft fields before any storage write', async () => {
    const harness = createHarness()
    const create = vi.fn(async () => ({ success: true, data: { recordId: 's1' } }))
    const tools = { create } as unknown as ActionTools
    for (const patch of [
      { hostId: 'someone-else' },
      { scheduleRevision: 42 },
      { seriesId: 'other-series' },
      { status: 'cancelled' },
      { matchScore: '{}' },
    ]) {
      const result = await createRallyAction({
        userId: 'host', params: { ...draft(), ...patch },
        tools, env: {} as Env, callerJwt: 'test-token',
      })
      expect(result.success).toBe(false)
    }
    expect(create).not.toHaveBeenCalled()
    expect(harness.sessions.size).toBe(0)
  })
})

describe('item 7c — creation racing the host’s own cancellation (SECURE, no cross-talk)', () => {
  it('a create racing a cancel of another session leaves exactly one open session', async () => {
    const harness = createHarness()
    harness.addSession('to-cancel', 'host')
    harness.setCreateDelay(20)
    const [created, cancelled] = await Promise.all([
      harness.createRally('host', draft()),
      harness.command('host', { operation: 'cancel', sessionId: 'to-cancel' }),
    ])
    expect(created.success).toBe(true)
    expect(cancelled.success).toBe(true)
    expect(harness.sessions.get('to-cancel')!.data.status).toBe('cancelled')
    const createdId = (created as unknown as { data: { recordId: string } }).data.recordId
    expect(harness.sessions.get(createdId)!.data.status).toBe('open')
    expect([...harness.sessions.values()].filter(r => r.data.status === 'open')).toHaveLength(1)
  })
})

describe('item 7d — serialized session-time fields on PR #22 (SECURE)', () => {
  it('direct client writes of startsAt and session creation are closed', () => {
    expect(canCreate(sessionsSchema, 'member')).toBe(false)
    expect(canCreate(sessionsSchema, 'admin')).toBe(false)
    expect(checkFieldPermissions(sessionsSchema, 'member', { startsAt: '2030-02-01T12:00:00.000Z' }))
      .toMatch(`cannot modify field 'startsAt'`)
    expect(checkFieldPermissions(sessionsSchema, 'admin', { startsAt: '2030-02-01T12:00:00.000Z' }))
      .toMatch(`cannot modify field 'startsAt'`)
    // Safe owner edits still work through the record path.
    expect(checkFieldPermissions(sessionsSchema, 'member', { title: 'New title', notes: 'Hi' })).toBeNull()
  })

  it('createRally leaves host identity stamping to the authenticated record tool', async () => {
    const harness = createHarness()
    const result = await harness.createRally('host', draft())
    expect(result.success).toBe(true)
    const createdId = (result as unknown as { data: { recordId: string } }).data.recordId
    expect(harness.sessions.get(createdId)!.data.hostId).toBe('host')
  })
})

describe('item 7e — retry idempotency, cancel/re-create, distinct drafts, series regression (FIXED)', () => {
  it('a retry after a successful create returns the same session (lost-response retry)', async () => {
    const harness = createHarness()
    const params = draft()
    const first = await harness.createRally('host', params)
    expect(first.success).toBe(true)
    const firstId = (first as unknown as { data: { recordId: string } }).data.recordId
    const retry = await harness.createRally('host', params)
    expect(retry.success).toBe(true)
    expect((retry as unknown as { data: { recordId: string } }).data.recordId).toBe(firstId)
    expect(harness.sessions.size).toBe(1)
  })

  it('a retry after a transient write failure creates exactly one session', async () => {
    const harness = createHarness()
    const params = draft()
    harness.setFailNextSessionCreate(1)
    const failed = await harness.createRally('host', params)
    expect(failed.success).toBe(false)
    expect(harness.sessions.size).toBe(0)
    const retry = await harness.createRally('host', params)
    expect(retry.success).toBe(true)
    expect(harness.sessions.size).toBe(1)
    // And a third identical call still lands on the same session.
    const again = await harness.createRally('host', params)
    expect((again as unknown as { data: { recordId: string } }).data.recordId)
      .toBe((retry as unknown as { data: { recordId: string } }).data.recordId)
    expect(harness.sessions.size).toBe(1)
  })

  it('cancel then re-create with the identical draft creates a new session', async () => {
    const harness = createHarness()
    const params = draft()
    const first = await harness.createRally('host', params)
    const firstId = (first as unknown as { data: { recordId: string } }).data.recordId
    const cancelled = await harness.command('host', { operation: 'cancel', sessionId: firstId })
    expect(cancelled.success).toBe(true)
    expect(harness.sessions.get(firstId)!.data.status).toBe('cancelled')
    const second = await harness.createRally('host', params)
    expect(second.success).toBe(true)
    const secondId = (second as unknown as { data: { recordId: string } }).data.recordId
    expect(secondId).not.toBe(firstId)
    expect(harness.sessions.get(secondId)!.data.status).toBe('open')
    expect(harness.sessions.size).toBe(2)
  })

  it('distinct drafts still create distinct sessions', async () => {
    const harness = createHarness()
    const base = draft()
    const sameTimeDifferentTitle = await harness.createRally('host', { ...base, title: 'Morning rally' })
    const sameTimeDifferentCourt = await harness.createRally('host', { ...base, title: 'Evening rally', court: 'Other courts' })
    const differentTime = await harness.createRally('host', { ...base, startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() })
    const differentHost = await harness.createRally('guest', base)
    expect(sameTimeDifferentTitle.success).toBe(true)
    expect(sameTimeDifferentCourt.success).toBe(true)
    expect(differentTime.success).toBe(true)
    expect(differentHost.success).toBe(true)
    expect(harness.sessions.size).toBe(4)
    const ids = [sameTimeDifferentTitle, sameTimeDifferentCourt, differentTime, differentHost]
      .map(r => (r as unknown as { data: { recordId: string } }).data.recordId)
    expect(new Set(ids).size).toBe(4)
  })

  it('series creation and occurrence generation still work (regression guard)', async () => {
    const harness = createHarness()
    const template = {
      format: 'Doubles' as const,
      title: 'Weekly doubles',
      court: 'Schenley Park',
      location: 'Pittsburgh, PA',
      durationMinutes: 90,
      targetPlayers: 4,
      level: 'Intermediate' as const,
      notes: '',
    }
    const created = await harness.scheduleCommand('host', {
      operation: 'createSeries', template, startStartsAt: '2030-01-05T18:00:00.000Z', intervalWeeks: 1, count: 3,
    })
    expect(created.success).toBe(true)
    const seriesId = (created as unknown as { data: { recordId: string } }).data.recordId
    const generated = await harness.scheduleCommand('host', { operation: 'generateOccurrences', seriesId })
    expect(generated.success).toBe(true)
    const occurrences = [...harness.sessions.values()].filter(r => r.data.seriesId === seriesId)
    expect(occurrences).toHaveLength(3)
    expect(new Set(occurrences.map(r => r.data.startsAt)).size).toBe(3)
    // Host RSVPs exist for every occurrence.
    expect(harness.rsvps.size).toBe(3)
    // Re-running generation is a no-op, not a duplicate.
    const again = await harness.scheduleCommand('host', { operation: 'generateOccurrences', seriesId })
    expect(again.success).toBe(true)
    expect([...harness.sessions.values()].filter(r => r.data.seriesId === seriesId)).toHaveLength(3)
  })
})
