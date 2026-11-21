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

  it('keeps the calendar revision when retrying after only the session time was saved', async () => {
    const harness = createHarness()
    const pollId = await openPoll(harness)
    const session = harness.sessions.get('poll-session')!.data
    session.startsAt = '2030-01-05T18:00:00.000Z'
    session.scheduleRevision = 1
    await expect(harness.command('host', { operation: 'finalizePoll', sessionId: 'poll-session', pollId, optionId: 'sat' }))
      .resolves.toMatchObject({ success: true })
    expect(session.scheduleRevision).toBe(1)
    expect(harness.polls.get(pollId)!.data.status).toBe('finalized')
    expect([...harness.notifications.values()].filter(row => row.data.type === 'schedule_changed')).toHaveLength(2)
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
