/**
 * PR #20 Durable Object reliability and interrupted-operation recovery.
 *
 * Tests the alarm-driven recovery added in PR #20 (6cdeaec / 8968205) with
 * deterministic fault injection against the REAL RallyCommandRoom, driven
 * through a mock RecordRoom and a mock DurableObjectState.
 *
 * EVERYTHING here is a local simulation: the alarm is invoked by calling
 * room.alarm() directly (a mock delivery), eviction is simulated by
 * re-creating the room from the same storage, and "deleted" records are
 * removed from the mock store. Nothing here proves live Cloudflare alarm
 * behaviour; the live semantics we rely on are quoted from the Cloudflare
 * Durable Objects alarms docs (developers.cloudflare.com/durable-objects/
 * api/alarms/): alarm() has guaranteed at-least-once execution, a throwing
 * handler is retried with exponential backoff starting at 2s for up to 6
 * retries, and only one alarm() runs at a time per object instance.
 *
 * Prior work this builds on (not repeated): PR #19 races S1/S3/S5/S6/S7 —
 * partial finalization repairs on exact retry, poll finalize retry
 * converges, notification failure is fail-closed/best-effort, and a stuck
 * pendingResult blocks cancel (races fix branch only, NOT in PR #20).
 * The existing suites already cover correction resume after a failed
 * completion and poll recovery after writes 1–5 fail; the tests below
 * cover what they do not: poisoned/unbounded alarm loops, throws before
 * the re-arm, concurrent alarm deliveries, eviction-time double-apply,
 * storage-key growth under load, and the frozen-poll liveness hole.
 */
import type { ActionTools } from 'deepspace/worker'
import { describe, expect, it } from 'vitest'
import type { RallyRSVP, RallySession, RallyWaitlist } from '../lib/rally.js'
import type { Env } from '../../worker.js'
import { awardPoint, createMatchScore, readMatchScore, resultStatus } from '../lib/rally-score.js'
import {
  rallyCommandAction,
  RallyCommandRoom,
  type RallyPoll,
  type RallyPollVote,
} from './rally-command-room.js'
import type { RallyNotification } from '../lib/rally-notifications.js'

type Stored<T> = { recordId: string; createdBy?: string; data: T; seq?: number }

