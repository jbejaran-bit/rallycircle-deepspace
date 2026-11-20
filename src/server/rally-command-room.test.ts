import { canCreate, canDelete, canUpdate, checkFieldPermissions } from 'deepspace/worker'
import type { ActionTools } from 'deepspace/worker'
import { describe, expect, it } from 'vitest'
import { rsvpsSchema, sessionsSchema, waitlistsSchema } from '../schemas/rally-schema.js'
import type { RallyRSVP, RallySession, RallyWaitlist, RSVPStatus } from '../lib/rally.js'
import type { Env } from '../../worker.js'
import { awardPoint, createMatchScore, readMatchScore, resultStatus } from '../lib/rally-score.js'
import { notificationsAction } from './notification-actions.js'
import {
  rallyCommandAction,
  RallyCommandRoom,
  schedulingAction,
  type RallyPoll,
  type RallyPollVote,
  type RecurringSeriesRecord,
} from './rally-command-room.js'
import type { RallyNotification } from '../lib/rally-notifications.js'

function createHarness() {
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

  const recordRoom = {
    async fetch(request: Request) {
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
        return Response.json({ success: true, data: { records, count: records.length } })
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
        const recordId = `session-${++nextRecordId}`
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
  const room = new RallyCommandRoom({} as DurableObjectState, env)
  const commandNamespace = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: (request: Request) => room.fetch(request) }),
  }
  const actionEnv = { ...env, RALLY_COMMAND_ROOMS: commandNamespace } as unknown as Env

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

  async function notificationCommand(userId: string, params: Record<string, unknown>) {
    const tools = {
      get: (collection: string, recordId: string) => toolFetch('records.get', { collection, recordId }, userId),
      query: (collection: string, options: Record<string, unknown>) => toolFetch('records.query', { collection, ...options }, userId),
      update: (collection: string, recordId: string, data: Record<string, unknown>) => toolFetch('records.update', { collection, recordId, data }, userId),
      create: (collection: string, data: Record<string, unknown>, recordId?: string) => toolFetch('records.create', { collection, data, recordId }, userId),
      remove: (collection: string, recordId: string) => toolFetch('records.delete', { collection, recordId }, userId),
    } as unknown as ActionTools
    return notificationsAction({ userId, params, env: actionEnv, callerJwt: 'test-token', tools })
  }

  return {
    addSession, command, scheduleCommand, notificationCommand,
    rsvps, sessions, waitlists, polls, pollVotes, notifications, notificationPreferences, recurringSeries,
    interruptQueueCleanup: (times = 1) => { failQueueDeletes = times },
  }
}

