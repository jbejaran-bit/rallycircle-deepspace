/**
 * Backend package 6 — RSVP/waitlist deep concurrency on PR #22 (e6ff2d9).
 *
 * NEW scenarios only. Already covered elsewhere and NOT repeated here:
 * - Track A: 5-way joins at cap 2, FIFO under concurrent joins, waitlist
 *   priority over a racing joiner, no waitlist while a spot is free.
 * - command-room-simulation: last-spot race, cancel-vs-RSVP race, stale
 *   promotion repair by the next command.
 * - PR #19 race audit: S1/S2/S3 disproven or transient.
 * - DO-resilience audit: stale RSVP/score/cancel retries after eviction.
 *
 * Harness: adapted from rally-scheduling-command.test.ts (notifications
 * collection with idempotency dedup, series room routing, fault injection),
 * plus createdAt-ordered waitlist/rsvp queries (as in
 * rally-command-room.test.ts — FIFO must be proven by createdAt, not
 * insertion order), a notification-create fault injector, and minimal
 * profiles/matchResults/playerStats stores so a profile-visibility flip
 * can run concurrently with promotions (scenario 4).
 *
 * All evidence is local mock-harness simulation: the room queue serializes
 * commands per session, the RecordRoom is in-memory, alarms are stubbed.
 * Live two-account flows and real-DO queue behaviour remain unverified.
 */
import { canRead } from 'deepspace/worker'
import type { ActionTools } from 'deepspace/worker'
import { describe, expect, it } from 'vitest'
import { notificationsSchema, waitlistsSchema } from '../schemas/rally-schema.js'
import type { RallyRSVP, RallySession, RallyWaitlist, RSVPStatus } from '../lib/rally.js'
import type { Env } from '../../worker.js'
import { deleteProfileAction } from './profile-actions.js'
import {
  rallyCommandAction,
  RallyCommandRoom,
  schedulingAction,
  type RallyPoll,
  type RallyPollVote,
  type RecurringSeriesRecord,
} from './rally-command-room.js'
import type { RallyNotification } from '../lib/rally-notifications.js'

type StoredRow<T> = { recordId: string; createdAt: number; data: T }