function createHarness() {
  const sessions = new Map<string, Stored<RallySession>>()
  const rsvps = new Map<string, Stored<RallyRSVP>>()
  const waitlists = new Map<string, Stored<RallyWaitlist>>()
  const polls = new Map<string, Stored<RallyPoll>>()
  const pollVotes = new Map<string, Stored<RallyPollVote>>()
  const notifications = new Map<string, Stored<RallyNotification>>()
  // Finalization rows: matchResults / resultAudits / profiles. The room
  // writes these through the same RecordTool; the mock honours where
  // filters, limit and duplicate rules loosely (no uniqueOn enforcement —
  // the product code dedupes by query, which is what is under test).
  const resultRows = new Map<string, Map<string, Stored<Record<string, unknown>>>>(
    ['matchResults', 'resultAudits', 'profiles', 'playerStats'].map(name =>
      [name, new Map<string, Stored<Record<string, unknown>>>()] as const,
    ),
  )
  let nextRecordId = 0
  let nextSeq = 0
  let mutationsUntilFailure = 0
  let failQueueDeletes = 0

  // --- Mock DurableObjectState storage, with call tracking + injection ---
  const store = new Map<string, unknown>()
  const putKeys: string[] = []
  let armedAlarm: number | null = null
  let setAlarmCalls = 0
  let deleteAlarmCalls = 0
  let failGetTimes = 0
  let failPutTimes = 0
  let failDeleteTimes = 0
  const state = {
    storage: {
      get: async (key: string) => {
        if (failGetTimes > 0) { failGetTimes--; throw new Error('Injected storage get failure') }
        return store.get(key)
      },
      put: async (key: string, value: unknown) => {
        if (failPutTimes > 0) { failPutTimes--; throw new Error('Injected storage put failure') }
        putKeys.push(key)
        store.set(key, value)
      },
      delete: async (key: string) => {
        if (failDeleteTimes > 0) { failDeleteTimes--; throw new Error('Injected storage delete failure') }
        store.delete(key)
      },
      setAlarm: async (time: number) => { setAlarmCalls++; armedAlarm = time },
      deleteAlarm: async () => { deleteAlarmCalls++; armedAlarm = null },
      getAlarm: async () => armedAlarm,
    },
  } as unknown as DurableObjectState

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

      const where = (params.where ?? {}) as Record<string, unknown>
      const matches = (data: Record<string, unknown>) =>
        Object.entries(where).every(([key, value]) => data[key] === value)
      const page = <T>(rows: Stored<T>[]) => {
        const offset = Number(params.offset ?? 0)
        const limit = Number(params.limit ?? 100)
        const slice = rows.slice(offset, offset + limit)
        return {
          success: true,
          data: {
            records: slice,
            count: slice.length,
            nextOffset: rows.length > offset + limit ? offset + limit : undefined,
          },
        }
      }

      if (tool === 'records.get') {
        const collection = String(params.collection)
        const all = collection === 'sessions' ? sessions
          : collection === 'polls' ? polls
          : collection === 'rsvps' ? rsvps
          : resultRows.get(collection)
        const record = all?.get(String(params.recordId))
        return record
          ? Response.json({ success: true, data: { record } })
          : Response.json({ success: false, error: 'Record not found' })
      }

      if (tool === 'records.query') {
        const collection = String(params.collection)
        if (collection === 'sessions') return Response.json(page([...sessions.values()].filter(r => matches(r.data as unknown as Record<string, unknown>))))
        if (collection === 'rsvps') return Response.json(page([...rsvps.values()].filter(r => matches(r.data as unknown as Record<string, unknown>))))
        if (collection === 'waitlists') return Response.json(page([...waitlists.values()].filter(r => matches(r.data as unknown as Record<string, unknown>))))
        if (collection === 'polls') return Response.json(page([...polls.values()].filter(r => matches(r.data as unknown as Record<string, unknown>))))
        if (collection === 'pollVotes') return Response.json(page([...pollVotes.values()].filter(r => matches(r.data as unknown as Record<string, unknown>))))
        if (collection === 'notifications') {
          let rows = [...notifications.values()].filter(r => matches(r.data as unknown as Record<string, unknown>))
          if (params.orderBy === 'createdAt') {
            rows = [...rows].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
            if (params.orderDir === 'desc') rows.reverse()
          }
          return Response.json(page(rows))
        }
        if (collection === 'notificationPreferences') {
          return Response.json({ success: true, data: { records: [], count: 0 } })
        }
        const rows = resultRows.get(collection)
        if (rows) return Response.json(page([...rows.values()].filter(r => matches(r.data))))
        return Response.json({ success: false, error: 'Unexpected tool request' })
      }

      if (tool === 'records.create') {
        const collection = String(params.collection)
        const userId = request.headers.get('X-User-Id') ?? ''
        const data = params.data as Record<string, unknown>
        if (collection === 'rsvps') {
          if ([...rsvps.values()].some(r => r.data.sessionId === data.sessionId && r.data.userId === userId)) {
            return Response.json({ success: false, error: 'Duplicate RSVP' })
          }
          const recordId = `rsvp-${++nextRecordId}`
          rsvps.set(recordId, { recordId, createdBy: userId, data: { ...data, userId } as RallyRSVP })
          return Response.json({ success: true, data: { recordId } })
        }
        if (collection === 'waitlists') {
          const recordId = `waiting-${++nextRecordId}`
          waitlists.set(recordId, { recordId, data: { ...data, userId } as RallyWaitlist })
          return Response.json({ success: true, data: { recordId } })
        }
        if (collection === 'polls') {
          if ([...polls.values()].some(r => r.data.sessionId === data.sessionId)) {
            return Response.json({ success: false, error: 'Duplicate: a poll already exists for this session' })
          }
          const recordId = `poll-${++nextRecordId}`
          polls.set(recordId, { recordId, data: { ...data, hostId: userId } as RallyPoll, seq: ++nextSeq })
          return Response.json({ success: true, data: { recordId } })
        }
        if (collection === 'pollVotes') {
          if ([...pollVotes.values()].some(r =>
            r.data.pollId === data.pollId && r.data.optionId === data.optionId && r.data.userId === userId)) {
            return Response.json({ success: false, error: 'Duplicate: vote already exists' })
          }
          const recordId = `vote-${++nextRecordId}`
          pollVotes.set(recordId, { recordId, data: { ...data, userId } as RallyPollVote, seq: ++nextSeq })
          return Response.json({ success: true, data: { recordId } })
        }
        if (collection === 'notifications') {
          if ([...notifications.values()].some(r =>
            r.data.recipientId === userId && r.data.idempotencyKey === data.idempotencyKey)) {
            return Response.json({ success: false, error: 'Duplicate: notification already exists' })
          }
          const recordId = `notification-${++nextRecordId}`
          notifications.set(recordId, { recordId, data: { ...data, recipientId: userId } as RallyNotification, seq: ++nextSeq })
          return Response.json({ success: true, data: { recordId } })
        }
        const rows = resultRows.get(collection)
        if (rows) {
          const recordId = `row-${++nextRecordId}`
          rows.set(recordId, { recordId, data: { ...data, userId } })
          return Response.json({ success: true, data: { recordId } })
        }
        return Response.json({ success: false, error: 'Unexpected tool request' })
      }

      if (tool === 'records.update') {
        const collection = String(params.collection)
        const recordId = String(params.recordId)
        const patch = params.data as Record<string, unknown>
        const all = collection === 'sessions' ? sessions
          : collection === 'polls' ? polls
          : collection === 'rsvps' ? rsvps
          : resultRows.get(collection)
        const record = all?.get(recordId)
        if (!record) return Response.json({ success: false, error: 'Record not found' })
        Object.assign(record.data, patch)
        return Response.json({ success: true, data: { recordId } })
      }

      if (tool === 'records.delete') {
        const collection = String(params.collection)
        if (collection === 'waitlists' && failQueueDeletes > 0) {
          failQueueDeletes--
          return Response.json({ success: false, error: 'Temporary delete failure' })
        }
        const all = collection === 'rsvps' ? rsvps
          : collection === 'waitlists' ? waitlists
          : collection === 'pollVotes' ? pollVotes
          : collection === 'notifications' ? notifications
          : resultRows.get(collection)
        const recordId = String(params.recordId)
        return Response.json(all?.delete(recordId)
          ? { success: true, data: { recordId } }
          : { success: false, error: 'Not found' })
      }

      return Response.json({ success: false, error: 'Unexpected tool request' })
    },
  }

  const env = {
    DEEPSPACE_APP_ID: 'test-app',
    RECORD_ROOMS: { idFromName: (name: string) => name, get: () => recordRoom },
  } as unknown as Env
  let room = new RallyCommandRoom(state, env)
  const commandNamespace = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: (request: Request) => room.fetch(request) }),
  }
  const actionEnv = { ...env, RALLY_COMMAND_ROOMS: commandNamespace } as unknown as Env

  function addSession(recordId: string, hostId: string, format?: 'Singles' | 'Doubles') {
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
        status: 'open',
        ...(format ? { format } : {}),
      } as RallySession,
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
            ? { success: true as const, data: { record: { ...record, createdAt: '', updatedAt: '' } } }
            : { success: false as const, error: 'Record not found' }
        },
      } as ActionTools,
    })
  }

  return {
    addSession, command, sessions, rsvps, waitlists, polls, pollVotes, notifications, resultRows,
    store, putKeys,
    failMutation: (index: number) => { mutationsUntilFailure = index },
    interruptQueueCleanup: (times = 1) => { failQueueDeletes = times },
    failStorageGet: (times = 1) => { failGetTimes = times },
    failStorageDelete: (times = 1) => { failDeleteTimes = times },
    failStoragePut: (times = 1) => { failPutTimes = times },
    /** Simulate DO eviction: drop the in-memory room (and its queue) and re-create it from the same storage. */
    restart: () => { room = new RallyCommandRoom(state, env) },
    /** A second live room instance sharing the same storage (failover overlap). */
    secondRoom: () => new RallyCommandRoom(state, env),
    alarm: () => room.alarm(),
    alarmOn: (other: RallyCommandRoom) => other.alarm(),
    alarmState: () => ({ armedAlarm, setAlarmCalls, deleteAlarmCalls, keys: [...store.keys()] }),
    deleteSession: (id: string) => sessions.delete(id),
    deletePoll: (id: string) => polls.delete(id),
    /** Simulate a member's direct client write (startsAt is member-writable). */
    editSessionDirect: (id: string, patch: Partial<RallySession>) => {
      Object.assign(sessions.get(id)!.data, patch)
    },
  }
}