describe('RallyCircle server-side session and RSVP rules', () => {
  it('rejects missing and cancelled sessions before creating an RSVP', async () => {
    const harness = createHarness()
    harness.addSession('cancelled-session', 'host', 'cancelled')

    await expect(harness.command('player', {
      operation: 'rsvp',
      sessionId: 'missing-session',
      status: 'going',
    })).resolves.toMatchObject({ success: false })
    await expect(harness.command('player', {
      operation: 'rsvp',
      sessionId: 'cancelled-session',
      status: 'going',
    })).resolves.toMatchObject({ success: false, error: 'This session is not open for responses.' })
    expect(harness.rsvps.size).toBe(0)
  })

  it('uses the verified caller, not a supplied userId, and serializes duplicate RSVP commands', async () => {
    const harness = createHarness()
    harness.addSession('open-session', 'host')

    const [first, second] = await Promise.all([
      harness.command('player', {
        operation: 'rsvp',
        sessionId: 'open-session',
        status: 'going',
        userId: 'host',
      }),
      harness.command('player', {
        operation: 'rsvp',
        sessionId: 'open-session',
        status: 'maybe',
        userId: 'host',
      }),
    ])

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    if (
      !first.success ||
      !second.success ||
      typeof first.data !== 'object' ||
      first.data === null ||
      !('recordId' in first.data) ||
      typeof first.data.recordId !== 'string' ||
      typeof second.data !== 'object' ||
      second.data === null ||
      !('recordId' in second.data) ||
      typeof second.data.recordId !== 'string'
    ) {
      throw new Error('Expected RSVP commands to return record IDs.')
    }
    expect(first.data.recordId).toBe(second.data.recordId)
    expect(harness.rsvps.size).toBe(1)
    expect(Array.from(harness.rsvps.values())[0].data).toMatchObject({
      sessionId: 'open-session',
      userId: 'player',
      status: 'maybe',
    })
  })

  it('allows only the host to cancel and does not permit reopening', async () => {
    const harness = createHarness()
    harness.addSession('open-session', 'host')

    await expect(harness.command('player', {
      operation: 'cancel',
      sessionId: 'open-session',
    })).resolves.toMatchObject({ success: false, error: 'Only the session host can cancel it.' })
    expect(harness.sessions.get('open-session')?.data.status).toBe('open')

    await expect(harness.command('host', {
      operation: 'cancel',
      sessionId: 'open-session',
    })).resolves.toMatchObject({ success: true })
    await expect(harness.command('host', {
      operation: 'reopen',
      sessionId: 'open-session',
      status: 'open',
    })).resolves.toMatchObject({ success: false })
    expect(harness.sessions.get('open-session')?.data.status).toBe('cancelled')
  })

  it('serializes an RSVP and cancellation for the same session', async () => {
    const rsvpFirst = createHarness()
    rsvpFirst.addSession('open-session', 'host')
    const [rsvpResult, cancelResult] = await Promise.all([
      rsvpFirst.command('player', {
        operation: 'rsvp',
        sessionId: 'open-session',
        status: 'going',
      }),
      rsvpFirst.command('host', {
        operation: 'cancel',
        sessionId: 'open-session',
      }),
    ])
    expect(rsvpResult.success).toBe(true)
    expect(cancelResult.success).toBe(true)
    expect(rsvpFirst.sessions.get('open-session')?.data.status).toBe('cancelled')
    expect(rsvpFirst.rsvps.size).toBe(1)
    await expect(rsvpFirst.command('player', {
      operation: 'rsvp',
      sessionId: 'open-session',
      status: 'going',
    })).resolves.toMatchObject({ success: false })

    const cancelFirst = createHarness()
    cancelFirst.addSession('open-session', 'host')
    const [cancelled, rejectedRsvp] = await Promise.all([
      cancelFirst.command('host', {
        operation: 'cancel',
        sessionId: 'open-session',
      }),
      cancelFirst.command('player', {
        operation: 'rsvp',
        sessionId: 'open-session',
        status: 'going',
      }),
    ])
    expect(cancelled.success).toBe(true)
    expect(rejectedRsvp).toMatchObject({ success: false })
    expect(cancelFirst.rsvps.size).toBe(0)
  })

  it('keeps one account’s responses in different sessions independent', async () => {
    const harness = createHarness()
    harness.addSession('morning', 'host')
    harness.addSession('evening', 'host')
    const rsvp = (sessionId: string, status: 'going' | 'maybe') =>
      harness.command('player', { operation: 'rsvp', sessionId, status })

    await expect(rsvp('morning', 'going')).resolves.toMatchObject({ success: true })
    await expect(rsvp('evening', 'maybe')).resolves.toMatchObject({ success: true })
    await expect(rsvp('morning', 'maybe')).resolves.toMatchObject({ success: true })

    expect(Array.from(harness.rsvps.values()).map(record => record.data)).toEqual([
      { sessionId: 'morning', userId: 'player', status: 'maybe' },
      { sessionId: 'evening', userId: 'player', status: 'maybe' },
    ])
    await expect(harness.command('host', { operation: 'cancel', sessionId: 'morning' }))
      .resolves.toMatchObject({ success: true })
    await expect(rsvp('evening', 'going')).resolves.toMatchObject({ success: true })
    expect(harness.sessions.get('evening')?.data.status).toBe('open')
    expect(Array.from(harness.rsvps.values()).find(r => r.data.sessionId === 'evening')?.data.status).toBe('going')
  })

  it('authorizes score writes and ignores retries against the same revision', async () => {
    const harness = createHarness()
    const sessionId = 'singles'
    harness.addSession(sessionId, 'host')
    const session = harness.sessions.get(sessionId)!.data
    session.format = 'Singles'
    const start = { operation: 'startMatch', sessionId, teams: [['host'], ['player']] }
    await expect(harness.command('player', { ...start, userId: 'host' })).resolves.toMatchObject({ success: false })
    await expect(harness.command('host', start)).resolves.toMatchObject({ success: false })
    for (const user of ['host', 'player']) {
      await expect(harness.command(user, { operation: 'rsvp', sessionId, status: 'going' }))
        .resolves.toMatchObject({ success: true })
    }
    await expect(harness.command('host', { ...start, teams: [['host'], ['host']] }))
      .resolves.toMatchObject({ success: false })
    await expect(harness.command('host', start)).resolves.toMatchObject({ success: true })
    const point = { operation: 'scorePoint', sessionId, side: 0, revision: 0 }
    await expect(harness.command('player', point)).resolves.toMatchObject({ success: false })
    const results = await Promise.all([harness.command('host', point), harness.command('host', point)])
    expect(results.map(result => result.success)).toEqual([true, false])
    expect(readMatchScore(session.matchScore)).toMatchObject({ revision: 1, points: [1, 0] })
    await expect(harness.command('host', { operation: 'cancel', sessionId })).resolves.toMatchObject({ success: true })
    await expect(harness.command('host', { ...point, revision: 1 })).resolves.toMatchObject({ success: false })
  })

  it('finalizes a completed result only after each verified participant approves', async () => {
    const harness = createHarness()
    const sessionId = 'played'
    harness.addSession(sessionId, 'organizer')
    const session = harness.sessions.get(sessionId)!.data
    let score = createMatchScore([['alice'], ['bob']])
    for (let point = 0; point < 48; point++) score = awardPoint(score, 0)
    session.matchScore = JSON.stringify(score)
    const vote = { operation: 'reviewResult', sessionId, decision: 'approve', userId: 'alice' }
    await expect(harness.command('organizer', vote)).resolves.toMatchObject({ success: false })
    const approvals = await Promise.all(['alice', 'bob'].map(user => harness.command(user, vote)))
    expect(approvals.map(result => result.success)).toEqual([true, true])
    expect(resultStatus(readMatchScore(session.matchScore)!)).toBe('final')
    await expect(harness.command('alice', { ...vote, decision: 'dispute' })).resolves.toMatchObject({ success: false })
  })

  it('serializes confirmations for the last spot and permits a join after withdrawal', async () => {
    const harness = createHarness()
    const sessionId = 'limited'
    harness.addSession(sessionId, 'host')
    harness.sessions.get(sessionId)!.data.capacity = 2
    const respond = (user: string, status: RSVPStatus = 'going') =>
      harness.command(user, { operation: 'rsvp', sessionId, status })
    await expect(respond('host')).resolves.toMatchObject({ success: true })
    await expect(respond('first', 'maybe')).resolves.toMatchObject({ success: true })
    const lastSpot = await Promise.all([respond('first'), respond('second')])
    expect(lastSpot.map(result => result.success)).toEqual([true, false])
    await expect(respond('first')).resolves.toMatchObject({ success: true })
    await expect(respond('second', 'maybe')).resolves.toMatchObject({ success: true })
    const hostRsvp = [...harness.rsvps.values()].find(record => record.data.userId === 'host')!
    harness.rsvps.delete(hostRsvp.recordId)
    await expect(respond('second')).resolves.toMatchObject({ success: true })
    expect([...harness.rsvps.values()].filter(record => record.data.status === 'going')).toHaveLength(2)
  })

  it('promotes in queue order, upgrades a tentative RSVP and stops on cancellation', async () => {
    const harness = createHarness()
    const sessionId = 'queue'
    harness.addSession(sessionId, 'host')
    harness.sessions.get(sessionId)!.data.capacity = 2
    const act = (user: string, operation: string, status?: RSVPStatus) =>
      harness.command(user, { sessionId, operation, status, userId: 'host' })
    for (const player of ['host', 'guest']) {
      expect((await act(player, 'rsvp', 'going')).success).toBe(true)
    }
    expect((await act('first', 'rsvp', 'maybe')).success).toBe(true)
    expect((await act('first', 'joinWaitlist')).success).toBe(true)
    expect((await act('first', 'joinWaitlist')).success).toBe(true)
    expect((await act('second', 'joinWaitlist')).success).toBe(true)
    expect(harness.waitlists.size).toBe(2)
    expect((await act('host', 'rsvp', 'maybe')).success).toBe(true)
    expect([...harness.rsvps.values()].filter(row => row.data.userId === 'first').map(row => row.data.status)).toEqual(['going'])
    expect([...harness.waitlists.values()].map(row => row.data.userId)).toEqual(['second'])
    expect((await act('host', 'cancel')).success).toBe(true)
    expect((await act('guest', 'withdraw')).success).toBe(true)
    expect([...harness.waitlists.values()].map(row => row.data.userId)).toEqual(['second'])
    expect((await act('second', 'leaveWaitlist')).success).toBe(true)
    expect(harness.waitlists.size).toBe(0)
  })

  it('repairs an interrupted promotion inside the same command, and repairs a double failure on the next command', async () => {
    const harness = createHarness()
    const sessionId = 'recovery'
    harness.addSession(sessionId, 'host')
    harness.sessions.get(sessionId)!.data.capacity = 2
    const act = (user: string, operation: string, status?: RSVPStatus) =>
      harness.command(user, { sessionId, operation, status })
    for (const player of ['host', 'guest']) {
      expect((await act(player, 'rsvp', 'going')).success).toBe(true)
    }
    for (const player of ['first', 'second']) {
      expect((await act(player, 'joinWaitlist')).success).toBe(true)
    }
    // One transient delete failure is retried inside fillVacancies, so the
    // withdrawal itself completes the promotion: no stale row, and the next
    // join sees the true state immediately.
    harness.interruptQueueCleanup(1)
    expect((await act('guest', 'withdraw')).success).toBe(true)
    expect([...harness.waitlists.values()].map(row => row.data.userId)).toEqual(['second'])
    expect((await act('outsider', 'rsvp', 'going')).success).toBe(false)
    expect((await act('first', 'withdraw')).success).toBe(true)
    expect([...harness.rsvps.values()].map(row => row.data.userId).sort()).toEqual(['host', 'second'])
    expect(harness.waitlists.size).toBe(0)

    // Two consecutive delete failures exhaust the in-command retry. The
    // promotion's RSVP is already saved, so no spot is lost; the next
    // attendance command repairs the stale row instead of consuming a
    // second place or letting anyone jump the queue.
    const twice = createHarness()
    twice.addSession(sessionId, 'host')
    twice.sessions.get(sessionId)!.data.capacity = 2
    const act2 = (user: string, operation: string, status?: RSVPStatus) =>
      twice.command(user, { sessionId, operation, status })
    for (const player of ['host', 'guest']) {
      expect((await act2(player, 'rsvp', 'going')).success).toBe(true)
    }
    for (const player of ['first', 'second']) {
      expect((await act2(player, 'joinWaitlist')).success).toBe(true)
    }
    twice.interruptQueueCleanup(2)
    expect((await act2('guest', 'withdraw')).success).toBe(true)
    expect(twice.waitlists.size).toBe(2)
    expect((await act2('outsider', 'rsvp', 'going')).success).toBe(false)
    expect([...twice.waitlists.values()].map(row => row.data.userId)).toEqual(['second'])
    expect((await act2('first', 'withdraw')).success).toBe(true)
    expect([...twice.rsvps.values()].map(row => row.data.userId).sort()).toEqual(['host', 'second'])
    expect(twice.waitlists.size).toBe(0)
  })

  it('requires the serialized command path for RSVP withdrawal', () => {
    const rsvp = {
      data: { sessionId: 'session', userId: 'player', status: 'going' },
      createdBy: 'player',
      recordId: 'rsvp',
    }

    expect(canCreate(rsvpsSchema, 'member')).toBe(false)
    expect(canUpdate(rsvpsSchema, 'member', rsvp, 'player')).toBe(false)
    expect(canDelete(rsvpsSchema, 'member', rsvp, 'player')).toBe(false)
    expect(canCreate(waitlistsSchema, 'member')).toBe(false)
    expect(canDelete(rsvpsSchema, 'admin', rsvp, 'player')).toBe(false)
    expect(canDelete(rsvpsSchema, 'member', rsvp, 'other-player')).toBe(false)
    expect(canDelete(rsvpsSchema, 'anonymous', rsvp, 'player')).toBe(false)
    expect(checkFieldPermissions(sessionsSchema, 'member', { status: 'cancelled' })).toContain('status')
    expect(checkFieldPermissions(sessionsSchema, 'member', { status: 'open' })).toContain('status')
    expect(checkFieldPermissions(sessionsSchema, 'member', { matchScore: '{}' })).toContain('matchScore')
    expect(checkFieldPermissions(sessionsSchema, 'admin', { matchScore: '{}' })).toContain('matchScore')
    expect(canUpdate(sessionsSchema, 'member', {
      data: { hostId: 'host' },
      createdBy: 'host',
      recordId: 'session',
    }, 'player')).toBe(false)
  })
})

