import { canCreate, canDelete, canUpdate, checkFieldPermissions } from 'deepspace/worker'
import type { ActionTools } from 'deepspace/worker'
import { describe, expect, it } from 'vitest'
import { rsvpsSchema, sessionsSchema } from '../schemas/rally-schema.js'
import type { RallyRSVP, RallySession } from '../lib/rally.js'
import type { Env } from '../../worker.js'
import { rallyCommandAction, RallyCommandRoom } from './rally-command-room.js'

function createHarness(roomUnreachable = false) {
  const sessions = new Map<string, { recordId: string; createdBy: string; data: RallySession }>()
  const rsvps = new Map<string, { recordId: string; createdBy: string; data: RallyRSVP }>()
  let nextRecordId = 0

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

      if (tool === 'records.delete' && params.collection === 'rsvps') {
        const recordId = String(params.recordId)
        if (!rsvps.has(recordId)) return Response.json({ success: false, error: 'Record not found' })
        rsvps.delete(recordId)
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
    get: () => ({
      fetch: roomUnreachable
        ? async () => { throw new Error('room down') }
        : (request: Request) => room.fetch(request),
    }),
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

  function addRsvp(recordId: string, sessionId: string, userId: string, status: RallyRSVP['status'] = 'going') {
    rsvps.set(recordId, { recordId, createdBy: userId, data: { sessionId, userId, status } })
  }

  return { addSession, addRsvp, command, rsvps, sessions }
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

  it('keeps direct writes closed while preserving own-RSVP withdrawal', () => {
    const rsvp = {
      data: { sessionId: 'session', userId: 'player', status: 'going' },
      createdBy: 'player',
      recordId: 'rsvp',
    }

    expect(canCreate(rsvpsSchema, 'member')).toBe(false)
    expect(canUpdate(rsvpsSchema, 'member', rsvp, 'player')).toBe(false)
    expect(canDelete(rsvpsSchema, 'member', rsvp, 'player')).toBe(true)
    expect(checkFieldPermissions(sessionsSchema, 'member', { status: 'cancelled' })).toContain('status')
    expect(checkFieldPermissions(sessionsSchema, 'member', { status: 'open' })).toContain('status')
    expect(canUpdate(sessionsSchema, 'member', {
      data: { hostId: 'host' },
      createdBy: 'host',
      recordId: 'session',
    }, 'player')).toBe(false)
  })

  it('schema enforces server-side text lengths on sessions', () => {
    const columns = new Map(sessionsSchema.columns.map(c => [c.name, c]))
    expect(columns.get('title')?.maxLength).toBe(72)
    expect(columns.get('court')?.maxLength).toBe(100)
    expect(columns.get('location')?.maxLength).toBe(100)
    expect(columns.get('notes')?.maxLength).toBe(400)
  })

  it('withdraw removes only the caller’s RSVP and succeeds when absent', async () => {
    const harness = createHarness()
    harness.addSession('open-session', 'host')
    harness.addRsvp('rsvp-1', 'open-session', 'player-1', 'going')
    harness.addRsvp('rsvp-2', 'open-session', 'player-2', 'maybe')

    await expect(harness.command('player-1', {
      operation: 'withdraw',
      sessionId: 'open-session',
    })).resolves.toMatchObject({ success: true })
    expect(harness.rsvps.has('rsvp-1')).toBe(false)
    expect(harness.rsvps.has('rsvp-2')).toBe(true)

    // Withdrawing twice is a success, not a "Record not found".
    await expect(harness.command('player-1', {
      operation: 'withdraw',
      sessionId: 'open-session',
    })).resolves.toMatchObject({ success: true })
    expect(harness.rsvps.size).toBe(1)
  })

  it('withdraw is allowed on a cancelled session (harmless cleanup)', async () => {
    const harness = createHarness()
    harness.addSession('cancelled-session', 'host', 'cancelled')
    harness.addRsvp('rsvp-1', 'cancelled-session', 'player-1', 'going')

    await expect(harness.command('player-1', {
      operation: 'withdraw',
      sessionId: 'cancelled-session',
    })).resolves.toMatchObject({ success: true })
    expect(harness.rsvps.size).toBe(0)
  })

  it('withdraw racing an RSVP update ends in one consistent state', async () => {
    const harness = createHarness()
    harness.addSession('open-session', 'host')
    harness.addRsvp('rsvp-1', 'open-session', 'player-1', 'going')

    const [withdrawResult, rsvpResult] = await Promise.all([
      harness.command('player-1', { operation: 'withdraw', sessionId: 'open-session' }),
      harness.command('player-1', { operation: 'rsvp', sessionId: 'open-session', status: 'maybe' }),
    ])
    expect(withdrawResult.success).toBe(true)
    expect(rsvpResult.success).toBe(true)
    // Serialised by the per-session queue: either the withdraw won (0 rows)
    // or the RSVP won (1 row, latest status) — never 2 rows, never an error.
    expect(harness.rsvps.size).toBeLessThanOrEqual(1)
    if (harness.rsvps.size === 1) {
      expect(Array.from(harness.rsvps.values())[0].data.status).toBe('maybe')
    }
  })

  it('returns a structured failure when the command room is unreachable', async () => {
    const harness = createHarness(true)
    harness.addSession('open-session', 'host')

    await expect(harness.command('player', {
      operation: 'rsvp',
      sessionId: 'open-session',
      status: 'going',
    })).resolves.toMatchObject({
      success: false,
      error: 'The session update could not reach the server. Try again.',
    })
  })
})