const POLL_OPTIONS = [
  { id: 'sat', startsAt: '2030-01-05T18:00:00.000Z' },
  { id: 'sun', startsAt: '2030-01-06T18:00:00.000Z' },
]

async function openPoll(harness: ReturnType<typeof createHarness>) {
  harness.addSession('poll-session', 'host')
  for (const user of ['host', 'alice', 'bob']) {
    await expect(harness.command(user, { operation: 'rsvp', sessionId: 'poll-session', status: 'going' }))
      .resolves.toMatchObject({ success: true })
  }
  const created = await harness.command('host', { operation: 'createPoll', sessionId: 'poll-session', options: POLL_OPTIONS })
  expect(created.success).toBe(true)
  if (!created.success || typeof created.data !== 'object' || created.data === null || !('recordId' in created.data)) {
    throw new Error('Expected a poll record id.')
  }
  return created.data.recordId as string
}

async function startSingles(harness: ReturnType<typeof createHarness>, sessionId: string, players: string[]) {
  harness.addSession(sessionId, 'host', 'Singles')
  for (const user of ['host', ...players]) {
    await expect(harness.command(user, { operation: 'rsvp', sessionId, status: 'going' }))
      .resolves.toMatchObject({ success: true })
  }
  await expect(harness.command('host', {
    operation: 'startMatch', sessionId, teams: players.map(player => [player]),
  })).resolves.toMatchObject({ success: true })
  return harness.sessions.get(sessionId)!.data
}