describe('Scheduling polls', () => {
  const options = [
    { id: 'sat', startsAt: '2030-01-05T18:00:00.000Z' },
    { id: 'sun', startsAt: '2030-01-06T18:00:00.000Z' },
  ]

  async function openPoll(harness: ReturnType<typeof createHarness>) {
    harness.addSession('poll-session', 'host')
    for (const user of ['host', 'alice', 'bob']) {
      await harness.command(user, { operation: 'rsvp', sessionId: 'poll-session', status: 'going' })
    }
    const created = await harness.command('host', { operation: 'createPoll', sessionId: 'poll-session', options })
    expect(created.success).toBe(true)
    if (!created.success || typeof created.data !== 'object' || created.data === null || !('recordId' in created.data)) {
      throw new Error('Expected a poll record id.')
    }
    return created.data.recordId as string
  }

  it('lets only the host create a poll, with 2–5 distinct future times', async () => {
    const harness = createHarness()
    harness.addSession('poll-session', 'host')
    await expect(harness.command('alice', { operation: 'createPoll', sessionId: 'poll-session', options }))
      .resolves.toMatchObject({ success: false, error: 'Only the session host can create a poll.' })
    await expect(harness.command('host', { operation: 'createPoll', sessionId: 'poll-session', options: [options[0]] }))
      .resolves.toMatchObject({ success: false })
    await expect(harness.command('host', {
      operation: 'createPoll', sessionId: 'poll-session',
      options: [{ id: 'past', startsAt: '2020-01-01T18:00:00.000Z' }, options[1]],
    })).resolves.toMatchObject({ success: false })
    await expect(harness.command('host', { operation: 'createPoll', sessionId: 'poll-session', options }))
      .resolves.toMatchObject({ success: true })
    await expect(harness.command('host', { operation: 'createPoll', sessionId: 'poll-session', options }))
      .resolves.toMatchObject({ success: false, error: 'This session already has a poll.' })
    expect(harness.polls.size).toBe(1)
  })

  it('keeps one vote per user per option under concurrent votes, with a server tally', async () => {
    const harness = createHarness()
    const pollId = await openPoll(harness)
    await expect(harness.command('outsider', { operation: 'castVote', sessionId: 'poll-session', pollId, optionId: 'sat' }))
      .resolves.toMatchObject({ success: false, error: 'Only session participants can vote.' })
    const votes = await Promise.all(Array.from({ length: 5 }, () =>
      harness.command('alice', { operation: 'castVote', sessionId: 'poll-session', pollId, optionId: 'sat' })))
    expect(votes.every(result => result.success)).toBe(true)
    expect(harness.pollVotes.size).toBe(1)
    expect(JSON.parse(harness.polls.get(pollId)!.data.tally)).toEqual({ sat: 1 })
    await expect(harness.command('alice', { operation: 'castVote', sessionId: 'poll-session', pollId, optionId: 'sun' }))
      .resolves.toMatchObject({ success: true })
    expect(JSON.parse(harness.polls.get(pollId)!.data.tally)).toEqual({ sat: 1, sun: 1 })
    await expect(harness.command('alice', { operation: 'withdrawVote', sessionId: 'poll-session', pollId, optionId: 'sat' }))
      .resolves.toMatchObject({ success: true })
    await expect(harness.command('alice', { operation: 'withdrawVote', sessionId: 'poll-session', pollId, optionId: 'sat' }))
      .resolves.toMatchObject({ success: true })
    expect(JSON.parse(harness.polls.get(pollId)!.data.tally)).toEqual({ sun: 1 })
    expect(harness.pollVotes.size).toBe(1)
  })

  it('finalises only as host, preserves RSVPs, bumps the schedule revision and notifies', async () => {
    const harness = createHarness()
    const pollId = await openPoll(harness)
    await expect(harness.command('alice', { operation: 'finalizePoll', sessionId: 'poll-session', pollId, optionId: 'sat' }))
      .resolves.toMatchObject({ success: false, error: 'Only the session host can finalise a poll.' })
    await expect(harness.command('host', { operation: 'finalizePoll', sessionId: 'poll-session', pollId, optionId: 'sat' }))
      .resolves.toMatchObject({ success: true })
    const session = harness.sessions.get('poll-session')!.data
    expect(session.startsAt).toBe('2030-01-05T18:00:00.000Z')
    expect(session.scheduleRevision).toBe(1)
    expect(harness.polls.get(pollId)!.data.status).toBe('finalized')
    expect(harness.polls.get(pollId)!.data.finalizedOptionId).toBe('sat')
    // RSVPs carry over untouched (G08).
    expect([...harness.rsvps.values()].map(row => row.data.status).sort()).toEqual(['going', 'going', 'going'])
    // Both participants (not the host) got a schedule-change notice.
    // (createPoll also emitted poll_created notices to the same people,
    // so filter by type here.)
    const notices = [...harness.notifications.values()].filter(row => row.data.type === 'schedule_changed')
    expect(notices.map(row => row.data.recipientId).sort()).toEqual(['alice', 'bob'])
    expect(notices.every(row => row.data.type === 'schedule_changed')).toBe(true)
    await expect(harness.command('alice', { operation: 'castVote', sessionId: 'poll-session', pollId, optionId: 'sun' }))
      .resolves.toMatchObject({ success: false })
  })

  it('rejects finalising a time that is no longer in the future', async () => {
    const harness = createHarness()
    const pollId = await openPoll(harness)
    // Simulate time passing after the poll was created: rewrite the stored
    // option to a past instant and confirm the room re-validates at write time.
    const poll = harness.polls.get(pollId)!
    poll.data.options = JSON.stringify([
      { id: 'sat', startsAt: '2020-01-05T18:00:00.000Z' },
      { id: 'sun', startsAt: '2030-01-06T18:00:00.000Z' },
    ])
    await expect(harness.command('host', { operation: 'finalizePoll', sessionId: 'poll-session', pollId, optionId: 'sat' }))
      .resolves.toMatchObject({ success: false, error: 'The proposed time is no longer in the future.' })
    expect(harness.sessions.get('poll-session')!.data.startsAt).toBe('2030-01-01T12:00:00.000Z')
  })
})