function createHarness() {
  const sessions = new Map<string, { recordId: string; createdBy: string; data: RallySession }>()
  const rsvps = new Map<string, StoredRow<RallyRSVP> & { createdBy: string }>()
  const waitlists = new Map<string, StoredRow<RallyWaitlist>>()
  const polls = new Map<string, { recordId: string; data: RallyPoll; seq: number }>()
  const pollVotes = new Map<string, { recordId: string; data: RallyPollVote; seq: number }>()
  const notifications = new Map<string, { recordId: string; data: RallyNotification; seq: number }>()
  const notificationPreferences = new Map<string, { recordId: string; data: { userId: string; preferences: string } }>()
  const recurringSeries = new Map<string, { recordId: string; data: RecurringSeriesRecord }>()
  const profiles = new Map<string, { recordId: string; createdBy: string; data: Record<string, unknown> }>()
  const resultRows = new Map(
    ['matchResults', 'playerStats'].map(name =>
      [name, new Map<string, { recordId: string; data: Record<string, unknown> }>()] as const,
    ),
  )
  let nextRecordId = 0
  let nextSeq = 0
  let nextCreatedAt = 0
  let failQueueDeletes = 0
  let failNotificationCreates = 0
  let mutationsUntilFailure = 0

  function applyQueryOrder<T extends { createdAt: number }>(rows: T[], params: Record<string, unknown>): T[] {
    const ordered = [...rows]
    if (params.orderBy === 'createdAt') {
      ordered.sort((a, b) => params.orderDir === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt)
    }
    const offset = Number(params.offset ?? 0)
    const limit = params.limit === undefined ? ordered.length : Number(params.limit)
    return ordered.slice(offset, offset + limit)
  }

  const recordRoom = {
    async fetch(request: Request) {
      const { tool, params } = await request.json() as {
        tool: string
        params: Record<string, unknown>
      }
      await new Promise(resolve => setTimeout(resolve, 1))
      if (tool !== 'records.query' && tool !== 'records.get' && mutationsUntilFailure > 0 && --mutationsUntilFailure === 0) {
        return Response.json({ success: false, error: 'Injected write failure' })
      }

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
        const records = applyQueryOrder(
          Array.from(rsvps.values()).filter(record =>
            Object.entries(where).every(([key, value]) => record.data[key as keyof RallyRSVP] === value),
          ),
          params,
        )
        return Response.json({ success: true, data: { records, count: records.length } })
      }

      if (tool === 'records.query' && params.collection === 'waitlists') {
        const where = params.where as Partial<RallyWaitlist>
        const records = applyQueryOrder(
          [...waitlists.values()].filter(record =>
            Object.entries(where).every(([key, value]) => record.data[key as keyof RallyWaitlist] === value),
          ),
          params,
        )
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

      const resultStore = resultRows.get(String(params.collection))
      if (resultStore && tool === 'records.query') {
        const records = [...resultStore.values()].filter(record =>
          Object.entries(params.where ?? {}).every(([key, value]) => record.data[key] === value),
        ).slice(0, Number(params.limit ?? resultStore.size))
        return Response.json({ success: true, data: { records, count: records.length } })
      }
      if (resultStore && tool === 'records.update') {
        const record = resultStore.get(String(params.recordId))
        if (!record) return Response.json({ success: false, error: 'Record not found' })
        Object.assign(record.data, params.data)
        return Response.json({ success: true, data: { recordId: String(params.recordId) } })
      }
      if (tool === 'records.query' && params.collection === 'profiles') {
        const records = [...profiles.values()].filter(record =>
          Object.entries(params.where ?? {}).every(([key, value]) => record.data[key] === value),
        ).slice(0, Number(params.limit ?? profiles.size))
        return Response.json({ success: true, data: { records, count: records.length } })
      }

      if (tool === 'records.create' && params.collection === 'waitlists') {
        const { sessionId } = params.data as { sessionId: string }
        const userId = request.headers.get('X-User-Id') ?? ''
        const recordId = `waiting-${++nextRecordId}`
        waitlists.set(recordId, { recordId, createdAt: ++nextCreatedAt, data: { sessionId, userId } })
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
        if (failNotificationCreates > 0) {
          failNotificationCreates--
          return Response.json({ success: false, error: 'Injected notification failure' })
        }
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

      if (tool === 'records.delete' && (params.collection === 'rsvps' || params.collection === 'waitlists' || params.collection === 'pollVotes' || params.collection === 'notifications' || params.collection === 'profiles')) {
        if (params.collection === 'waitlists' && failQueueDeletes > 0) {
          failQueueDeletes--
          return Response.json({ success: false, error: 'Temporary delete failure' })
        }
        const collection = params.collection === 'rsvps' ? rsvps
          : params.collection === 'waitlists' ? waitlists
          : params.collection === 'pollVotes' ? pollVotes
          : params.collection === 'profiles' ? profiles
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
        rsvps.set(recordId, { recordId, createdBy: userId, createdAt: ++nextCreatedAt, data: { ...data, userId } })
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
        if (collection === 'profiles') {
          const record = profiles.get(recordId)
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
  } } as unknown as DurableObjectState
  const commandNamespace = {
    idFromName: (name: string) => name,
    get: (id: string) => ({ fetch: (request: Request) => (id.includes(':series:') ? seriesRoom : room).fetch(request) }),
  }
  const actionEnv = { ...env, RALLY_COMMAND_ROOMS: commandNamespace } as unknown as Env
  let room = new RallyCommandRoom(state, actionEnv)
  const seriesRoom = new RallyCommandRoom(state, actionEnv)

  function addSession(
    recordId: string,
    hostId: string,
    options: { capacity?: number; seriesId?: string; status?: RallySession['status']; startsAt?: string } = {},
  ) {
    sessions.set(recordId, {
      recordId,
      createdBy: hostId,
      data: {
        title: 'Test rally',
        court: 'Test court',
        location: 'Pittsburgh',
        startsAt: options.startsAt ?? '2030-01-01T12:00:00.000Z',
        durationMinutes: 90,
        targetPlayers: 4,
        level: 'All levels',
        notes: '',
        hostId,
        chatChannelId: '',
        status: options.status ?? 'open',
        ...(options.capacity !== undefined ? { capacity: options.capacity } : {}),
        ...(options.seriesId !== undefined ? { seriesId: options.seriesId } : {}),
      },
    })
  }

  function seedProfile(userId: string, visibility: 'public' | 'private') {
    const recordId = `profile-${++nextRecordId}`
    profiles.set(recordId, {
      recordId,
      createdBy: userId,
      data: { userId, displayName: userId, visibility, formats: [], preferredArea: '', level: 'Intermediate', bio: '' },
    })
    for (const collection of ['matchResults', 'playerStats'] as const) {
      const rowId = `${collection}-${++nextRecordId}`
      resultRows.get(collection)!.set(rowId, { recordId: rowId, data: { userId, visibility } })
    }
    return recordId
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

  function toolFetch(tool: string, params: Record<string, unknown>, userId: string) {
    return recordRoom.fetch(new Request('https://internal/api/tools/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': userId, 'X-App-Action': 'true' },
      body: JSON.stringify({ tool, params }),
    })).then(response => response.json())
  }

  async function deleteProfile(userId: string) {
    const tools = {
      get: (collection: string, recordId: string) => toolFetch('records.get', { collection, recordId }, userId),
      query: (collection: string, options: Record<string, unknown>) => toolFetch('records.query', { collection, ...options }, userId),
      update: (collection: string, recordId: string, data: Record<string, unknown>) => toolFetch('records.update', { collection, recordId, data }, userId),
      create: (collection: string, data: Record<string, unknown>, recordId?: string) => toolFetch('records.create', { collection, data, recordId }, userId),
      remove: (collection: string, recordId: string) => toolFetch('records.delete', { collection, recordId }, userId),
    } as unknown as ActionTools
    return deleteProfileAction({ userId, params: {}, env: actionEnv, callerJwt: 'test-token', tools })
  }

  const going = (sessionId: string) =>
    [...rsvps.values()].filter(row => row.data.sessionId === sessionId && row.data.status === 'going')
  const queued = (sessionId: string) =>
    [...waitlists.values()]
      .filter(row => row.data.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(row => row.data.userId)
  const promotedNotices = (sessionId?: string) =>
    [...notifications.values()].filter(row =>
      row.data.type === 'waitlist_promoted' && (sessionId === undefined || row.data.sessionId === sessionId))

  return {
    addSession, command, scheduleCommand, deleteProfile, seedProfile,
    going, queued, promotedNotices,
    rsvps, sessions, waitlists, notifications, profiles, resultRows,
    interruptQueueCleanup: (times = 1) => { failQueueDeletes = times },
    interruptNotifications: (times = 1) => { failNotificationCreates = times },
    failMutation: (index: number) => { mutationsUntilFailure = index },
    restart: () => { room = new RallyCommandRoom(state, actionEnv) },
    alarm: () => room.alarm(),
  }
}

async function fillSession(
  harness: ReturnType<typeof createHarness>,
  sessionId: string,
  capacity: number,
  goingUsers: string[],
  waiters: string[],
) {
  for (const user of goingUsers) {
    expect((await harness.command(user, { operation: 'rsvp', sessionId, status: 'going' })).success).toBe(true)
  }
  for (const user of waiters) {
    expect((await harness.command(user, { operation: 'joinWaitlist', sessionId })).success).toBe(true)
  }
  expect(harness.going(sessionId)).toHaveLength(capacity)
  expect(harness.queued(sessionId)).toEqual(waiters)
}

describe('Package 6 — waitlist deep concurrency (PR #22)', () => {
  it('S1: three simultaneous withdrawals promote exactly the first three waiters, once each', async () => {
    const harness = createHarness()
    harness.addSession('big', 'host', { capacity: 5 })
    await fillSession(harness, 'big', 5, ['host', 'g1', 'g2', 'g3', 'g4'], ['w1', 'w2', 'w3', 'w4', 'w5'])

    const withdrawals = await Promise.all([
      harness.command('g2', { operation: 'withdraw', sessionId: 'big' }),
      harness.command('g3', { operation: 'withdraw', sessionId: 'big' }),
      harness.command('g4', { operation: 'withdraw', sessionId: 'big' }),
    ])
    expect(withdrawals.every(result => result.success)).toBe(true)

    // Exactly the first three in FIFO order are confirmed, no one skipped,
    // no one promoted twice, and the remaining queue order is intact.
    expect(harness.going('big').map(row => row.data.userId).sort()).toEqual(['host', 'g1', 'w1', 'w2', 'w3'].sort())
    expect(harness.going('big')).toHaveLength(5)
    expect(harness.queued('big')).toEqual(['w4', 'w5'])
    for (const user of ['w1', 'w2', 'w3']) {
      expect([...harness.rsvps.values()].filter(row => row.data.sessionId === 'big' && row.data.userId === user)).toHaveLength(1)
    }
    for (const user of ['w4', 'w5']) {
      expect([...harness.rsvps.values()].filter(row => row.data.sessionId === 'big' && row.data.userId === user)).toHaveLength(0)
    }
    const notices = harness.promotedNotices('big')
    expect(notices).toHaveLength(3)
    expect(notices.map(row => row.data.recipientId)).toEqual(['w1', 'w2', 'w3'])
    expect(new Set(notices.map(row => row.data.idempotencyKey)).size).toBe(3)
    for (const notice of notices) {
      expect(notice.data.title).toBe(`You're in: Test rally`)
      expect(notice.data.body).toBe(`A place opened up for Test rally. You're confirmed.`)
    }
  })

  it('S2: a promotion whose notification write fails stays durable, and a later cancel still reaches the promoted user', async () => {
    const harness = createHarness()
    harness.addSession('limited', 'host', { capacity: 2 })
    await fillSession(harness, 'limited', 2, ['host', 'guest'], ['w1', 'w2'])

    // Fail the promotion's notification create. The promotion itself must
    // still land: RSVP saved, queue row deleted, withdrawal succeeds.
    harness.interruptNotifications(1)
    expect((await harness.command('guest', { operation: 'withdraw', sessionId: 'limited' })).success).toBe(true)
    expect(harness.going('limited').map(row => row.data.userId).sort()).toEqual(['host', 'w1'].sort())
    expect(harness.queued('limited')).toEqual(['w2'])
    expect(harness.promotedNotices('limited')).toHaveLength(0)
    // The lost notice is accepted-by-design (notifications.ts header: no
    // background retry queue, a lost notification stays lost); the data
    // invariant is that the promotion is durable and the user is 'going'.

    // The host now cancels. The promoted user must learn about it through
    // the cancel notice, and no queue row may remain for them.
    expect((await harness.command('host', { operation: 'cancel', sessionId: 'limited' })).success).toBe(true)
    expect(harness.sessions.get('limited')!.data.status).toBe('cancelled')
    const cancelNotices = [...harness.notifications.values()].filter(row => row.data.type === 'session_cancelled')
    expect(cancelNotices.map(row => row.data.recipientId).sort()).toEqual(['w1'])
    expect(harness.queued('limited')).toEqual(['w2'])
    // The remaining waiter keeps their row (by design, A05) and can clean
    // up; the cancelled session never promotes again.
    expect((await harness.command('w2', { operation: 'leaveWaitlist', sessionId: 'limited' })).success).toBe(true)
    expect(harness.queued('limited')).toEqual([])

    // Cancel itself is best-effort on notifications: even with every
    // notification write failing, the session still cancels.
    const second = createHarness()
    second.addSession('limited', 'host', { capacity: 2 })
    await fillSession(second, 'limited', 2, ['host', 'guest'], ['w1'])
    second.interruptNotifications(10)
    expect((await second.command('host', { operation: 'cancel', sessionId: 'limited' })).success).toBe(true)
    expect(second.sessions.get('limited')!.data.status).toBe('cancelled')
    expect([...second.notifications.values()]).toHaveLength(0)
  })

  it('S3: a racing joiner cannot steal a spot while a promotion is mid-repair', async () => {
    const harness = createHarness()
    harness.addSession('limited', 'host', { capacity: 2 })
    await fillSession(harness, 'limited', 2, ['host', 'guest'], ['w1'])

    // Exhaust the in-command queue-delete retry: the withdrawal saves
    // w1's 'going' RSVP but the stale queue row survives, and the
    // withdrawal still reports success (Track A D1).
    harness.interruptQueueCleanup(2)
    expect((await harness.command('guest', { operation: 'withdraw', sessionId: 'limited' })).success).toBe(true)
    expect(harness.going('limited').map(row => row.data.userId).sort()).toEqual(['host', 'w1'].sort())
    expect(harness.queued('limited')).toEqual(['w1'])
    expect(harness.promotedNotices('limited')).toHaveLength(0)

    // The racing joiner triggers the repair instead of jumping the queue:
    // the stale row is deleted, w1's single promotion notice is emitted,
    // and the joiner is told the session is full.
    const joined = await harness.command('newbie', { operation: 'rsvp', sessionId: 'limited', status: 'going' })
    expect(joined.success).toBe(false)
    expect(joined).toMatchObject({ error: 'This session is full. You can join the waitlist.' })
    expect(harness.queued('limited')).toEqual([])
    expect([...harness.rsvps.values()].filter(row => row.data.sessionId === 'limited' && row.data.userId === 'w1')).toHaveLength(1)
    expect([...harness.rsvps.values()].filter(row => row.data.sessionId === 'limited' && row.data.userId === 'newbie')).toHaveLength(0)
    expect(harness.promotedNotices('limited')).toHaveLength(1)
    expect(harness.promotedNotices('limited')[0].data.recipientId).toBe('w1')

    // No-fault control: the same race without injection converges the
    // same way (the waiter is promoted, the joiner is refused).
    const control = createHarness()
    control.addSession('limited', 'host', { capacity: 2 })
    await fillSession(control, 'limited', 2, ['host', 'guest'], ['w1'])
    const [withdrawn, raced] = await Promise.all([
      control.command('guest', { operation: 'withdraw', sessionId: 'limited' }),
      control.command('newbie', { operation: 'rsvp', sessionId: 'limited', status: 'going' }),
    ])
    expect(withdrawn.success).toBe(true)
    expect(raced.success).toBe(false)
    expect(control.going('limited').map(row => row.data.userId).sort()).toEqual(['host', 'w1'].sort())
    expect(control.queued('limited')).toEqual([])
  })

  it('S4: a profile-visibility flip racing a promotion leaks no identity and corrupts nothing', async () => {
    const harness = createHarness()
    harness.addSession('limited', 'host', { capacity: 2 })
    await fillSession(harness, 'limited', 2, ['host', 'guest'], ['w1', 'w2'])
    // 'guest' has a public profile with public stats/results rows.
    harness.seedProfile('guest', 'public')

    // The flip (deleteProfile -> syncOwnedVisibility to private) and the
    // withdrawal that promotes w1 run concurrently through different
    // paths: the promotion path never reads profiles.
    const [deleted, withdrawn] = await Promise.all([
      harness.deleteProfile('guest'),
      harness.command('guest', { operation: 'withdraw', sessionId: 'limited' }),
    ])
    expect(deleted.success).toBe(true)
    expect(withdrawn.success).toBe(true)

    // The flip took effect on the caller's own rows only.
    expect(harness.profiles.size).toBe(0)
    for (const collection of ['matchResults', 'playerStats'] as const) {
      expect([...harness.resultRows.get(collection)!.values()].map(row => row.data.visibility)).toEqual(['private'])
    }

    // The promotion landed exactly once, and its notice names nobody but
    // the session: no user id appears in any notification payload.
    expect(harness.going('limited').map(row => row.data.userId).sort()).toEqual(['host', 'w1'].sort())
    expect(harness.queued('limited')).toEqual(['w2'])
    expect(harness.promotedNotices('limited')).toHaveLength(1)
    const notice = harness.promotedNotices('limited')[0].data
    expect(notice.recipientId).toBe('w1')
    for (const field of [notice.title, notice.body, notice.link]) {
      expect(field).not.toContain('guest')
      expect(field).not.toContain('w2')
      expect(field).not.toContain('host')
    }
    // Record-layer privacy still holds on the surviving queue row and on
    // the notification itself: only the owner (or an admin) may read them.
    const w2Row = [...harness.waitlists.values()].find(row => row.data.userId === 'w2')!
    const w2Record = { data: { sessionId: w2Row.data.sessionId, userId: w2Row.data.userId }, createdBy: 'w2', recordId: w2Row.recordId }
    expect(canRead(waitlistsSchema, 'member', w2Record, 'w2')).toBe(true)
    expect(canRead(waitlistsSchema, 'member', w2Record, 'w1')).toBe(false)
    expect(canRead(waitlistsSchema, 'anonymous', w2Record, 'w2')).toBe(false)
    const noticeRow = [...harness.notifications.values()][0]
    const noticeRecord = {
      data: {
        recipientId: noticeRow.data.recipientId,
        type: noticeRow.data.type,
        sessionId: noticeRow.data.sessionId,
        title: noticeRow.data.title,
        body: noticeRow.data.body,
        link: noticeRow.data.link,
        idempotencyKey: noticeRow.data.idempotencyKey,
        readAt: noticeRow.data.readAt,
      },
      createdBy: 'w1',
      recordId: noticeRow.recordId,
    }
    expect(canRead(notificationsSchema, 'member', noticeRecord, 'w1')).toBe(true)
    expect(canRead(notificationsSchema, 'member', noticeRecord, 'w2')).toBe(false)
    // There is no waitlist-position endpoint on this base (Track K+L L10
    // was never merged into PR #22): the only waitlist read surfaces are
    // the owner-only record layer above and the caller's own notifications.
  })

  it('S5: a waitlisted user who re-joins instead of waiting ends with exactly one going row', async () => {
    // (a) Sequential: promotion first, then the fresh join updates the
    // same RSVP record instead of creating a second one.
    const harness = createHarness()
    harness.addSession('limited', 'host', { capacity: 2 })
    await fillSession(harness, 'limited', 2, ['host', 'guest'], ['w1'])
    expect((await harness.command('guest', { operation: 'withdraw', sessionId: 'limited' })).success).toBe(true)
    expect(harness.going('limited').map(row => row.data.userId).sort()).toEqual(['host', 'w1'].sort())
    const promotedId = [...harness.rsvps.values()].find(row => row.data.userId === 'w1')!.recordId
    expect((await harness.command('w1', { operation: 'rsvp', sessionId: 'limited', status: 'going' })).success).toBe(true)
    const w1Rows = [...harness.rsvps.values()].filter(row => row.data.sessionId === 'limited' && row.data.userId === 'w1')
    expect(w1Rows).toHaveLength(1)
    expect(w1Rows[0].recordId).toBe(promotedId)
    expect(w1Rows[0].data.status).toBe('going')
    expect(harness.queued('limited')).toEqual([])
    expect(harness.promotedNotices('limited')).toHaveLength(1)

    // (b) Concurrent: the join and the withdrawal race; either order
    // converges to one going row and one promotion notice.
    const racing = createHarness()
    racing.addSession('limited', 'host', { capacity: 2 })
    await fillSession(racing, 'limited', 2, ['host', 'guest'], ['w1'])
    const [withdrawn, joined] = await Promise.all([
      racing.command('guest', { operation: 'withdraw', sessionId: 'limited' }),
      racing.command('w1', { operation: 'rsvp', sessionId: 'limited', status: 'going' }),
    ])
    expect(withdrawn.success).toBe(true)
    // If the join ran first it was honestly refused (session full); if it
    // ran second it updated the promoted row. Either way the end state
    // is identical.
    expect(racing.going('limited').map(row => row.data.userId).sort()).toEqual(['host', 'w1'].sort())
    expect([...racing.rsvps.values()].filter(row => row.data.sessionId === 'limited' && row.data.userId === 'w1')).toHaveLength(1)
    expect(racing.queued('limited')).toEqual([])
    expect(racing.promotedNotices('limited')).toHaveLength(1)

    // (c) A 'maybe' RSVP plus a waitlist row promotes in place: the same
    // record flips to 'going', no second row is created.
    const tentative = createHarness()
    tentative.addSession('limited', 'host', { capacity: 2 })
    for (const user of ['host', 'guest']) {
      expect((await tentative.command(user, { operation: 'rsvp', sessionId: 'limited', status: 'going' })).success).toBe(true)
    }
    expect((await tentative.command('w1', { operation: 'rsvp', sessionId: 'limited', status: 'maybe' })).success).toBe(true)
    expect((await tentative.command('w1', { operation: 'joinWaitlist', sessionId: 'limited' })).success).toBe(true)
    const maybeId = [...tentative.rsvps.values()].find(row => row.data.userId === 'w1')!.recordId
    expect((await tentative.command('guest', { operation: 'withdraw', sessionId: 'limited' })).success).toBe(true)
    const rows = [...tentative.rsvps.values()].filter(row => row.data.sessionId === 'limited' && row.data.userId === 'w1')
    expect(rows).toHaveLength(1)
    expect(rows[0].recordId).toBe(maybeId)
    expect(rows[0].data.status).toBe('going')
    expect(tentative.queued('limited')).toEqual([])
  })

  it('S6: cancelling one series occurrence leaves the other occurrences waitlists and promotion order untouched', async () => {
    const harness = createHarness()
    const template = {
      format: 'Doubles' as const,
      title: 'Weekly doubles',
      court: 'Schenley Park',
      location: 'Pittsburgh, PA',
      durationMinutes: 90,
      targetPlayers: 2,
      capacity: 2,
      level: 'Intermediate' as const,
      notes: '',
    }
    const created = await harness.scheduleCommand('host', {
      operation: 'createSeries', template, startStartsAt: '2030-01-05T18:00:00.000Z', intervalWeeks: 1, count: 3,
    })
    expect(created.success).toBe(true)
    const seriesId = (created.data as { recordId: string }).recordId
    await expect(harness.scheduleCommand('host', { operation: 'generateOccurrences', seriesId }))
      .resolves.toMatchObject({ success: true })
    const instances = [...harness.sessions.values()]
      .filter(row => row.data.seriesId === seriesId)
      .sort((a, b) => a.data.startsAt.localeCompare(b.data.startsAt))
    expect(instances).toHaveLength(3)
    const [first, second, third] = instances.map(row => row.recordId)

    // Fill the first two occurrences (host going + one guest each) and
    // queue two waiters on each.
    for (const sessionId of [first, second]) {
      expect((await harness.command('guest', { operation: 'rsvp', sessionId, status: 'going' })).success).toBe(true)
    }
    for (const user of ['w1', 'w2']) {
      expect((await harness.command(user, { operation: 'joinWaitlist', sessionId: first })).success).toBe(true)
    }
    for (const user of ['w3', 'w4']) {
      expect((await harness.command(user, { operation: 'joinWaitlist', sessionId: second })).success).toBe(true)
    }
    expect(harness.queued(first)).toEqual(['w1', 'w2'])
    expect(harness.queued(second)).toEqual(['w3', 'w4'])

    // Cancel only the first occurrence.
    expect((await harness.command('host', { operation: 'cancel', sessionId: first })).success).toBe(true)
    expect(harness.sessions.get(first)!.data.status).toBe('cancelled')
    expect(harness.sessions.get(second)!.data.status).toBe('open')
    expect(harness.sessions.get(third)!.data.status).toBe('open')
    // The cancelled occurrence's queue rows stay inert (by design, A05)
    // and the other occurrence is byte-for-byte untouched.
    expect(harness.queued(first)).toEqual(['w1', 'w2'])
    expect(harness.queued(second)).toEqual(['w3', 'w4'])
    expect(harness.queued(third)).toEqual([])
    // A waitlist join on the cancelled occurrence is refused.
    expect((await harness.command('w5', { operation: 'joinWaitlist', sessionId: first })).success).toBe(false)

    // A withdrawal on the second occurrence promotes in FIFO order and
    // touches nothing on the first.
    expect((await harness.command('guest', { operation: 'withdraw', sessionId: second })).success).toBe(true)
    expect(harness.going(second).map(row => row.data.userId).sort()).toEqual(['host', 'w3'].sort())
    expect(harness.queued(second)).toEqual(['w4'])
    expect(harness.queued(first)).toEqual(['w1', 'w2'])
    expect(harness.promotedNotices(second)).toHaveLength(1)
    expect(harness.promotedNotices(second)[0].data.recipientId).toBe('w3')
    expect(harness.promotedNotices(first)).toHaveLength(0)

    // Cancelling the whole series cancels the remaining future instances
    // but never promotes from them: their queues stay frozen and their
    // waiters can still leave.
    await expect(harness.scheduleCommand('host', { operation: 'cancelSeries', seriesId }))
      .resolves.toMatchObject({ success: true })
    expect(harness.sessions.get(second)!.data.status).toBe('cancelled')
    expect(harness.sessions.get(third)!.data.status).toBe('cancelled')
    expect(harness.queued(second)).toEqual(['w4'])
    expect((await harness.command('guest', { operation: 'withdraw', sessionId: second })).success).toBe(true)
    expect(harness.queued(second)).toEqual(['w4'])
    expect(harness.promotedNotices(second)).toHaveLength(1)
    expect((await harness.command('w4', { operation: 'leaveWaitlist', sessionId: second })).success).toBe(true)
    expect(harness.queued(second)).toEqual([])
  })
})