/** Drive a Singles score to a decided, proposed result (6–0, 6–0 for side 0). */
function decideScore(session: RallySession) {
  let score = readMatchScore(session.matchScore)!
  for (let point = 0; point < 48; point++) score = awardPoint(score, 0)
  session.matchScore = JSON.stringify(score)
  expect(resultStatus(score)).toBe('proposed')
  return score
}

describe('Alarm retry behaviour', () => {
  it('A1: a result recovery for a deleted session stops after the retry budget — no endless alarm loop', async () => {
    const harness = createHarness()
    const session = await startSingles(harness, 'gone', ['alice', 'bob'])
    decideScore(session)
    await expect(harness.command('alice', { operation: 'reviewResult', sessionId: 'gone', decision: 'approve' }))
      .resolves.toMatchObject({ success: true })
    // Fail the very first mutation (the pendingResult prepare write), so
    // the recovery key is armed but nothing was applied.
    harness.failMutation(1)
    await expect(harness.command('bob', { operation: 'reviewResult', sessionId: 'gone', decision: 'approve' }))
      .resolves.toMatchObject({ success: false })
    expect(harness.alarmState().keys).toContain('resultRecovery')

    // The session record is gone (deleted). The first ticks still retry
    // (transient failures must recover), but the loop is bounded.
    harness.deleteSession('gone')
    for (let tick = 0; tick < 5; tick++) {
      await harness.alarm()
    }
    expect(harness.alarmState().keys).toContain('resultRecovery')
    for (let tick = 0; tick < 7; tick++) {
      await harness.alarm()
    }
    expect(harness.alarmState().keys).not.toContain('resultRecovery')
    expect(harness.alarmState().armedAlarm).toBeNull()
  })

  it('A1b: a transient replay failure still recovers below the retry budget', async () => {
    const harness = createHarness()
    const pollId = await openPoll(harness)
    harness.failMutation(2)
    await expect(harness.command('host', { operation: 'finalizePoll', sessionId: 'poll-session', pollId, optionId: 'sat' }))
      .resolves.toMatchObject({ success: false })
    expect(harness.polls.get(pollId)!.data.status).toBe('finalizing')
    // The first alarm tick fails on the session write; the second succeeds.
    harness.failMutation(1)
    await harness.alarm()
    expect(harness.polls.get(pollId)!.data.status).toBe('finalizing')
    expect(harness.alarmState().keys).toContain('pollRecovery')
    await harness.alarm()
    expect(harness.polls.get(pollId)!.data.status).toBe('finalized')
    expect(harness.sessions.get('poll-session')!.data.scheduleRevision).toBe(1)
    expect(harness.alarmState().keys).not.toContain('pollRecovery')
  })

  it('A2: a poll recovery for a deleted poll stops after the retry budget — no endless alarm loop', async () => {
    const harness = createHarness()
    const pollId = await openPoll(harness)
    // Fail mutation 2 (the session time write): the poll is left
    // 'finalizing' with the recovery key armed.
    harness.failMutation(2)
    await expect(harness.command('host', { operation: 'finalizePoll', sessionId: 'poll-session', pollId, optionId: 'sat' }))
      .resolves.toMatchObject({ success: false })
    expect(harness.polls.get(pollId)!.data.status).toBe('finalizing')
    expect(harness.alarmState().keys).toContain('pollRecovery')

    harness.deletePoll(pollId)
    for (let tick = 0; tick < 12; tick++) {
      await harness.alarm()
    }
    expect(harness.alarmState().keys).not.toContain('pollRecovery')
    expect(harness.alarmState().armedAlarm).toBeNull()
  })

  it('A3: a throw before the re-arm still schedules a future alarm', async () => {
    const harness = createHarness()
    const session = await startSingles(harness, 'throwing', ['alice', 'bob'])
    decideScore(session)
    await expect(harness.command('alice', { operation: 'reviewResult', sessionId: 'throwing', decision: 'approve' }))
      .resolves.toMatchObject({ success: true })
    harness.failMutation(1)
    await expect(harness.command('bob', { operation: 'reviewResult', sessionId: 'throwing', decision: 'approve' }))
      .resolves.toMatchObject({ success: false })
    const armedAtStart = harness.alarmState().setAlarmCalls
    expect(harness.alarmState().keys).toContain('resultRecovery')

    // The first storage read inside recover() throws, before the next
    // alarm is persisted. The handler still rejects (so the platform
    // retries apply), but the code re-arms best-effort first.
    harness.failStorageGet(1)
    await expect(harness.alarm()).rejects.toThrow('Injected storage get failure')
    expect(harness.alarmState().setAlarmCalls).toBe(armedAtStart + 1)

    // The next tick cleans the (already complete) recovery up.
    await harness.alarm()
    expect(harness.alarmState().keys).not.toContain('resultRecovery')
    await expect(harness.command('bob', { operation: 'reviewResult', sessionId: 'throwing', decision: 'approve' }))
      .resolves.toMatchObject({ success: true })
    expect(resultStatus(readMatchScore(session.matchScore)!)).toBe('final')
  })

  it('A4: two alarm deliveries for the same poll recovery apply exactly once', async () => {
    const harness = createHarness()
    const pollId = await openPoll(harness)
    harness.failMutation(2)
    await expect(harness.command('host', { operation: 'finalizePoll', sessionId: 'poll-session', pollId, optionId: 'sat' }))
      .resolves.toMatchObject({ success: false })
    await Promise.all([harness.alarm(), harness.alarm()])
    const session = harness.sessions.get('poll-session')!.data
    expect(session.startsAt).toBe('2030-01-05T18:00:00.000Z')
    expect(session.scheduleRevision).toBe(1)
    expect(harness.polls.get(pollId)!.data.status).toBe('finalized')
    expect([...harness.notifications.values()].filter(row => row.data.type === 'schedule_changed')).toHaveLength(2)
    expect(harness.alarmState().keys).not.toContain('pollRecovery')
    expect(harness.alarmState().armedAlarm).toBeNull()
  })

  it('A4b: two room instances sharing storage (failover overlap) still apply a poll recovery exactly once', async () => {
    const harness = createHarness()
    const pollId = await openPoll(harness)
    harness.failMutation(2)
    await expect(harness.command('host', { operation: 'finalizePoll', sessionId: 'poll-session', pollId, optionId: 'sat' }))
      .resolves.toMatchObject({ success: false })
    const second = harness.secondRoom()
    await Promise.all([harness.alarm(), harness.alarmOn(second)])
    const session = harness.sessions.get('poll-session')!.data
    expect(session.startsAt).toBe('2030-01-05T18:00:00.000Z')
    expect(session.scheduleRevision).toBe(1)
    expect(harness.polls.get(pollId)!.data.status).toBe('finalized')
    expect([...harness.notifications.values()].filter(row => row.data.type === 'schedule_changed')).toHaveLength(2)
    expect(harness.alarmState().keys).not.toContain('pollRecovery')
  })

  it('A5: a failed recovery-key delete replays idempotently on the next tick', async () => {
    const harness = createHarness()
    const pollId = await openPoll(harness)
    harness.failMutation(2)
    await expect(harness.command('host', { operation: 'finalizePoll', sessionId: 'poll-session', pollId, optionId: 'sat' }))
      .resolves.toMatchObject({ success: false })
    harness.failStorageDelete(1)
    await expect(harness.alarm()).rejects.toThrow('Injected storage delete failure')
    // The replay itself completed; only the key cleanup failed.
    expect(harness.polls.get(pollId)!.data.status).toBe('finalized')
    expect(harness.sessions.get('poll-session')!.data.scheduleRevision).toBe(1)
    expect([...harness.notifications.values()].filter(row => row.data.type === 'schedule_changed')).toHaveLength(2)
    expect(harness.alarmState().keys).toContain('pollRecovery')
    // The next tick sees a finalized poll, deletes the key, and stops.
    await harness.alarm()
    expect([...harness.notifications.values()].filter(row => row.data.type === 'schedule_changed')).toHaveLength(2)
    expect(harness.sessions.get('poll-session')!.data.scheduleRevision).toBe(1)
    expect(harness.alarmState().keys).not.toContain('pollRecovery')
    expect(harness.alarmState().armedAlarm).toBeNull()
  })
})