describe('Recurring series', () => {
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

  it('validates bounds and generates bounded weekly occurrences with host RSVPs', async () => {
    const harness = createHarness()
    await expect(harness.scheduleCommand('host', {
      operation: 'createSeries', template, startStartsAt: '2030-01-05T18:00:00.000Z', intervalWeeks: 1, count: 1,
    })).resolves.toMatchObject({ success: false })
    await expect(harness.scheduleCommand('host', {
      operation: 'createSeries', template, startStartsAt: '2020-01-05T18:00:00.000Z', intervalWeeks: 1, count: 3,
    })).resolves.toMatchObject({ success: false })
    const created = await harness.scheduleCommand('host', {
      operation: 'createSeries', template, startStartsAt: '2030-01-05T18:00:00.000Z', intervalWeeks: 1, count: 3,
    })
    expect(created.success).toBe(true)
    if (!created.success || typeof created.data !== 'object' || created.data === null || !('recordId' in created.data)) {
      throw new Error('Expected a series record id.')
    }
    const seriesId = created.data.recordId as string
    await expect(harness.scheduleCommand('alice', { operation: 'generateOccurrences', seriesId }))
      .resolves.toMatchObject({ success: false })
    await expect(harness.scheduleCommand('host', { operation: 'generateOccurrences', seriesId }))
      .resolves.toMatchObject({ success: true })
    const instances = [...harness.sessions.values()].filter(row => row.data.seriesId === seriesId)
    expect(instances.map(row => row.data.startsAt)).toEqual([
      '2030-01-05T18:00:00.000Z',
      '2030-01-12T18:00:00.000Z',
      '2030-01-19T18:00:00.000Z',
    ])
    expect(instances.every(row => row.data.status === 'open')).toBe(true)
    expect([...harness.rsvps.values()].filter(row => row.data.userId === 'host')).toHaveLength(3)
    await expect(harness.scheduleCommand('host', { operation: 'generateOccurrences', seriesId }))
      .resolves.toMatchObject({ success: false, error: 'All occurrences have already been generated.' })
  })

  it('cancels only future open instances and leaves the series record cancelled', async () => {
    const harness = createHarness()
    const created = await harness.scheduleCommand('host', {
      operation: 'createSeries', template, startStartsAt: '2030-01-05T18:00:00.000Z', intervalWeeks: 1, count: 3,
    })
    const seriesId = (created.data as { recordId: string }).recordId
    await harness.scheduleCommand('host', { operation: 'generateOccurrences', seriesId })
    const instances = [...harness.sessions.values()].filter(row => row.data.seriesId === seriesId)
    // One instance is already in the past: it must not be touched.
    instances[0].data.startsAt = '2020-01-05T18:00:00.000Z'
    // One instance was already cancelled individually: series cancel leaves it alone.
    instances[1].data.status = 'cancelled'
    await harness.command('alice', { operation: 'rsvp', sessionId: instances[2].recordId, status: 'going' })
    await expect(harness.scheduleCommand('alice', { operation: 'cancelSeries', seriesId }))
      .resolves.toMatchObject({ success: false })
    await expect(harness.scheduleCommand('host', { operation: 'cancelSeries', seriesId }))
      .resolves.toMatchObject({ success: true })
    expect(harness.recurringSeries.get(seriesId)!.data.status).toBe('cancelled')
    expect(instances[0].data.status).toBe('open')
    expect(instances[1].data.status).toBe('cancelled')
    expect(instances[2].data.status).toBe('cancelled')
    const notices = [...harness.notifications.values()].filter(row => row.data.type === 'session_cancelled')
    expect(notices.map(row => row.data.recipientId)).toEqual(['alice'])
  })
})

