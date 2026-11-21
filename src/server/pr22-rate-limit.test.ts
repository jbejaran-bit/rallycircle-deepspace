import type { ActionTools } from 'deepspace/worker'
import { describe, expect, it } from 'vitest'
import type { RallyRSVP, RallySession, RallyWaitlist, RSVPStatus } from '../lib/rally.js'
import type { Env } from '../../worker.js'
import {
  rallyCommandAction,
  RallyCommandRoom,
  schedulingAction,
  type RallyPoll,
  type RallyPollVote,
  type RecurringSeriesRecord,
} from './rally-command-room.js'
import type { RallyNotification } from '../lib/rally-notifications.js'

/**
 * K03/K05 reproduction harness, adapted from rally-scheduling-command.test.ts
 * (polls / pollVotes / recurringSeries / notifications stores) with three
 * additions the base harnesses lack: an injectable clock (K03 window reset),
 * a record-room fault injector (K05 queue continuation), and a storage
 * transaction stub that can throw (K05 geocode fault). Two room instances
 * mirror production routing: session commands go to `room`, series commands
 * to `seriesRoom`.
 */
function createHarness(clock: () => number = Date.now) {
  const sessions = new Map<string, { recordId: string; createdBy: string; data: RallySession }>()
  const rsvps = new Map<string, { recordId: string; createdBy: string; data: RallyRSVP }>()
  const waitlists = new Map<string, { recordId: string; data: RallyWaitlist }>()
  const polls = new Map<string, { recordId: string; data: RallyPoll; seq: number }>()
  const pollVotes = new Map<string, { recordId: string; data: RallyPollVote; seq: number }>()
  const notifications = new Map<string, { recordId: string; data: RallyNotification; seq: number }>()
  const notificationPreferences = new Map<string, { recordId: string; data: { userId: string; preferences: string } }>()
  const recurringSeries = new Map<string, { recordId: string; data: RecurringSeriesRecord }>()
  let nextRecordId = 0
  let nextSeq = 0
  let failQueueDeletes = 0
  let recordFetchThrows = false
  let failStorageTransaction = false

  const recordRoom = {
    async fetch(request: Request) {
      // K05 fault injection: the record room itself is unreachable.
      if (recordFetchThrows) throw new Error('Record room unavailable')
      const { tool, params } = await request.json() as {
        tool: string
        params: Record<string, unknown>
      }
      await new Promise(resolve => setTimeout(resolve, 1))

      if (tool === 'records.get' && params.collection === 'sessions') {
        const record = sessions.get(String(params.recordId))
        return record
          ? Response.json({ success: true, data: { record } })
          : Response.json({ success: false, error: 'Record not found' })
      }

      if (tool === 'records.get' && (params.collection === 'polls' || params.collection === 'recurringSeries' || params.collection === 'notifications' || params.collection === 'notificationPreferences')) {
        const store = params.collection === 'polls' ? polls
          : params.collection === 'recurringSeries' ? recurringSeries
          : params.collection === 'notifications' ? notifications
          : notificationPreferences
        const record = store.get(String(params.recordId))
        return record
          ? Response.json({ success: true, data: { record } })
          : Response.json({ success: false, error: 'Record not found' })
      }

      if (tool === 'records.query' && params.collection === 'rsvps') {
        const where = params.where as Partial<RallyRSVP>
        const records = Array.from(rsvps.values()).filter(record =>
          Object.entries(where).every(([key, value]) => record.data[key as keyof RallyRSVP] === value),
        )
        const offset = Number(params.offset ?? 0)
        const limit = Number(params.limit ?? 100)
        const page = records.slice(offset, offset + limit)
        return Response.json({ success: true, data: { records: page, count: page.length,
          nextOffset: records.length > offset + limit ? offset + limit : undefined } })
      }

      if (tool === 'records.query' && params.collection === 'waitlists') {
        const where = params.where as Partial<RallyWaitlist>
        const records = [...waitlists.values()].filter(record =>
          Object.entries(where).every(([key, value]) => record.data[key as keyof RallyWaitlist] === value),
        ).slice(0, Number(params.limit))
        return Response.json({ success: true, data: { records, count: records.length } })
      }

      if (tool === 'records.query' && params.collection === 'polls') {
        const where = params.where as Partial<RallyPoll>
        const records = [...polls.values()].filter(record =>
          Object.entries(where).every(([key, value]) => record.data[key as keyof RallyPoll] === value),
        ).slice(0, Number(params.limit ?? polls.size))
        return Response.json({ success: true, data: { records, count: records.length } })
      }

      if (tool === 'records.query' && params.collection === 'pollVotes') {
        const where = params.where as Partial<RallyPollVote>
        const records = [...pollVotes.values()].filter(record =>
          Object.entries(where).every(([key, value]) => record.data[key as keyof RallyPollVote] === value),
        ).slice(0, Number(params.limit ?? pollVotes.size))
        return Response.json({ success: true, data: { records, count: records.length } })
      }

      if (tool === 'records.query' && params.collection === 'notifications') {
        const where = params.where as Partial<RallyNotification>
        let records = [...notifications.values()].filter(record =>
          Object.entries(where).every(([key, value]) => record.data[key as keyof RallyNotification] === value),
        )
        if (params.orderBy === 'createdAt') {
          records = [...records].sort((a, b) => a.seq - b.seq)
          if (params.orderDir === 'desc') records.reverse()
        }
        records = records.slice(0, Number(params.limit ?? records.length))
        return Response.json({ success: true, data: { records, count: records.length } })
      }

      if (tool === 'records.query' && params.collection === 'notificationPreferences') {
        const where = params.where as { userId?: string }
        const records = [...notificationPreferences.values()].filter(record =>
          Object.entries(where).every(([key, value]) => record.data.userId === value),
        ).slice(0, Number(params.limit ?? notificationPreferences.size))
        return Response.json({ success: true, data: { records, count: records.length } })
      }

      if (tool === 'records.query' && params.collection === 'recurringSeries') {
        const where = params.where as Partial<RecurringSeriesRecord>
        const records = [...recurringSeries.values()].filter(record =>
          Object.entries(where).every(([key, value]) => record.data[key as keyof RecurringSeriesRecord] === value),
        ).slice(0, Number(params.limit ?? recurringSeries.size))
        return Response.json({ success: true, data: { records, count: records.length } })
      }

      if (tool === 'records.query' && params.collection === 'sessions') {
        const where = params.where as Partial<RallySession>
        const records = [...sessions.values()].filter(record =>
          Object.entries(where).every(([key, value]) => record.data[key as keyof RallySession] === value),
        ).slice(0, Number(params.limit ?? sessions.size))
        return Response.json({ success: true, data: { records, count: records.length } })
      }

      if (tool === 'records.create' && params.collection === 'waitlists') {
        const { sessionId } = params.data as { sessionId: string }
        const userId = request.headers.get('X-User-Id') ?? ''
        const recordId = `waiting-${++nextRecordId}`
        waitlists.set(recordId, { recordId, data: { sessionId, userId } })
        return Response.json({ success: true, data: { recordId } })
      }

      if (tool === 'records.create' && params.collection === 'polls') {
        const data = params.data as Omit<RallyPoll, 'hostId'>
        const userId = request.headers.get('X-User-Id') ?? ''
        if ([...polls.values()].some(record => record.data.sessionId === data.sessionId)) {
          return Response.json({ success: false, error: 'Duplicate: a poll already exists for this session' })
        }
        const recordId = `poll-${++nextRecordId}`
        polls.set(recordId, { recordId, data: { ...data, hostId: userId }, seq: ++nextSeq })
        return Response.json({ success: true, data: { recordId } })
      }

      if (tool === 'records.create' && params.collection === 'pollVotes') {
        const data = params.data as Omit<RallyPollVote, 'userId'>
        const userId = request.headers.get('X-User-Id') ?? ''
        if ([...pollVotes.values()].some(record =>
          record.data.pollId === data.pollId && record.data.optionId === data.optionId && record.data.userId === userId)) {
          return Response.json({ success: false, error: 'Duplicate: vote already exists' })
        }
        const recordId = `vote-${++nextRecordId}`
        pollVotes.set(recordId, { recordId, data: { ...data, userId }, seq: ++nextSeq })
        return Response.json({ success: true, data: { recordId } })
      }

      if (tool === 'records.create' && params.collection === 'notifications') {
        const data = params.data as Omit<RallyNotification, 'recipientId'>
        const recipientId = request.headers.get('X-User-Id') ?? ''
        if ([...notifications.values()].some(record =>
          record.data.recipientId === recipientId && record.data.idempotencyKey === data.idempotencyKey)) {
          return Response.json({ success: false, error: 'Duplicate: notification already exists' })
        }
        const recordId = `notification-${++nextRecordId}`
        notifications.set(recordId, { recordId, data: { ...data, recipientId }, seq: ++nextSeq })
        return Response.json({ success: true, data: { recordId } })
      }

      if (tool === 'records.create' && params.collection === 'notificationPreferences') {
        const data = params.data as { preferences: string }
        const userId = request.headers.get('X-User-Id') ?? ''
        if ([...notificationPreferences.values()].some(record => record.data.userId === userId)) {
          return Response.json({ success: false, error: 'Duplicate: preferences already exist' })
        }
        const recordId = `prefs-${++nextRecordId}`
        notificationPreferences.set(recordId, { recordId, data: { ...data, userId } })
        return Response.json({ success: true, data: { recordId } })
      }

      if (tool === 'records.create' && params.collection === 'recurringSeries') {
        const data = params.data as Omit<RecurringSeriesRecord, 'hostId'>
        const userId = request.headers.get('X-User-Id') ?? ''
        const recordId = typeof params.recordId === 'string' && params.recordId
          ? params.recordId
          : `series-${++nextRecordId}`
        recurringSeries.set(recordId, { recordId, data: { ...data, hostId: userId } })
        return Response.json({ success: true, data: { recordId } })
      }

      if (tool === 'records.create' && params.collection === 'sessions') {
        const data = params.data as Omit<RallySession, 'hostId'>
        const userId = request.headers.get('X-User-Id') ?? ''
        const recordId = typeof params.recordId === 'string' ? params.recordId : `session-${++nextRecordId}`
        sessions.set(recordId, {
          recordId,
          createdBy: userId,
          data: { ...data, hostId: userId } as RallySession,
        })
        return Response.json({ success: true, data: { recordId } })
      }

      if (tool === 'records.delete' && (params.collection === 'rsvps' || params.collection === 'waitlists' || params.collection === 'pollVotes' || params.collection === 'notifications')) {
        if (params.collection === 'waitlists' && failQueueDeletes > 0) {
          failQueueDeletes--
          return Response.json({ success: false, error: 'Temporary delete failure' })
        }
        const collection = params.collection === 'rsvps' ? rsvps
          : params.collection === 'waitlists' ? waitlists
          : params.collection === 'pollVotes' ? pollVotes
          : notifications
        const recordId = String(params.recordId)
        return Response.json(collection.delete(recordId)
          ? { success: true, data: { recordId } }
          : { success: false, error: 'Not found' })
      }

      if (tool === 'records.create' && params.collection === 'rsvps') {
        const data = params.data as Omit<RallyRSVP, 'userId'>
        const userId = request.headers.get('X-User-Id') ?? ''
        const duplicate = Array.from(rsvps.values()).some(record =>
          record.data.sessionId === data.sessionId && record.data.userId === userId,
        )
        if (duplicate) return Response.json({ success: false, error: 'Duplicate RSVP' })
        const recordId = `rsvp-${++nextRecordId}`
        rsvps.set(recordId, { recordId, createdBy: userId, data: { ...data, userId } })
        return Response.json({ success: true, data: { recordId } })
      }

      if (tool === 'records.update') {
        const collection = params.collection
        const recordId = String(params.recordId)
        const patch = params.data as Record<string, unknown>
        if (collection === 'sessions') {
          const record = sessions.get(recordId)
          if (!record) return Response.json({ success: false, error: 'Record not found' })
          Object.assign(record.data, patch)
          return Response.json({ success: true, data: { recordId } })
        }
        if (collection === 'rsvps') {
          const record = rsvps.get(recordId)
          if (!record) return Response.json({ success: false, error: 'Record not found' })
          Object.assign(record.data, patch)
          return Response.json({ success: true, data: { recordId } })
        }
        if (collection === 'polls') {
          const record = polls.get(recordId)
          if (!record) return Response.json({ success: false, error: 'Record not found' })
          Object.assign(record.data, patch)
          return Response.json({ success: true, data: { recordId } })
        }
        if (collection === 'notifications') {
          const record = notifications.get(recordId)
          if (!record) return Response.json({ success: false, error: 'Record not found' })
          Object.assign(record.data, patch)
          return Response.json({ success: true, data: { recordId } })
        }
        if (collection === 'notificationPreferences') {
          const record = notificationPreferences.get(recordId)
          if (!record) return Response.json({ success: false, error: 'Record not found' })
          Object.assign(record.data, patch)
          return Response.json({ success: true, data: { recordId } })
        }
        if (collection === 'recurringSeries') {
          const record = recurringSeries.get(recordId)
          if (!record) return Response.json({ success: false, error: 'Record not found' })
          Object.assign(record.data, patch)
          return Response.json({ success: true, data: { recordId } })
        }
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
  const store = new Map<string, unknown>()
  const state = { storage: {
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
    put: async (key: string, value: unknown) => { store.set(key, value) },
    get: async (key: string) => store.get(key),
    delete: async (key: string) => store.delete(key),
    transaction: async (fn: (storage: { get: (key: string) => Promise<unknown>; put: (key: string, value: unknown) => Promise<void> }) => Promise<unknown>) => {
      if (failStorageTransaction) throw new Error('Storage unavailable')
      return fn({
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => { store.set(key, value) },
      })
    },
  } } as unknown as DurableObjectState
  const commandNamespace = {
    idFromName: (name: string) => name,
    get: (id: string) => ({ fetch: (request: Request) => (id.includes(':series:') ? seriesRoom : room).fetch(request) }),
  }
  const actionEnv = { ...env, RALLY_COMMAND_ROOMS: commandNamespace } as unknown as Env
  let room = new RallyCommandRoom(state, actionEnv, clock)
  const seriesRoom = new RallyCommandRoom(state, actionEnv, clock)

  function addSession(recordId: string, hostId: string, status: RallySession['status'] = 'open') {
    sessions.set(recordId, {
      recordId,
      createdBy: hostId,
      data: {
        title: 'Test rally',
        court: 'Test court',
        location: 'Pittsburgh',
        startsAt: '2030-01-01T12:00:00.000Z',
        durationMinutes: 90,
        targetPlayers: 4,
        level: 'All levels',
        notes: '',
        hostId,
        chatChannelId: '',
        status,
      },
    })
  }

  function addPoll(recordId: string, sessionId: string) {
    polls.set(recordId, {
      recordId,
      data: {
        sessionId,
        options: JSON.stringify([
          { id: 'sat', startsAt: '2030-01-05T18:00:00.000Z' },
          { id: 'sun', startsAt: '2030-01-06T18:00:00.000Z' },
        ]),
        status: 'open',
        hostId: 'host',
        baseStartsAt: '2030-01-01T12:00:00.000Z',
        finalizedOptionId: '',
        tally: '{}',
      },
      seq: ++nextSeq,
    })
  }

  async function command(userId: string, params: Record<string, unknown>) {
    return rallyCommandAction({
      userId,
      params,
      env: actionEnv,
      callerJwt: 'test-token',
      tools: {
        get: async (_collection: string, recordId: string) => {
          const record = sessions.get(recordId)
          return record
            ? {
              success: true as const,
              data: { record: { ...record, createdAt: '', updatedAt: '' } },
            }
            : { success: false as const, error: 'Record not found' }
        },
      } as ActionTools,
    })
  }

  async function scheduleCommand(userId: string, params: Record<string, unknown>) {
    return schedulingAction({
      userId,
      params,
      env: actionEnv,
      callerJwt: 'test-token',
      tools: {} as ActionTools,
    })
  }

  async function rawFetch(body: string | Record<string, unknown>) {
    return room.fetch(new Request('https://internal/rally-command', {
      method: 'POST',
      // The combined branch's K01 marker check runs before parsing: these
      // in-app test fetches stamp the marker, exactly like the real actions.
      headers: { 'Content-Type': 'application/json', 'X-App-Action': 'true' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }))
  }

  async function geocodeFetch(query: string) {
    return room.fetch(new Request('https://internal/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-App-Action': 'true' },
      body: query,
    }))
  }

  return {
    addSession, addPoll, command, scheduleCommand, rawFetch, geocodeFetch,
    rsvps, sessions, waitlists, polls, pollVotes, recurringSeries,
    setRecordFetchThrows: (value: boolean) => { recordFetchThrows = value },
    setFailStorageTransaction: (value: boolean) => { failStorageTransaction = value },
    restart: () => { room = new RallyCommandRoom(state, actionEnv, clock) },
  }
}

const RATE_LIMIT_ERROR = 'Too many requests. Try again shortly.'

describe('PR #22 rate limiting and bounded-body parsing (K03/K05)', () => {
  it('throttles RSVP flapping at 30/minute per user and session, independently (K03)', async () => {
    let now = Date.now()
    const harness = createHarness(() => now)
    harness.addSession('open-session', 'host')
    const rsvp = (user: string) => harness.command(user, {
      operation: 'rsvp',
      sessionId: 'open-session',
      status: 'going',
    })

    for (let attempt = 0; attempt < 30; attempt++) {
      await expect(rsvp('flapper')).resolves.toMatchObject({ success: true })
    }
    await expect(rsvp('flapper')).resolves.toMatchObject({
      success: false,
      error: RATE_LIMIT_ERROR,
    })
    // Another user on the same session is unaffected.
    await expect(rsvp('calm')).resolves.toMatchObject({ success: true })
    // The window resets after 60 s.
    now += 61_000
    await expect(rsvp('flapper')).resolves.toMatchObject({ success: true })
  })

  it('throttles cancels at 5/minute and scores at 120/minute (K03)', async () => {
    const harness = createHarness()
    harness.addSession('open-session', 'host')
    const cancel = () => harness.command('host', { operation: 'cancel', sessionId: 'open-session' })
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(cancel()).resolves.toMatchObject({ success: true })
    }
    await expect(cancel()).resolves.toMatchObject({
      success: false,
      error: RATE_LIMIT_ERROR,
    })

    // Score commands share one budget, counted before the score is applied,
    // so a bogus revision still consumes budget — 120 fail on the missing
    // scoreboard, the 121st is throttled.
    const point = () => harness.command('host', {
      operation: 'scorePoint',
      sessionId: 'open-session',
      side: 0,
      revision: 0,
    })
    for (let attempt = 0; attempt < 120; attempt++) {
      const result = await point()
      expect(result.success).toBe(false)
      expect((result as { error?: string }).error).not.toBe(RATE_LIMIT_ERROR)
    }
    await expect(point()).resolves.toMatchObject({
      success: false,
      error: RATE_LIMIT_ERROR,
    })
  })

  it('rate-limits series commands per user and series id (K03)', async () => {
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
      operation: 'createSeries', seriesId: 's1', template,
      startStartsAt: '2030-01-05T18:00:00.000Z', intervalWeeks: 1, count: 2,
    })
    expect(created.success).toBe(true)
    const generate = () => harness.scheduleCommand('host', { operation: 'generateOccurrences', seriesId: 's1' })
    // createSeries used 1 of the 30-command budget for (host, s1); 29 more
    // generateOccurrences fill it. The 30th generate is throttled.
    for (let attempt = 0; attempt < 29; attempt++) {
      await expect(generate()).resolves.toMatchObject({ success: true })
    }
    await expect(generate()).resolves.toMatchObject({
      success: false,
      error: RATE_LIMIT_ERROR,
    })
    // A different series id has an independent budget: the command reaches
    // the handler (and fails there for a missing series), it is not throttled.
    const other = await harness.scheduleCommand('host', { operation: 'generateOccurrences', seriesId: 's2' })
    expect(other.success).toBe(false)
    expect((other as { error?: string }).error).not.toBe(RATE_LIMIT_ERROR)
  })

  it('resets rate-limit counters when the DO instance is evicted (K03)', async () => {
    const harness = createHarness()
    harness.addSession('open-session', 'host')
    const rsvp = () => harness.command('flapper', {
      operation: 'rsvp',
      sessionId: 'open-session',
      status: 'going',
    })
    for (let attempt = 0; attempt < 30; attempt++) {
      await expect(rsvp()).resolves.toMatchObject({ success: true })
    }
    await expect(rsvp()).resolves.toMatchObject({ success: false, error: RATE_LIMIT_ERROR })
    // A fresh room instance (same durable storage) starts with empty
    // counters: abuse mitigation only, not authentication.
    harness.restart()
    await expect(rsvp()).resolves.toMatchObject({ success: true })
  })

  it('rejects malformed and oversized command bodies with a generic error (K05)', async () => {
    const harness = createHarness()
    harness.addSession('open-session', 'host')

    const malformed = await harness.rawFetch('{not json')
    expect(malformed.status).toBe(400)
    await expect(malformed.json()).resolves.toMatchObject({
      success: false,
      error: 'Invalid rally command request.',
    })

    // A valid command padded past the 64 KB cap must be rejected before
    // parsing/execution: no RSVP is created.
    const oversized = await harness.rawFetch({
      operation: 'rsvp', sessionId: 'open-session', status: 'going', userId: 'player',
      pad: 'x'.repeat(70_000),
    })
    expect(oversized.status).toBe(400)
    await expect(oversized.json()).resolves.toMatchObject({
      success: false,
      error: 'Invalid rally command request.',
    })
    expect(harness.rsvps.size).toBe(0)
  })

  it('accepts a legitimate large-but-under-cap body (K05)', async () => {
    const harness = createHarness()
    harness.addSession('open-session', 'host')
    const response = await harness.rawFetch({
      operation: 'rsvp', sessionId: 'open-session', status: 'going', userId: 'player',
      pad: 'x'.repeat(60_000),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ success: true })
    expect(harness.rsvps.size).toBe(1)
  })

  it('returns a generic failure and keeps the queue moving when the record room throws (K05)', async () => {
    const harness = createHarness()
    harness.addSession('open-session', 'host')

    harness.setRecordFetchThrows(true)
    const failed = await harness.rawFetch({
      operation: 'rsvp', sessionId: 'open-session', status: 'going', userId: 'player',
    })
    await expect(failed.json()).resolves.toMatchObject({
      success: false,
      error: 'The session service is temporarily unavailable. Try again.',
    })
    // The queue did not deadlock: the next command after recovery succeeds.
    harness.setRecordFetchThrows(false)
    await expect(harness.command('player', {
      operation: 'rsvp',
      sessionId: 'open-session',
      status: 'going',
    })).resolves.toMatchObject({ success: true })
    expect(harness.rsvps.size).toBe(1)
  })

  it('answers a storage throw in geocoding with 502, never a bare rejection (K05)', async () => {
    const harness = createHarness()
    harness.setFailStorageTransaction(true)
    const response = await harness.geocodeFetch('Schenley Park')
    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Place search is unavailable.',
    })
  })

  it('lets legitimate commands through at normal rates (K03/K05)', async () => {
    const harness = createHarness()
    harness.addSession('singles', 'host')
    const session = harness.sessions.get('singles')!.data
    session.format = 'Singles'

    await expect(harness.command('player', {
      operation: 'rsvp', sessionId: 'singles', status: 'going',
    })).resolves.toMatchObject({ success: true })
    await expect(harness.command('host', {
      operation: 'rsvp', sessionId: 'singles', status: 'going',
    })).resolves.toMatchObject({ success: true })
    await expect(harness.command('host', {
      operation: 'startMatch', sessionId: 'singles', teams: [['host'], ['player']],
    })).resolves.toMatchObject({ success: true })
    await expect(harness.command('host', {
      operation: 'scorePoint', sessionId: 'singles', side: 0, revision: 0,
    })).resolves.toMatchObject({ success: true })

    // A poll vote at a normal rate succeeds.
    harness.addSession('poll-session', 'host')
    harness.addPoll('poll-1', 'poll-session')
    await expect(harness.command('alice', {
      operation: 'rsvp', sessionId: 'poll-session', status: 'going',
    })).resolves.toMatchObject({ success: true })
    await expect(harness.command('alice', {
      operation: 'castVote', sessionId: 'poll-session', pollId: 'poll-1', optionId: 'sat',
    })).resolves.toMatchObject({ success: true })

    // A host cancel at a normal rate succeeds.
    harness.addSession('to-cancel', 'host')
    await expect(harness.command('host', {
      operation: 'cancel', sessionId: 'to-cancel',
    })).resolves.toMatchObject({ success: true })
  })
})