describe('Stale operations and eviction double-apply', () => {
  it('B1: an RSVP retried after eviction applies exactly once', async () => {
    const harness = createHarness()
    harness.addSession('evict-rsvp', 'host')
    await expect(harness.command('player', { operation: 'rsvp', sessionId: 'evict-rsvp', status: 'going' }))
      .resolves.toMatchObject({ success: true })
    harness.restart()
    await expect(harness.command('player', { operation: 'rsvp', sessionId: 'evict-rsvp', status: 'going' }))
      .resolves.toMatchObject({ success: true })
    expect(harness.rsvps.size).toBe(1)
  })

  it('B2: a scorePoint retried after eviction fails cleanly with no double-apply', async () => {
    const harness = createHarness()
    const session = await startSingles(harness, 'evict-point', ['alice', 'bob'])
    const revision = readMatchScore(session.matchScore)!.revision
    await expect(harness.command('host', { operation: 'scorePoint', sessionId: 'evict-point', side: 0, revision }))
      .resolves.toMatchObject({ success: true })
    // sets holds completed sets only; the in-progress set is in points.
    expect(readMatchScore(session.matchScore)!.points).toEqual([1, 0])
    expect(readMatchScore(session.matchScore)!.revision).toBe(revision + 1)
    harness.restart()
    // The client retries with the stale revision it saw before eviction.
    await expect(harness.command('host', { operation: 'scorePoint', sessionId: 'evict-point', side: 0, revision }))
      .resolves.toMatchObject({ success: false })
    expect(readMatchScore(session.matchScore)!.points).toEqual([1, 0])
    // A fresh retry with the current revision still works.
    const current = readMatchScore(session.matchScore)!.revision
    await expect(harness.command('host', { operation: 'scorePoint', sessionId: 'evict-point', side: 0, revision: current }))
      .resolves.toMatchObject({ success: true })
    expect(readMatchScore(session.matchScore)!.points).toEqual([2, 0])
  })

  it('B3: a startMatch retried after eviction fails cleanly and keeps one scoreboard', async () => {
    const harness = createHarness()
    const session = await startSingles(harness, 'evict-start', ['alice', 'bob'])
    const before = session.matchScore
    harness.restart()
    await expect(harness.command('host', {
      operation: 'startMatch', sessionId: 'evict-start', teams: [['alice'], ['bob']],
    })).resolves.toMatchObject({ success: false, error: 'This session already has a scoreboard.' })
    expect(session.matchScore).toBe(before)
  })

  it('B4: a cancel retried after eviction succeeds once and notifies once', async () => {
    const harness = createHarness()
    harness.addSession('evict-cancel', 'host')
    await expect(harness.command('alice', { operation: 'rsvp', sessionId: 'evict-cancel', status: 'going' }))
      .resolves.toMatchObject({ success: true })
    await expect(harness.command('host', { operation: 'cancel', sessionId: 'evict-cancel' }))
      .resolves.toMatchObject({ success: true })
    expect([...harness.notifications.values()].filter(row => row.data.type === 'session_cancelled')).toHaveLength(1)
    harness.restart()
    await expect(harness.command('host', { operation: 'cancel', sessionId: 'evict-cancel' }))
      .resolves.toMatchObject({ success: true })
    expect(harness.sessions.get('evict-cancel')!.data.status).toBe('cancelled')
    expect([...harness.notifications.values()].filter(row => row.data.type === 'session_cancelled')).toHaveLength(1)
  })
})

