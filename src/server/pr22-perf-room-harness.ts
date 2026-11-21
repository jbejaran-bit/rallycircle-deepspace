/**
 * Perf harness — command-room side. Extracted verbatim from
 * pr22-waitlist-deep.test.ts (feature/muse-pr22-waitlist-deep), describe
 * blocks removed, exported as createRoomHarness for the package-8
 * benchmarks. In-memory RecordRoom with idempotency dedup on
 * notifications/votes, createdAt-ordered waitlist/rsvp queries, series
 * room routing, 1 ms per fetch.
 */
import { expect } from 'vitest'
import type { ActionTools } from 'deepspace/worker'
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

export function createRoomHarness() {
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
    polls, pollVotes, recurringSeries,
    interruptQueueCleanup: (times = 1) => { failQueueDeletes = times },
    interruptNotifications: (times = 1) => { failNotificationCreates = times },
    failMutation: (index: number) => { mutationsUntilFailure = index },
    restart: () => { room = new RallyCommandRoom(state, actionEnv) },
    alarm: () => room.alarm(),
  }
}

async function fillSession(
  harness: ReturnType<typeof createRoomHarness>,
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
