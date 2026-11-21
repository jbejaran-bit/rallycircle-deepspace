import { canCreate, canDelete, canRead, canUpdate, checkFieldPermissions } from 'deepspace/worker'
import type { ActionTools } from 'deepspace/worker'
import { describe, expect, it } from 'vitest'
import { rsvpsSchema, sessionsSchema, waitlistsSchema } from '../schemas/rally-schema.js'
import type { RallyRSVP, RallySession, RallyWaitlist, RSVPStatus } from '../lib/rally.js'
import type { Env } from '../../worker.js'
import { awardPoint, createMatchScore, isEligibleForStats, readMatchScore, resultStatus } from '../lib/rally-score.js'
import { rallyCommandAction, RallyCommandRoom } from './rally-command-room.js'

function createHarness() {
  const sessions = new Map<string, { recordId: string; createdBy: string; data: RallySession }>()
  const rsvps = new Map<string, { recordId: string; createdBy: string; createdAt: number; data: RallyRSVP }>()
  const waitlists = new Map<string, { recordId: string; createdAt: number; data: RallyWaitlist }>()
  let nextRecordId = 0
  let nextCreatedAt = 0
  let failQueueDeletes = 0

  // The real RecordRoom honours orderBy/orderDir/limit (SDK worker.js
  // orderColumn maps createdAt to _created_at). The harness must do the
  // same, otherwise FIFO tests pass vacuously even with a wrong sort.
  function applyQueryOrder<T extends { createdAt: number }>(rows: T[], params: Record<string, unknown>): T[] {
    const ordered = [...rows]
    if (params.orderBy === 'createdAt') {
      ordered.sort((a, b) => params.orderDir === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt)
    }
    return typeof params.limit === 'number' ? ordered.slice(0, params.limit) : ordered
  }

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

      if (tool === 'records.create' && params.collection === 'waitlists') {
        const { sessionId } = params.data as { sessionId: string }
        const userId = request.headers.get('X-User-Id') ?? ''
        const recordId = `waiting-${++nextRecordId}`
        waitlists.set(recordId, { recordId, createdAt: ++nextCreatedAt, data: { sessionId, userId } })
        return Response.json({ success: true, data: { recordId } })
      }

      if (tool === 'records.delete' && (params.collection === 'rsvps' || params.collection === 'waitlists')) {
        if (params.collection === 'waitlists' && failQueueDeletes > 0) {
          failQueueDeletes--
          return Response.json({ success: false, error: 'Temporary delete failure' })
        }
        const collection = params.collection === 'rsvps' ? rsvps : waitlists
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

  return {
    addSession, command, room, rsvps, sessions, waitlists,
    interruptQueueCleanup: (times = 1) => { failQueueDeletes = times },
  }
}

describe('RallyCircle server-side session and RSVP rules', () => {
  it('rejects unmarked room requests and preserves authorized command dispatch', async () => {
    const harness = createHarness()
    harness.addSession('workout', 'host')
    for (const headers of [new Headers(), new Headers({ 'X-App-Action': 'false' })]) {
      const response = await harness.room.fetch(new Request('https://internal/rally-command', {
        method: 'POST', headers,
        body: JSON.stringify({ operation: 'cancel', sessionId: 'workout', userId: 'host' }),
      }))
      expect(response.status).toBe(400)
      expect(harness.sessions.get('workout')?.data.status).toBe('open')
    }
    const unmarkedGeocode = await harness.room.fetch(new Request('https://internal/geocode', {
      method: 'POST', body: 'Pittsburgh',
    }))
    expect(unmarkedGeocode.status).toBe(400)
    await expect(harness.command('other-player', { operation: 'cancel', sessionId: 'workout', userId: 'host' }))
      .resolves.toMatchObject({ success: false })
    await expect(harness.command('host', { operation: 'cancel', sessionId: 'workout' }))
      .resolves.toMatchObject({ success: true })
  })

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

  it('allows withdrawal and waitlist cleanup when stored capacity is invalid without promoting', async () => {
    const harness = createHarness()
    const sessionId = 'legacy-capacity'
    harness.addSession(sessionId, 'host')
    const session = harness.sessions.get(sessionId)!.data
    session.capacity = 2
    for (const user of ['host', 'player']) {
      await expect(harness.command(user, { operation: 'rsvp', sessionId, status: 'going' }))
        .resolves.toMatchObject({ success: true })
    }
    await expect(harness.command('queued', { operation: 'joinWaitlist', sessionId }))
      .resolves.toMatchObject({ success: true })
    session.capacity = 0
    await expect(harness.command('player', { operation: 'withdraw', sessionId }))
      .resolves.toMatchObject({ success: true })
    expect([...harness.rsvps.values()].map(row => row.data.userId)).toEqual(['host'])
    await expect(harness.command('other', { operation: 'rsvp', sessionId, status: 'going' }))
      .resolves.toMatchObject({ success: false })
    await expect(harness.command('queued', { operation: 'leaveWaitlist', sessionId }))
      .resolves.toMatchObject({ success: true })
    expect(harness.waitlists.size).toBe(0)
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

/**
 * Track A security + reliability regression suite (K20). Every test here is
 * a negative or concurrency case that must keep passing: forged identities,
 * cross-session edits, cancelled-session writes, queue jumping, duplicate
 * side effects, stale revisions, and withdrawn-participant finalization.
 * Live-runtime items (two-account browser sync, real RecordRoom enforcement)
 * are NOT covered here and are listed as unverified in IMPLEMENTATION_LOG.md.
 */
describe('Track A regression suite — waitlist, scoring and authorization', () => {
  async function cappedSession(capacity = 2) {
    const harness = createHarness()
    harness.addSession('limited', 'host')
    harness.sessions.get('limited')!.data.capacity = capacity
    return harness
  }

  async function startSingles(harness: ReturnType<typeof createHarness>, sessionId: string, players: [string, string], hostId = 'host') {
    harness.addSession(sessionId, hostId)
    const session = harness.sessions.get(sessionId)!.data
    session.format = 'Singles'
    for (const user of players) {
      await expect(harness.command(user, { operation: 'rsvp', sessionId, status: 'going' }))
        .resolves.toMatchObject({ success: true })
    }
    await expect(harness.command(hostId, { operation: 'startMatch', sessionId, teams: [[players[0]], [players[1]]] }))
      .resolves.toMatchObject({ success: true })
    return session
  }

  it('A01: five simultaneous joins at cap 2 admit exactly two, queue the rest in order, and promote on withdrawal', async () => {
    const harness = await cappedSession(2)
    const users = ['a', 'b', 'c', 'd', 'e']
    const joins = await Promise.all(users.map(user =>
      harness.command(user, { operation: 'rsvp', sessionId: 'limited', status: 'going' })))
    expect(joins.filter(result => result.success)).toHaveLength(2)
    expect(joins.filter(result => !result.success)).toHaveLength(3)
    for (const result of joins.filter(result => !result.success)) {
      expect(result).toMatchObject({ error: 'This session is full. You can join the waitlist.' })
    }
    const going = [...harness.rsvps.values()].filter(row => row.data.status === 'going').map(row => row.data.userId).sort()
    expect(going).toHaveLength(2)

    const losers = users.filter(user => !going.includes(user))
    const queued = await Promise.all(losers.map(user =>
      harness.command(user, { operation: 'joinWaitlist', sessionId: 'limited' })))
    expect(queued.every(result => result.success)).toBe(true)
    expect(harness.waitlists.size).toBe(3)
    // Queue order follows join order, not record-id order.
    expect([...harness.waitlists.values()].map(row => row.data.userId)).toEqual(losers)

    const [winner] = going
    expect((await harness.command(winner, { operation: 'withdraw', sessionId: 'limited' })).success).toBe(true)
    expect([...harness.rsvps.values()].filter(row => row.data.status === 'going')).toHaveLength(2)
    expect([...harness.rsvps.values()].find(row => row.data.userId === losers[0])?.data.status).toBe('going')
    expect([...harness.waitlists.values()].map(row => row.data.userId)).toEqual(losers.slice(1))
  })

  it('A01: concurrent withdraw-then-join and join-then-withdraw both end in one consistent state', async () => {
    const first = await cappedSession(2)
    for (const user of ['host', 'guest']) {
      await expect(first.command(user, { operation: 'rsvp', sessionId: 'limited', status: 'going' })).resolves.toMatchObject({ success: true })
    }
    await expect(first.command('first', { operation: 'joinWaitlist', sessionId: 'limited' })).resolves.toMatchObject({ success: true })
    const [withdrawn, joined] = await Promise.all([
      first.command('guest', { operation: 'withdraw', sessionId: 'limited' }),
      first.command('second', { operation: 'rsvp', sessionId: 'limited', status: 'going' }),
    ])
    expect(withdrawn.success).toBe(true)
    // Correct fairness: the waitlisted player has priority over a new
    // joiner, so the freed spot goes to 'first' and 'second' is told the
    // session is full — even though the join raced the withdrawal.
    expect(joined.success).toBe(false)
    expect(joined).toMatchObject({ error: 'This session is full. You can join the waitlist.' })
    expect([...first.rsvps.values()].filter(row => row.data.status === 'going').map(row => row.data.userId).sort())
      .toEqual(['first', 'host'].sort())
    expect(first.waitlists.size).toBe(0)

    const second = await cappedSession(2)
    for (const user of ['host', 'guest']) {
      await expect(second.command(user, { operation: 'rsvp', sessionId: 'limited', status: 'going' })).resolves.toMatchObject({ success: true })
    }
    await expect(second.command('first', { operation: 'joinWaitlist', sessionId: 'limited' })).resolves.toMatchObject({ success: true })
    const [rejected, withdrawn2] = await Promise.all([
      second.command('second', { operation: 'rsvp', sessionId: 'limited', status: 'going' }),
      second.command('guest', { operation: 'withdraw', sessionId: 'limited' }),
    ])
    expect(rejected.success).toBe(false)
    expect(withdrawn2.success).toBe(true)
    // The withdrawal still promotes the waiter, even though the join lost the race.
    expect([...second.rsvps.values()].filter(row => row.data.status === 'going').map(row => row.data.userId).sort())
      .toEqual(['first', 'host'].sort())
    expect(second.waitlists.size).toBe(0)
  })

  it('A01: concurrent cancellations are idempotent and concurrent duplicate waitlist joins collapse to one row', async () => {
    const harness = await cappedSession(2)
    const cancels = await Promise.all([
      harness.command('host', { operation: 'cancel', sessionId: 'limited' }),
      harness.command('host', { operation: 'cancel', sessionId: 'limited' }),
    ])
    expect(cancels.every(result => result.success)).toBe(true)
    expect(harness.sessions.get('limited')?.data.status).toBe('cancelled')

    const open = await cappedSession(2)
    // The session must be full before anyone may join the waitlist: with a
    // free spot the honest answer is "choose Going".
    for (const user of ['host', 'guest']) {
      await expect(open.command(user, { operation: 'rsvp', sessionId: 'limited', status: 'going' })).resolves.toMatchObject({ success: true })
    }
    const joins = await Promise.all([
      open.command('first', { operation: 'joinWaitlist', sessionId: 'limited' }),
      open.command('first', { operation: 'joinWaitlist', sessionId: 'limited' }),
      open.command('first', { operation: 'joinWaitlist', sessionId: 'limited' }),
    ])
    expect(joins.every(result => result.success)).toBe(true)
    expect(open.waitlists.size).toBe(1)
  })

  it('A03: promotion follows createdAt order even when rows were stored out of order, and rejoining forfeits position', async () => {
    const harness = await cappedSession(2)
    for (const user of ['host', 'guest']) {
      await expect(harness.command(user, { operation: 'rsvp', sessionId: 'limited', status: 'going' })).resolves.toMatchObject({ success: true })
    }
    // Join in one order, then shuffle the stored creation stamps: the
    // queue must promote by createdAt, not by insertion order. (A later
    // rejoin gets a fresh, largest stamp from the harness counter, as a
    // real timestamp would.)
    for (const user of ['late', 'early', 'mid']) {
      expect((await harness.command(user, { operation: 'joinWaitlist', sessionId: 'limited' })).success).toBe(true)
    }
    for (const [userId, stamp] of [['late', 5], ['early', 3], ['mid', 4]] as const) {
      const row = [...harness.waitlists.values()].find(row => row.data.userId === userId)!
      row.createdAt = stamp
    }
    expect((await harness.command('guest', { operation: 'withdraw', sessionId: 'limited' })).success).toBe(true)
    expect([...harness.rsvps.values()].find(row => row.data.userId === 'early')?.data.status).toBe('going')
    const byAge = <T extends { createdAt: number }>(rows: T[]): T[] => [...rows].sort((a, b) => a.createdAt - b.createdAt)
    expect(byAge([...harness.waitlists.values()]).map(row => row.data.userId)).toEqual(['mid', 'late'])

    // Leaving and rejoining puts the user at the back of the queue.
    expect((await harness.command('mid', { operation: 'leaveWaitlist', sessionId: 'limited' })).success).toBe(true)
    expect((await harness.command('mid', { operation: 'joinWaitlist', sessionId: 'limited' })).success).toBe(true)
    expect(byAge([...harness.waitlists.values()]).map(row => row.data.userId)).toEqual(['late', 'mid'])
  })

  it('A04: RSVP retries and double withdrawals are idempotent', async () => {
    const harness = await cappedSession()
    const first = await harness.command('player', { operation: 'rsvp', sessionId: 'limited', status: 'going' })
    const retry = await harness.command('player', { operation: 'rsvp', sessionId: 'limited', status: 'going' })
    expect(first.success).toBe(true)
    expect(retry.success).toBe(true)
    expect(harness.rsvps.size).toBe(1)
    if (first.success && retry.success) {
      expect((first.data as { recordId: string }).recordId).toBe((retry.data as { recordId: string }).recordId)
    }
    expect((await harness.command('player', { operation: 'withdraw', sessionId: 'limited' })).success).toBe(true)
    expect((await harness.command('player', { operation: 'withdraw', sessionId: 'limited' })).success).toBe(true)
    expect(harness.rsvps.size).toBe(0)
    expect((await harness.command('player', { operation: 'leaveWaitlist', sessionId: 'limited' })).success).toBe(true)
  })

  it('A05: host cancellation blocks participation, promotion and score changes, but allows cleanup', async () => {
    const harness = await cappedSession(2)
    for (const user of ['host', 'guest']) {
      await expect(harness.command(user, { operation: 'rsvp', sessionId: 'limited', status: 'going' })).resolves.toMatchObject({ success: true })
    }
    await expect(harness.command('first', { operation: 'joinWaitlist', sessionId: 'limited' })).resolves.toMatchObject({ success: true })
    const session = await startSingles(harness, 'played', ['alice', 'bob'])
    await expect(harness.command('host', { operation: 'scorePoint', sessionId: 'played', side: 0, revision: 0 }))
      .resolves.toMatchObject({ success: true })
    expect((await harness.command('host', { operation: 'cancel', sessionId: 'played' })).success).toBe(true)
    expect((await harness.command('host', { operation: 'cancel', sessionId: 'limited' })).success).toBe(true)

    await expect(harness.command('second', { operation: 'rsvp', sessionId: 'limited', status: 'going' }))
      .resolves.toMatchObject({ success: false, error: 'This session is not open for responses.' })
    await expect(harness.command('second', { operation: 'joinWaitlist', sessionId: 'limited' }))
      .resolves.toMatchObject({ success: false })
    await expect(harness.command('host', { operation: 'scorePoint', sessionId: 'played', side: 0, revision: 1 }))
      .resolves.toMatchObject({ success: false, error: 'This session is closed.' })
    await expect(harness.command('alice', { operation: 'reviewResult', sessionId: 'played', decision: 'approve' }))
      .resolves.toMatchObject({ success: false })
    await expect(harness.command('host', { operation: 'startMatch', sessionId: 'played', teams: [['alice'], ['bob']] }))
      .resolves.toMatchObject({ success: false })
    // Promotion must not run on a cancelled session, and cleanup still works.
    expect([...harness.waitlists.values()].map(row => row.data.userId)).toEqual(['first'])
    expect((await harness.command('guest', { operation: 'withdraw', sessionId: 'limited' })).success).toBe(true)
    expect([...harness.waitlists.values()].map(row => row.data.userId)).toEqual(['first'])
    expect((await harness.command('first', { operation: 'leaveWaitlist', sessionId: 'limited' })).success).toBe(true)
    expect(harness.waitlists.size).toBe(0)
    expect(readMatchScore(session.matchScore)).toMatchObject({ revision: 1 })
  })

  it('A06: a non-host attendee going tentative promotes only the first waiter', async () => {
    const harness = await cappedSession(2)
    for (const user of ['host', 'guest']) {
      await expect(harness.command(user, { operation: 'rsvp', sessionId: 'limited', status: 'going' })).resolves.toMatchObject({ success: true })
    }
    for (const user of ['first', 'second']) {
      await expect(harness.command(user, { operation: 'joinWaitlist', sessionId: 'limited' })).resolves.toMatchObject({ success: true })
    }
    expect((await harness.command('guest', { operation: 'rsvp', sessionId: 'limited', status: 'maybe' })).success).toBe(true)
    expect([...harness.rsvps.values()].filter(row => row.data.status === 'going').map(row => row.data.userId).sort())
      .toEqual(['first', 'host'].sort())
    expect([...harness.waitlists.values()].map(row => row.data.userId)).toEqual(['second'])

    // Downgrading with an empty queue changes nothing else.
    const empty = await cappedSession(2)
    for (const user of ['host', 'guest']) {
      await expect(empty.command(user, { operation: 'rsvp', sessionId: 'limited', status: 'going' })).resolves.toMatchObject({ success: true })
    }
    expect((await empty.command('guest', { operation: 'rsvp', sessionId: 'limited', status: 'maybe' })).success).toBe(true)
    expect([...empty.rsvps.values()].filter(row => row.data.status === 'going')).toHaveLength(1)
    expect(empty.waitlists.size).toBe(0)
  })

  it('A07: a forged userId cannot withdraw, waitlist or cancel as someone else', async () => {
    const harness = await cappedSession(2)
    for (const user of ['host', 'player']) {
      await expect(harness.command(user, { operation: 'rsvp', sessionId: 'limited', status: 'going' })).resolves.toMatchObject({ success: true })
    }
    // The action builds the command from the verified caller, so the
    // supplied userId is ignored: this withdraws the caller's own RSVP.
    expect((await harness.command('player', { operation: 'withdraw', sessionId: 'limited', userId: 'host' })).success).toBe(true)
    expect([...harness.rsvps.values()].map(row => row.data.userId)).toEqual(['host'])
    expect((await harness.command('player', { operation: 'cancel', sessionId: 'limited', userId: 'host' })).success).toBe(false)
    expect(harness.sessions.get('limited')?.data.status).toBe('open')
    // The withdrawal freed a spot, so fill it before testing the waitlist:
    // joining a waitlist with a free spot is honestly refused.
    expect((await harness.command('guest', { operation: 'rsvp', sessionId: 'limited', status: 'going' })).success).toBe(true)
    expect((await harness.command('player', { operation: 'joinWaitlist', sessionId: 'limited', userId: 'other' })).success).toBe(true)
    expect([...harness.waitlists.values()].map(row => row.data.userId)).toEqual(['player'])
    expect((await harness.command('other', { operation: 'leaveWaitlist', sessionId: 'limited' })).success).toBe(true)
    expect(harness.waitlists.size).toBe(1)
  })

  it('A08: waitlist rows are readable only by their owner (and admins); errors never name other users', async () => {
    const own = { data: { sessionId: 'limited', userId: 'player' }, createdBy: 'player', recordId: 'w1' }
    const other = { data: { sessionId: 'limited', userId: 'someone-else' }, createdBy: 'someone-else', recordId: 'w2' }
    expect(canRead(waitlistsSchema, 'member', own, 'player')).toBe(true)
    expect(canRead(waitlistsSchema, 'member', other, 'player')).toBe(false)
    expect(canRead(waitlistsSchema, 'anonymous', own, 'player')).toBe(false)
    expect(canRead(waitlistsSchema, 'admin', other, 'admin')).toBe(true)
    expect(canRead(rsvpsSchema, 'member', { data: { sessionId: 'limited', userId: 'player', status: 'going' }, createdBy: 'player', recordId: 'r1' }, 'player')).toBe(true)

    const harness = await cappedSession(2)
    for (const user of ['host', 'guest']) {
      await expect(harness.command(user, { operation: 'rsvp', sessionId: 'limited', status: 'going' })).resolves.toMatchObject({ success: true })
    }
    const full = await harness.command('outsider', { operation: 'rsvp', sessionId: 'limited', status: 'going' })
    expect(full.success).toBe(false)
    if (!full.success) {
      expect(full.error).not.toContain('host')
      expect(full.error).not.toContain('guest')
    }
  })

  it('A09: ten simultaneous score writes at one revision admit exactly one winner; sequential fresh revisions all land', async () => {
    const harness = createHarness()
    const session = await startSingles(harness, 'race', ['alice', 'bob'])
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => harness.command('host', { operation: 'scorePoint', sessionId: 'race', side: 0, revision: 0 })),
    )
    expect(attempts.filter(result => result.success)).toHaveLength(1)
    expect(attempts.filter(result => !result.success)).toHaveLength(9)
    expect(readMatchScore(session.matchScore)).toMatchObject({ revision: 1, points: [1, 0] })

    for (let point = 0; point < 3; point++) {
      const current = readMatchScore(session.matchScore)!
      await expect(harness.command('host', { operation: 'scorePoint', sessionId: 'race', side: 1, revision: current.revision }))
        .resolves.toMatchObject({ success: true })
    }
    expect(readMatchScore(session.matchScore)).toMatchObject({ revision: 4, points: [1, 3] })
    await expect(harness.command('host', { operation: 'scorePoint', sessionId: 'race', side: 0, revision: 0 }))
      .resolves.toMatchObject({ success: false, error: 'The score changed. Check the latest score before trying again.' })
  })

  it('A10: malformed identities, revisions and teams are rejected; cross-session score edits are rejected', async () => {
    const harness = createHarness()
    const session = await startSingles(harness, 'a', ['alice', 'bob'])
    await startSingles(harness, 'b', ['carol', 'dave'], 'hostB')
    expect(session).toBeDefined()

    expect((await harness.command('', { operation: 'rsvp', sessionId: 'a', status: 'going' })).success).toBe(false)
    expect((await harness.command(123 as unknown as string, { operation: 'rsvp', sessionId: 'a', status: 'going' })).success).toBe(false)
    expect((await harness.command('player', { operation: 'rsvp', sessionId: '', status: 'going' })).success).toBe(false)
    expect((await harness.command('player', { operation: 'rsvp', sessionId: 'x'.repeat(201), status: 'going' })).success).toBe(false)
    expect((await harness.command('host', { operation: 'scorePoint', sessionId: 'a', side: 2, revision: 0 })).success).toBe(false)
    expect((await harness.command('host', { operation: 'scorePoint', sessionId: 'a', side: 0, revision: -1 })).success).toBe(false)
    expect((await harness.command('host', { operation: 'scorePoint', sessionId: 'a', side: 0, revision: 1.5 })).success).toBe(false)
    // Host of session A cannot score session B, and vice versa.
    expect((await harness.command('host', { operation: 'scorePoint', sessionId: 'b', side: 0, revision: 0 })).success).toBe(false)
    await expect(harness.command('host', { operation: 'scorePoint', sessionId: 'a', side: 0, revision: 0 }))
      .resolves.toMatchObject({ success: true })
    // A withdraw on a session with no RSVP is an idempotent no-op and
    // leaves the other session's RSVP untouched.
    expect((await harness.command('alice', { operation: 'withdraw', sessionId: 'b' })).success).toBe(true)
    expect([...harness.rsvps.values()].filter(row => row.data.sessionId === 'a')).toHaveLength(2)
    // Malformed teams are rejected by schema validation before any write.
    const fresh = createHarness()
    fresh.addSession('c', 'host')
    fresh.sessions.get('c')!.data.format = 'Singles'
    for (const user of ['alice', 'bob']) {
      await expect(fresh.command(user, { operation: 'rsvp', sessionId: 'c', status: 'going' })).resolves.toMatchObject({ success: true })
    }
    for (const teams of [[['alice'], []], [[], ['bob']], [['alice'], ['']], [['alice', 'bob'], ['alice']]] as unknown[][]) {
      expect((await fresh.command('host', { operation: 'startMatch', sessionId: 'c', teams: teams as never })).success).toBe(false)
    }
    expect(fresh.sessions.get('c')!.data.matchScore).toBeUndefined()
  })

  it('A11/A12: a withdrawn participant blocks finalization (fails closed); disputes lock results out of statistics', async () => {
    const harness = createHarness()
    const session = await startSingles(harness, 'final', ['alice', 'bob'])
    let score = readMatchScore(session.matchScore)!
    for (let point = 0; point < 48; point++) score = awardPoint(score, 0)
    session.matchScore = JSON.stringify(score)
    expect(resultStatus(score)).toBe('proposed')
    expect(isEligibleForStats(score)).toBe(false)

    await expect(harness.command('alice', { operation: 'reviewResult', sessionId: 'final', decision: 'approve' }))
      .resolves.toMatchObject({ success: true })
    expect(resultStatus(readMatchScore(session.matchScore)!)).toBe('confirmed')
    expect(isEligibleForStats(readMatchScore(session.matchScore)!)).toBe(false)

    // Bob withdraws and never approves: the result stays unfinalized and
    // ineligible for statistics. This fails closed by design; see
    // IMPLEMENTATION_LOG.md for the waiver follow-up.
    expect((await harness.command('bob', { operation: 'withdraw', sessionId: 'final' })).success).toBe(true)
    expect(resultStatus(readMatchScore(session.matchScore)!)).toBe('confirmed')
    expect(isEligibleForStats(readMatchScore(session.matchScore)!)).toBe(false)

    // A withdrawn participant can still dispute, which locks the result.
    await expect(harness.command('bob', { operation: 'reviewResult', sessionId: 'final', decision: 'dispute' }))
      .resolves.toMatchObject({ success: true })
    const disputed = readMatchScore(session.matchScore)!
    expect(resultStatus(disputed)).toBe('disputed')
    expect(isEligibleForStats(disputed)).toBe(false)
    await expect(harness.command('alice', { operation: 'reviewResult', sessionId: 'final', decision: 'approve' }))
      .resolves.toMatchObject({ success: false })

    // A fully approved result is final and stats-eligible.
    const clean = createHarness()
    const cleanSession = await startSingles(clean, 'clean', ['alice', 'bob'])
    let cleanScore = readMatchScore(cleanSession.matchScore)!
    for (let point = 0; point < 48; point++) cleanScore = awardPoint(cleanScore, 0)
    cleanSession.matchScore = JSON.stringify(cleanScore)
    for (const user of ['alice', 'bob']) {
      await expect(clean.command(user, { operation: 'reviewResult', sessionId: 'clean', decision: 'approve' }))
        .resolves.toMatchObject({ success: true })
    }
    expect(resultStatus(readMatchScore(cleanSession.matchScore)!)).toBe('final')
    expect(isEligibleForStats(readMatchScore(cleanSession.matchScore)!)).toBe(true)
  })

  it('A15: legacy sessions without format, capacity or matchScore keep working', async () => {
    const harness = createHarness()
    // addSession stores only the original fields: no format, capacity or
    // matchScore. Nothing is backfilled.
    harness.addSession('legacy', 'host')
    const stored = harness.sessions.get('legacy')!.data
    expect(stored.format).toBeUndefined()
    expect(stored.capacity).toBeUndefined()
    expect(stored.matchScore).toBeUndefined()

    await expect(harness.command('player', { operation: 'rsvp', sessionId: 'legacy', status: 'going' }))
      .resolves.toMatchObject({ success: true })
    // No capacity means unlimited: joins beyond any target still work.
    for (const user of ['a', 'b', 'c', 'd', 'e', 'f']) {
      await expect(harness.command(user, { operation: 'rsvp', sessionId: 'legacy', status: 'going' }))
        .resolves.toMatchObject({ success: true })
    }
    await expect(harness.command('player', { operation: 'joinWaitlist', sessionId: 'legacy' }))
      .resolves.toMatchObject({ success: false, error: 'This session has no waitlist.' })
    // A match cannot start without a format; the host can set one through
    // the normal member-writable field instead of a migration.
    await expect(harness.command('host', { operation: 'startMatch', sessionId: 'legacy', teams: [['host'], ['player']] }))
      .resolves.toMatchObject({ success: false })
    expect((await harness.command('host', { operation: 'cancel', sessionId: 'legacy' })).success).toBe(true)
    await expect(harness.command('player', { operation: 'rsvp', sessionId: 'legacy', status: 'going' }))
      .resolves.toMatchObject({ success: false })
  })

  it('A17: concurrent commands apply in submission order, so the last queued write wins', async () => {
    const harness = createHarness()
    harness.addSession('order', 'host')
    const [going, maybe] = await Promise.all([
      harness.command('player', { operation: 'rsvp', sessionId: 'order', status: 'going' }),
      harness.command('player', { operation: 'rsvp', sessionId: 'order', status: 'maybe' }),
    ])
    expect(going.success).toBe(true)
    expect(maybe.success).toBe(true)
    expect([...harness.rsvps.values()]).toHaveLength(1)
    expect([...harness.rsvps.values()][0].data.status).toBe('maybe')

    const reversed = createHarness()
    reversed.addSession('order', 'host')
    const [maybeFirst, goingSecond] = await Promise.all([
      reversed.command('player', { operation: 'rsvp', sessionId: 'order', status: 'maybe' }),
      reversed.command('player', { operation: 'rsvp', sessionId: 'order', status: 'going' }),
    ])
    expect(maybeFirst.success).toBe(true)
    expect(goingSecond.success).toBe(true)
    expect([...reversed.rsvps.values()][0].data.status).toBe('going')
  })
})