describe('Process restart and interrupted finalization', () => {
  it('C1: a finalization interrupted mid-write resumes exactly once after eviction + alarm', async () => {
    const harness = createHarness()
    const session = await startSingles(harness, 'interrupt-final', ['alice', 'bob'])
    decideScore(session)
    await expect(harness.command('alice', { operation: 'reviewResult', sessionId: 'interrupt-final', decision: 'approve' }))
      .resolves.toMatchObject({ success: true })
    // Bob's approval finalizes. Mutation 1 arms pendingResult, mutation 2
    // writes Alice's matchResults row, mutation 3 (Bob's row) fails.
    harness.failMutation(3)
    await expect(harness.command('bob', { operation: 'reviewResult', sessionId: 'interrupt-final', decision: 'approve' }))
      .resolves.toMatchObject({ success: false })
    expect(session.pendingResult).toBeTruthy()
    const rows = harness.resultRows.get('matchResults')!
    expect(rows.size).toBe(1)
    expect(harness.resultRows.get('resultAudits')!.size).toBe(0)
    expect(resultStatus(readMatchScore(session.matchScore)!)).toBe('confirmed')

    // Evict the room, then let the alarm replay the stored command.
    harness.restart()
    await harness.alarm()
    expect(session.pendingResult).toBe('')
    expect(resultStatus(readMatchScore(session.matchScore)!)).toBe('final')
    expect(rows.size).toBe(2)
    const revision = readMatchScore(session.matchScore)!.revision
    for (const row of rows.values()) {
      expect(row.data.resultRevision).toBe(revision)
    }
    expect([...rows.values()].map(row => row.data.userId).sort()).toEqual(['alice', 'bob'])
    const audits = [...harness.resultRows.get('resultAudits')!.values()]
    expect(audits).toHaveLength(1)
    expect(audits[0].data.kind).toBe('finalized')
    expect(harness.alarmState().keys).not.toContain('resultRecovery')
    // A second alarm tick is a no-op: nothing is re-applied.
    await harness.alarm()
    expect(rows.size).toBe(2)
    expect(harness.resultRows.get('resultAudits')!.size).toBe(1)
  })
})