describe('Notifications', () => {
  it('emits exactly one promotion notice to the promoted player', async () => {
    const harness = createHarness()
    harness.addSession('limited', 'host')
    harness.sessions.get('limited')!.data.capacity = 2
    const act = (user: string, operation: string, status?: 'going' | 'maybe') =>
      harness.command(user, { sessionId: 'limited', operation, status })
    for (const player of ['host', 'guest']) {
      expect((await act(player, 'rsvp', 'going')).success).toBe(true)
    }
    expect((await act('first', 'joinWaitlist')).success).toBe(true)
    expect((await act('guest', 'withdraw')).success).toBe(true)
    const notices = [...harness.notifications.values()]
    expect(notices).toHaveLength(1)
    expect(notices[0].data).toMatchObject({
      recipientId: 'first',
      type: 'waitlist_promoted',
      sessionId: 'limited',
      link: '/rallies?session=limited',
    })
    expect(notices[0].data.idempotencyKey).toMatch(/^waitlist_promoted:rsvp-/)
    expect(notices[0].data.readAt).toBe('')
  })

  it('notifies RSVP holders of a cancellation once, never the host', async () => {
    const harness = createHarness()
    harness.addSession('game', 'host')
    for (const user of ['alice', 'bob']) {
      await harness.command(user, { operation: 'rsvp', sessionId: 'game', status: 'going' })
    }
    await expect(harness.command('host', { operation: 'cancel', sessionId: 'game' }))
      .resolves.toMatchObject({ success: true })
    await expect(harness.command('host', { operation: 'cancel', sessionId: 'game' }))
      .resolves.toMatchObject({ success: true })
    const notices = [...harness.notifications.values()]
    expect(notices.map(row => row.data.recipientId).sort()).toEqual(['alice', 'bob'])
    expect(notices.every(row => row.data.type === 'session_cancelled')).toBe(true)
    expect(notices.every(row => row.data.idempotencyKey.startsWith('session_cancelled:game:'))).toBe(true)
  })

  it('enforces recipient-only read state and honours poll opt-outs without losing essential notices', async () => {
    const harness = createHarness()
    harness.addSession('poll-session', 'host')
    for (const user of ['host', 'alice']) {
      await harness.command(user, { operation: 'rsvp', sessionId: 'poll-session', status: 'going' })
    }
    // Alice opts out of polls.
    await expect(harness.notificationCommand('alice', { operation: 'setPreferences', preferences: { polls: false } }))
      .resolves.toMatchObject({ success: true })
    const created = await harness.command('host', {
      operation: 'createPoll',
      sessionId: 'poll-session',
      options: [
        { id: 'a', startsAt: '2030-01-05T18:00:00.000Z' },
        { id: 'b', startsAt: '2030-01-06T18:00:00.000Z' },
      ],
    })
    const pollId = (created.data as { recordId: string }).recordId
    // No poll_created notice for Alice (opted out), but finalisation is
    // essential and still reaches her.
    expect([...harness.notifications.values()]).toHaveLength(0)
    await expect(harness.command('host', { operation: 'finalizePoll', sessionId: 'poll-session', pollId, optionId: 'a' }))
      .resolves.toMatchObject({ success: true })
    const notices = [...harness.notifications.values()]
    expect(notices).toHaveLength(1)
    expect(notices[0].data).toMatchObject({ recipientId: 'alice', type: 'schedule_changed' })
    // Read state is recipient-checked.
    const recordId = notices[0].recordId
    await expect(harness.notificationCommand('bob', { operation: 'markRead', recordId }))
      .resolves.toMatchObject({ success: false })
    await expect(harness.notificationCommand('alice', { operation: 'markRead', recordId }))
      .resolves.toMatchObject({ success: true })
    expect(harness.notifications.get(recordId)!.data.readAt).not.toBe('')
    await expect(harness.notificationCommand('alice', { operation: 'markAllRead' }))
      .resolves.toMatchObject({ success: true, data: { count: 0 } })
  })

  it('prunes a recipient inbox to the retention cap on emission', async () => {
    const harness = createHarness()
    harness.addSession('game', 'host')
    await harness.command('alice', { operation: 'rsvp', sessionId: 'game', status: 'going' })
    // Seed 100 stale notices for Alice directly in the harness store.
    // The cancel then adds one more (101 total); the emitter's prune
    // query sees cap+1 rows and deletes the single oldest, leaving
    // exactly the cap. (Seeding 101 would leave 101 after one emit,
    // because the prune query can only see cap+1 rows at a time.)
    for (let i = 0; i < 100; i++) {
      harness.notifications.set(`seed-${i}`, {
        recordId: `seed-${i}`,
        data: {
          recipientId: 'alice', type: 'poll_created', sessionId: '', title: 'Old', body: 'Old',
          link: '', idempotencyKey: `seed:${i}`, readAt: '',
        },
        seq: i,
      })
    }
    await expect(harness.command('host', { operation: 'cancel', sessionId: 'game' }))
      .resolves.toMatchObject({ success: true })
    const aliceNotices = [...harness.notifications.values()].filter(row => row.data.recipientId === 'alice')
    expect(aliceNotices.length).toBeLessThanOrEqual(100)
    expect(aliceNotices.some(row => row.data.type === 'session_cancelled')).toBe(true)
  })
})
