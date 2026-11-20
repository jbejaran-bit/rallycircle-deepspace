import { canCreate, canDelete, canUpdate, checkFieldPermissions } from 'deepspace/worker'
import type { ActionTools } from 'deepspace/worker'
import { describe, expect, it } from 'vitest'
import { rsvpsSchema, sessionsSchema, waitlistsSchema } from '../schemas/rally-schema.js'
import type { RallyRSVP, RallySession, RallyWaitlist } from '../lib/rally.js'
import type { Env } from '../../worker.js'
import { rallyCommandAction, RallyCommandRoom } from './rally-command-room.js'

function createHarness() {
  const sessions = new Map<string, { recordId: string; createdBy: string; data: RallySession }>()
  const rsvps = new Map<string, { recordId: string; createdBy: string; data: RallyRSVP }>()
  const waitlists = new Map<string, { recordId: string; createdBy: string; createdAt: string; data: RallyWaitlist }>()
  let nextRecordId = 0
  // Monotonic clock: every waitlist row gets a strictly increasing
  // createdAt, mirroring the server-assigned timestamps in production.
  let clock = 0
  const nextCreatedAt = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++clock)).toISOString()

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

      if (tool === 'records.query' && (params.collection === 'rsvps' || params.collection === 'waitlists')) {
        const where = params.where as Record<string, unknown>
        const source: { recordId: string; createdAt?: string; data: unknown }[] =
          params.collection === 'waitlists'
            ? Array.from(waitlists.values())
            : Array.from(rsvps.values())
        const records = source.filter(record =>
          Object.entries(where).every(([key, value]) => (record.data as Record<string, unknown>)[key] === value),
        )
        return Response.json({ success: true, data: { records, count: records.length } })
      }

      if (tool === 'records.create' && params.collection === 'waitlists') {
        const data = params.data as { sessionId: string }
        const userId = request.headers.get('X-User-Id') ?? ''
        const duplicate = Array.from(waitlists.values()).some(record =>
          record.data.sessionId === data.sessionId && record.data.userId === userId,
        )
        if (duplicate) return Response.json({ success: false, error: 'Duplicate waitlist row' })
        const recordId = `waitlist-${++nextRecordId}`
        waitlists.set(recordId, { recordId, createdBy: userId, createdAt: nextCreatedAt(), data: { ...data, userId } })
        return Response.json({ success: true, data: { recordId } })
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

      if (tool === 'records.delete' && (params.collection === 'rsvps' || params.collection === 'waitlists')) {
        const recordId = String(params.recordId)
        const source = params.collection === 'waitlists' ? waitlists : rsvps
        if (!source.has(recordId)) return Response.json({ success: false, error: 'Record not found' })
        source.delete(recordId)
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

  function addSession(
    recordId: string,
    hostId: string,
    status: RallySession['status'] = 'open',
    capacity: { capacityMode: 'open' | 'limited'; maxPlayers: number } = { capacityMode: 'open', maxPlayers: 0 },
  ) {
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
        capacityMode: capacity.capacityMode,
        maxPlayers: capacity.maxPlayers,
      },
    })
  }

  // Seed a waitlist row directly, bypassing the command room — used to
  // simulate a stale row left behind by a failed delete.
  function seedWaitlist(sessionId: string, userId: string) {
    const recordId = `waitlist-${++nextRecordId}`
    waitlists.set(recordId, { recordId, createdBy: userId, createdAt: nextCreatedAt(), data: { sessionId, userId } })
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

  return { addSession, seedWaitlist, command, rsvps, sessions, waitlists }
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

  it('withdraws through the command room, idempotently', async () => {
    const harness = createHarness()
    harness.addSession('open-session', 'host')
    await harness.command('player', {
      operation: 'rsvp',
      sessionId: 'open-session',
      status: 'going',
    })
    expect(harness.rsvps.size).toBe(1)

    await expect(harness.command('player', {
      operation: 'withdraw',
      sessionId: 'open-session',
    })).resolves.toMatchObject({ success: true })
    expect(harness.rsvps.size).toBe(0)

    // A second withdraw is a no-op success, not an error.
    await expect(harness.command('player', {
      operation: 'withdraw',
      sessionId: 'open-session',
    })).resolves.toMatchObject({ success: true })
    expect(harness.rsvps.size).toBe(0)

    await expect(harness.command('player', {
      operation: 'withdraw',
      sessionId: 'missing-session',
    })).resolves.toMatchObject({ success: false })
  })

  it('serializes a withdraw racing an RSVP update without duplicating the RSVP', async () => {
    const harness = createHarness()
    harness.addSession('open-session', 'host')
    await harness.command('player', {
      operation: 'rsvp',
      sessionId: 'open-session',
      status: 'going',
    })

    const [withdrawResult, updateResult] = await Promise.all([
      harness.command('player', { operation: 'withdraw', sessionId: 'open-session' }),
      harness.command('player', {
        operation: 'rsvp',
        sessionId: 'open-session',
        status: 'maybe',
      }),
    ])
    expect(withdrawResult.success).toBe(true)
    expect(updateResult.success).toBe(true)
    expect(harness.rsvps.size).toBeLessThanOrEqual(1)
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

describe('Session capacity and waitlists', () => {
  const limited = { capacityMode: 'limited' as const, maxPlayers: 2 }

  async function go(harness: ReturnType<typeof createHarness>, userId: string, sessionId: string) {
    return harness.command(userId, { operation: 'rsvp', sessionId, status: 'going' })
  }

  it('caps going RSVPs at maxPlayers and returns a SESSION_FULL signal', async () => {
    const harness = createHarness()
    harness.addSession('s', 'host', 'open', limited)

    await expect(go(harness, 'host', 's')).resolves.toMatchObject({ success: true })
    await expect(go(harness, 'p2', 's')).resolves.toMatchObject({ success: true })
    await expect(go(harness, 'p3', 's')).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('SESSION_FULL'),
    })
    expect(harness.rsvps.size).toBe(2)
    // 'maybe' never consumes a spot, even when full.
    await expect(harness.command('p3', {
      operation: 'rsvp', sessionId: 's', status: 'maybe',
    })).resolves.toMatchObject({ success: true })
    expect(harness.rsvps.size).toBe(3)
  })

  it('treats a malformed stored cap as open participation', async () => {
    const harness = createHarness()
    harness.addSession('too-big', 'host', 'open', { capacityMode: 'limited', maxPlayers: 99 })
    harness.addSession('too-small', 'host', 'open', { capacityMode: 'limited', maxPlayers: 1 })

    for (const sessionId of ['too-big', 'too-small']) {
      for (const userId of ['a', 'b', 'c', 'd']) {
        await expect(go(harness, userId, sessionId)).resolves.toMatchObject({ success: true })
      }
    }
    expect(harness.rsvps.size).toBe(8)
  })

  it('lets open sessions exceed their target (regression)', async () => {
    const harness = createHarness()
    harness.addSession('s', 'host')

    for (const userId of ['host', 'p2', 'p3', 'p4', 'p5']) {
      await expect(go(harness, userId, 's')).resolves.toMatchObject({ success: true })
    }
    expect(harness.rsvps.size).toBe(5)
  })

  it('joins the waitlist idempotently and refuses it while spots are free or the caller is confirmed', async () => {
    const harness = createHarness()
    harness.addSession('full', 'host', 'open', limited)
    harness.addSession('roomy', 'host', 'open', limited)
    harness.addSession('open', 'host')
    await go(harness, 'host', 'full')
    await go(harness, 'p2', 'full')
    await go(harness, 'host', 'roomy')

    const first = await harness.command('w1', { operation: 'joinWaitlist', sessionId: 'full' })
    const second = await harness.command('w1', { operation: 'joinWaitlist', sessionId: 'full' })
    expect(first.success).toBe(true)
    expect(second).toMatchObject(first)
    expect(harness.waitlists.size).toBe(1)

    await expect(harness.command('p2', {
      operation: 'joinWaitlist', sessionId: 'full',
    })).resolves.toMatchObject({ success: false, error: expect.stringContaining('already confirmed') })
    await expect(harness.command('w2', {
      operation: 'joinWaitlist', sessionId: 'roomy',
    })).resolves.toMatchObject({ success: false, error: expect.stringContaining('Spots are still available') })
    await expect(harness.command('w2', {
      operation: 'joinWaitlist', sessionId: 'open',
    })).resolves.toMatchObject({ success: false, error: expect.stringContaining('open participation') })
  })

  it('leaves the waitlist and rejoins at the back', async () => {
    const harness = createHarness()
    harness.addSession('s', 'host', 'open', limited)
    await go(harness, 'host', 's')
    await go(harness, 'p2', 's')
    await harness.command('w1', { operation: 'joinWaitlist', sessionId: 's' })
    await harness.command('w2', { operation: 'joinWaitlist', sessionId: 's' })

    // Leaving when not listed is a no-op success.
    await expect(harness.command('nobody', {
      operation: 'leaveWaitlist', sessionId: 's',
    })).resolves.toMatchObject({ success: true })

    await expect(harness.command('w1', {
      operation: 'leaveWaitlist', sessionId: 's',
    })).resolves.toMatchObject({ success: true })
    expect(harness.waitlists.size).toBe(1)
    await harness.command('w1', { operation: 'joinWaitlist', sessionId: 's' })

    const order = Array.from(harness.waitlists.values())
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map(r => r.data.userId)
    expect(order).toEqual(['w2', 'w1'])
  })

  it('promotes only the earliest waiter when a confirmed player withdraws', async () => {
    const harness = createHarness()
    harness.addSession('s', 'host', 'open', limited)
    await go(harness, 'host', 's')
    await go(harness, 'p2', 's')
    await harness.command('w1', { operation: 'joinWaitlist', sessionId: 's' })
    await harness.command('w2', { operation: 'joinWaitlist', sessionId: 's' })

    await expect(harness.command('p2', {
      operation: 'withdraw', sessionId: 's',
    })).resolves.toMatchObject({ success: true })

    const going = Array.from(harness.rsvps.values())
      .filter(r => r.data.status === 'going')
      .map(r => r.data.userId)
      .sort()
    expect(going).toEqual(['host', 'w1'])
    expect(harness.waitlists.size).toBe(1)
    expect(Array.from(harness.waitlists.values())[0].data.userId).toBe('w2')
  })

  it('promotes the next waiter when a confirmed player switches to maybe', async () => {
    const harness = createHarness()
    harness.addSession('s', 'host', 'open', limited)
    await go(harness, 'host', 's')
    await go(harness, 'p2', 's')
    await harness.command('w1', { operation: 'joinWaitlist', sessionId: 's' })

    await expect(harness.command('p2', {
      operation: 'rsvp', sessionId: 's', status: 'maybe',
    })).resolves.toMatchObject({ success: true })

    const w1 = Array.from(harness.rsvps.values()).find(r => r.data.userId === 'w1')
    expect(w1?.data.status).toBe('going')
    expect(harness.waitlists.size).toBe(0)
    expect(Array.from(harness.rsvps.values()).find(r => r.data.userId === 'p2')?.data.status).toBe('maybe')
  })

  it('closes waitlist joins and RSVPs when the host cancels, and leaves rows inert', async () => {
    const harness = createHarness()
    harness.addSession('s', 'host', 'open', limited)
    await go(harness, 'host', 's')
    await go(harness, 'p2', 's')
    await harness.command('w1', { operation: 'joinWaitlist', sessionId: 's' })
    await harness.command('host', { operation: 'cancel', sessionId: 's' })

    await expect(go(harness, 'p3', 's')).resolves.toMatchObject({ success: false })
    await expect(harness.command('p3', {
      operation: 'joinWaitlist', sessionId: 's',
    })).resolves.toMatchObject({ success: false, error: expect.stringContaining('not open') })
    // The waitlisted player can still leave; the row is never promoted.
    await expect(harness.command('w1', {
      operation: 'leaveWaitlist', sessionId: 's',
    })).resolves.toMatchObject({ success: true })
    expect(harness.waitlists.size).toBe(0)
    expect(harness.rsvps.size).toBe(2)
  })

  it('never overbooks under five concurrent joins', async () => {
    const harness = createHarness()
    harness.addSession('s', 'host', 'open', limited)

    const results = await Promise.all(
      ['p1', 'p2', 'p3', 'p4', 'p5'].map(userId => go(harness, userId, 's')),
    )
    expect(results.filter(r => r.success).length).toBe(2)
    expect(results.filter(r => !r.success).length).toBe(3)
    for (const result of results.filter(r => !r.success)) {
      expect(result).toMatchObject({ error: expect.stringContaining('SESSION_FULL') })
    }
    expect(harness.rsvps.size).toBe(2)
  })

  it('drops a stale waitlist row for an already-confirmed player and promotes the next waiter', async () => {
    const harness = createHarness()
    harness.addSession('s', 'host', 'open', limited)
    await go(harness, 'host', 's')
    await go(harness, 'p2', 's')
    // Simulate a row left behind by a failed delete: the host is already
    // confirmed but still holds the earliest waitlist row.
    harness.seedWaitlist('s', 'host')
    await harness.command('w1', { operation: 'joinWaitlist', sessionId: 's' })
    await harness.command('w2', { operation: 'joinWaitlist', sessionId: 's' })

    await harness.command('p2', { operation: 'withdraw', sessionId: 's' })

    const going = Array.from(harness.rsvps.values())
      .filter(r => r.data.status === 'going')
      .map(r => r.data.userId)
      .sort()
    expect(going).toEqual(['host', 'w1'])
    expect(Array.from(harness.waitlists.values()).map(r => r.data.userId)).toEqual(['w2'])
  })

  it('lets a user withdraw from a cancelled session', async () => {
    const harness = createHarness()
    harness.addSession('s', 'host', 'open', limited)
    await go(harness, 'host', 's')
    await harness.command('host', { operation: 'cancel', sessionId: 's' })

    await expect(harness.command('host', {
      operation: 'withdraw', sessionId: 's',
    })).resolves.toMatchObject({ success: true })
    expect(harness.rsvps.size).toBe(0)
  })
})

  it('keeps direct writes closed while preserving own-RSVP withdrawal', () => {
    const rsvp = {
      data: { sessionId: 'session', userId: 'player', status: 'going' },
      createdBy: 'player',
      recordId: 'rsvp',
    }

    expect(canCreate(rsvpsSchema, 'member')).toBe(false)
    expect(canUpdate(rsvpsSchema, 'member', rsvp, 'player')).toBe(false)
    expect(canDelete(rsvpsSchema, 'member', rsvp, 'player')).toBe(true)
    expect(canCreate(waitlistsSchema, 'member')).toBe(false)
    expect(canUpdate(waitlistsSchema, 'member', {
      data: { sessionId: 'session', userId: 'player' },
      createdBy: 'player',
      recordId: 'waitlist',
    }, 'player')).toBe(false)
    expect(canDelete(waitlistsSchema, 'member', {
      data: { sessionId: 'session', userId: 'player' },
      createdBy: 'player',
      recordId: 'waitlist',
    }, 'player')).toBe(true)
    expect(checkFieldPermissions(sessionsSchema, 'member', { capacityMode: 'limited' })).toBeNull()
    expect(checkFieldPermissions(sessionsSchema, 'member', { maxPlayers: 4 })).toBeNull()
    expect(checkFieldPermissions(sessionsSchema, 'member', { status: 'cancelled' })).toContain('status')
    expect(checkFieldPermissions(sessionsSchema, 'member', { status: 'open' })).toContain('status')
    expect(canUpdate(sessionsSchema, 'member', {
      data: { hostId: 'host' },
      createdBy: 'host',
      recordId: 'session',
    }, 'player')).toBe(false)
  })
})