describe('Bounded memory and retries', () => {
  it('D1: durable storage keys stay O(1) under load — no per-user or per-RSVP state', async () => {
    const harness = createHarness()
    harness.addSession('load', 'host')
    for (let i = 0; i < 300; i++) {
      const result = await harness.command(`user-${i}`, { operation: 'rsvp', sessionId: 'load', status: 'going' })
      expect(result.success).toBe(true)
    }
    expect(harness.rsvps.size).toBe(300)
    const pollId = await openPoll(harness)
    for (let i = 0; i < 60; i++) {
      const userId = `voter-${i}`
      await expect(harness.command(userId, { operation: 'rsvp', sessionId: 'poll-session', status: 'going' }))
        .resolves.toMatchObject({ success: true })
      await expect(harness.command(userId, { operation: 'castVote', sessionId: 'poll-session', pollId, optionId: 'sat' }))
        .resolves.toMatchObject({ success: true })
    }
    expect(harness.pollVotes.size).toBe(60)
    await expect(harness.command('host', { operation: 'finalizePoll', sessionId: 'poll-session', pollId, optionId: 'sat' }))
      .resolves.toMatchObject({ success: true })

    // Only the two recovery keys are ever stored; nothing per user.
    expect(harness.putKeys.every(key => key === 'pollRecovery' || key === 'resultRecovery')).toBe(true)
    expect(harness.alarmState().keys).toEqual(['pollRecovery'])
    expect(harness.alarmState().armedAlarm).not.toBeNull()
    // One alarm tick cleans the (now complete) recovery up; nothing re-arms.
    await harness.alarm()
    expect(harness.alarmState().keys).toEqual([])
    expect(harness.alarmState().armedAlarm).toBeNull()
    // The room is still healthy afterwards.
    await expect(harness.command('late-user', { operation: 'rsvp', sessionId: 'load', status: 'going' }))
      .resolves.toMatchObject({ success: true })
    // 300 load RSVPs + 3 poll-session RSVPs from openPoll + 60 voters + 1.
    expect(harness.rsvps.size).toBe(364)
  }, 30_000)
})

