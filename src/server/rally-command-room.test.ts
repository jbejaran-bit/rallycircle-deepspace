import { canCreate, canDelete, canUpdate, checkFieldPermissions } from 'deepspace/worker'
import type { ActionTools } from 'deepspace/worker'
import { describe, expect, it } from 'vitest'
import { rsvpsSchema, sessionsSchema, waitlistsSchema } from '../schemas/rally-schema.js'
import type { RallyRSVP, RallySession, RallyWaitlist, RSVPStatus } from '../lib/rally.js'
import type { Env } from '../../worker.js'
import { awardPoint, createMatchScore, readMatchScore, resultStatus } from '../lib/rally-score.js'
import { rallyCommandAction, RallyCommandRoom } from './rally-command-room.js'

function createHarness() {
  const sessions = new Map<string, { recordId: string; createdBy: string; data: RallySession }>()
  const rsvps = new Map<string, { recordId: string; createdBy: string; data: RallyRSVP }>()
  const waitlists = new Map<string, { recordId: string; data: RallyWaitlist }>()
  let nextRecordId = 0
  let failNextQueueDelete = false

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

      if (tool === 'records.create' && params.collection === 'waitlists') {
        const { sessionId } = params.data as { sessionId: string }
        const userId = request.headers.get('X-User-Id') ?? ''
        const recordId = `waiting-${++nextRecordId}`
        waitlists.set(recordId, { recordId, data: { sessionId, userId } })
        return Response.json({ success: true, data: { recordId } })
      }

      if (tool === 'records.delete' && (params.collection === 'rsvps' || params.collection === 'waitlists')) {
        if (params.collection === 'waitlists' && failNextQueueDelete) {
          failNextQueueDelete = false
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
    addSession, command, rsvps, sessions, waitlists,
    interruptQueueCleanup: () => { failNextQueueDelete = true },
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

  it('repairs an interrupted promotion without duplicate spots or queue jumping', async () => {
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
    harness.interruptQueueCleanup()
    expect((await act('guest', 'withdraw')).success).toBe(true)
    expect(harness.waitlists.size).toBe(2)
    expect((await act('outsider', 'rsvp', 'going')).success).toBe(false)
    expect([...harness.waitlists.values()].map(row => row.data.userId)).toEqual(['second'])
    expect((await act('first', 'withdraw')).success).toBe(true)
    expect([...harness.rsvps.values()].map(row => row.data.userId).sort()).toEqual(['host', 'second'])
    expect(harness.waitlists.size).toBe(0)
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