describe('pendingResult liveness', () => {
  it('E1: a direct time edit during poll finalization unblocks instead of bricking the poll', async () => {
    const harness = createHarness()
    const pollId = await openPoll(harness)
    // Fail mutation 2 (the session time write): the poll is left
    // 'finalizing' with the recovery key armed.
    harness.failMutation(2)
    await expect(harness.command('host', { operation: 'finalizePoll', sessionId: 'poll-session', pollId, optionId: 'sat' }))
      .resolves.toMatchObject({ success: false })
    expect(harness.polls.get(pollId)!.data.status).toBe('finalizing')
    expect(harness.alarmState().keys).toContain('pollRecovery')

    // A member directly edits the session time (startsAt is
    // member-writable) while the finalize is in flight.
    harness.editSessionDirect('poll-session', { startsAt: '2030-01-03T18:00:00.000Z' })

    // The finalize is still abandoned — the edit wins — and the error is
    // unchanged, but the poll is reopened instead of left 'finalizing'.
    await expect(harness.command('host', { operation: 'finalizePoll', sessionId: 'poll-session', pollId, optionId: 'sat' }))
      .resolves.toMatchObject({ success: false, error: 'The session was edited during poll finalization. Its time was preserved.' })
    expect(harness.polls.get(pollId)!.data.status).toBe('open')
    // The host can now cancel the poll, and the session can be cancelled.
    await expect(harness.command('host', { operation: 'cancelPoll', sessionId: 'poll-session', pollId }))
      .resolves.toMatchObject({ success: true })
    await expect(harness.command('host', { operation: 'cancel', sessionId: 'poll-session' }))
      .resolves.toMatchObject({ success: true })
    // One alarm tick clears the (now complete) recovery key and stops.
    await harness.alarm()
    expect(harness.alarmState().keys).not.toContain('pollRecovery')
    expect(harness.alarmState().armedAlarm).toBeNull()
  })
})
