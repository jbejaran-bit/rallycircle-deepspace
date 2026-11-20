import { canCreate, canDelete, canRead, canUpdate, checkFieldPermissions } from 'deepspace/worker'
import type { ActionTools } from 'deepspace/worker'
import { describe, expect, it } from 'vitest'
import { rsvpsSchema, sessionsSchema } from '../schemas/rally-schema.js'
import { matchScoresSchema } from '../schemas/scoreboard-schema.js'
import type { RallyRSVP, RallySession } from '../lib/rally.js'
import type { MatchScoreboard } from '../lib/scoreboard.js'
import type { Env } from '../../worker.js'
import { rallyCommandAction, RallyCommandRoom } from './rally-command-room.js'

function createHarness() {
  const sessions = new Map<string, { recordId: string; createdBy: string; data: RallySession }>()
  const rsvps = new Map<string, { recordId: string; createdBy: string; data: RallyRSVP }>()
  const scores = new Map<string, { recordId: string; createdBy: string; data: MatchScoreboard }>()
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

      if (tool === 'records.query' && params.collection === 'matchScores') {
        const where = params.where as Partial<MatchScoreboard>
        const records = Array.from(scores.values()).filter(record =>
          Object.entries(where).every(([key, value]) => record.data[key as keyof MatchScoreboard] === value),
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

      if (tool === 'records.create' && params.collection === 'matchScores') {
        const data = params.data as Omit<MatchScoreboard, 'sessionId'> & { sessionId: string }
        const userId = request.headers.get('X-User-Id') ?? ''
        const duplicate = Array.from(scores.values()).some(record =>
          record.data.sessionId === data.sessionId,
        )
        if (duplicate) return Response.json({ success: false, error: 'Duplicate scoreboard' })
        const recordId = `score-${++nextRecordId}`
        scores.set(recordId, { recordId, createdBy: userId, data: { ...data } })
        return Response.json({ success: true, data: { recordId } })
      }

      if (tool === 'records.update') {
        const collection = params.collection
        const recordId = String(params.recordId)
        const patch = params.data as Record<string, unknown>
        if (collection === 'matchScores') {
          const record = scores.get(recordId)
          if (!record) return Response.json({ success: false, error: 'Record not found' })
          Object.assign(record.data, patch)
          return Response.json({ success: true, data: { recordId } })
        }
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

  return { addSession, command, rsvps, scores, sessions }
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
})

describe('match scoreboard server rules', () => {
  const finalScore = {
    operation: 'scoreboard',
    teamAName: 'Alice / Bob',
    teamBName: 'Carol / Dan',
    status: 'final',
    sets: [{ a: 6, b: 4 }, { a: 6, b: 3 }],
    matchTiebreak: null,
    expectedVersion: 0,
    correction: false,
  }

  it('lets the host create a score and stamps version and author', async () => {
    const harness = createHarness()
    harness.addSession('open-session', 'host')

    await expect(harness.command('host', {
      ...finalScore,
      sessionId: 'open-session',
    })).resolves.toMatchObject({ success: true })
    expect(harness.scores.size).toBe(1)
    const saved = Array.from(harness.scores.values())[0].data
    expect(saved).toMatchObject({ sessionId: 'open-session', version: 1, updatedBy: 'host', status: 'final' })
    expect(saved.sets).toEqual([{ a: 6, b: 4 }, { a: 6, b: 3 }])
  })

  it('rejects non-host writes and writes into another session', async () => {
    const harness = createHarness()
    harness.addSession('session-a', 'host-a')
    harness.addSession('session-b', 'host-b')

    // A participant who is not the host cannot write the score.
    await expect(harness.command('player', {
      ...finalScore,
      sessionId: 'session-a',
    })).resolves.toMatchObject({ success: false, error: 'Only the session host can update the scoreboard.' })

    // The host of session A cannot write session B's scoreboard.
    await expect(harness.command('host-a', {
      ...finalScore,
      sessionId: 'session-b',
    })).resolves.toMatchObject({ success: false, error: 'Only the session host can update the scoreboard.' })
    expect(harness.scores.size).toBe(0)

    // The host of session B can.
    await expect(harness.command('host-b', {
      ...finalScore,
      sessionId: 'session-b',
    })).resolves.toMatchObject({ success: true })
    expect(harness.scores.size).toBe(1)
  })

  it('rejects invalid scores, missing sessions, and cancelled sessions', async () => {
    const harness = createHarness()
    harness.addSession('open-session', 'host')
    harness.addSession('cancelled-session', 'host', 'cancelled')

    await expect(harness.command('host', {
      ...finalScore,
      sessionId: 'missing-session',
    })).resolves.toMatchObject({ success: false, error: 'This session is unavailable.' })

    await expect(harness.command('host', {
      ...finalScore,
      sessionId: 'open-session',
      sets: [{ a: 6, b: 6 }],
    })).resolves.toMatchObject({ success: false, error: expect.stringContaining('valid completed score') })

    await expect(harness.command('host', {
      ...finalScore,
      sessionId: 'open-session',
      sets: [{ a: 8, b: 0 }],
    })).resolves.toMatchObject({ success: false })

    await expect(harness.command('host', {
      ...finalScore,
      sessionId: 'open-session',
      matchTiebreak: { a: 10, b: 7 },
    })).resolves.toMatchObject({ success: false, error: expect.stringContaining('split 1–1') })

    await expect(harness.command('host', {
      ...finalScore,
      sessionId: 'open-session',
      sets: [{ a: 6, b: 4 }],
    })).resolves.toMatchObject({ success: false, error: expect.stringContaining('needs a winner') })

    await expect(harness.command('host', {
      ...finalScore,
      sessionId: 'cancelled-session',
    })).resolves.toMatchObject({ success: false, error: expect.stringContaining('cancelled') })

    expect(harness.scores.size).toBe(0)
  })

  it('turns a stale concurrent edit into a conflict, never a silent overwrite', async () => {
    const harness = createHarness()
    harness.addSession('open-session', 'host')
    await harness.command('host', { ...finalScore, sessionId: 'open-session' })

    // Two edits based on version 1 race through the serialised queue.
    // (The score is final, so both carry the correction flag.)
    const [first, second] = await Promise.all([
      harness.command('host', {
        ...finalScore,
        sessionId: 'open-session',
        sets: [{ a: 6, b: 4 }, { a: 7, b: 5 }],
        expectedVersion: 1,
        correction: true,
      }),
      harness.command('host', {
        ...finalScore,
        sessionId: 'open-session',
        sets: [{ a: 6, b: 2 }, { a: 6, b: 2 }],
        expectedVersion: 1,
        correction: true,
      }),
    ])
    expect(first.success).toBe(true)
    expect(second).toMatchObject({ success: false, error: expect.stringContaining('Conflict:') })
    const saved = Array.from(harness.scores.values())[0].data
    expect(saved.version).toBe(2)
    expect(saved.sets).toEqual([{ a: 6, b: 4 }, { a: 7, b: 5 }])

    // Retrying with the fresh version succeeds.
    await expect(harness.command('host', {
      ...finalScore,
      sessionId: 'open-session',
      sets: [{ a: 6, b: 2 }, { a: 6, b: 2 }],
      expectedVersion: 2,
      correction: true,
    })).resolves.toMatchObject({ success: true })
    expect(Array.from(harness.scores.values())[0].data.version).toBe(3)
  })

  it('requires an explicit correction to change a final score', async () => {
    const harness = createHarness()
    harness.addSession('open-session', 'host')
    await harness.command('host', { ...finalScore, sessionId: 'open-session' })

    await expect(harness.command('host', {
      ...finalScore,
      sessionId: 'open-session',
      sets: [{ a: 6, b: 4 }, { a: 7, b: 5 }],
      expectedVersion: 1,
    })).resolves.toMatchObject({ success: false, error: expect.stringContaining('correction') })

    await expect(harness.command('host', {
      ...finalScore,
      sessionId: 'open-session',
      sets: [{ a: 6, b: 4 }, { a: 7, b: 5 }],
      expectedVersion: 1,
      correction: true,
    })).resolves.toMatchObject({ success: true })
    const saved = Array.from(harness.scores.values())[0].data
    expect(saved.version).toBe(2)
    expect(saved.sets).toEqual([{ a: 6, b: 4 }, { a: 7, b: 5 }])
    expect(saved.updatedBy).toBe('host')
  })

  it('treats an identical re-save as an idempotent no-op', async () => {
    const harness = createHarness()
    harness.addSession('open-session', 'host')
    await harness.command('host', { ...finalScore, sessionId: 'open-session' })
    await expect(harness.command('host', {
      ...finalScore,
      sessionId: 'open-session',
      expectedVersion: 1,
    })).resolves.toMatchObject({ success: true })
    expect(Array.from(harness.scores.values())[0].data.version).toBe(1)
    expect(harness.scores.size).toBe(1)
  })

  it('keeps scoreboard records read-only for direct client writes', () => {
    const record = {
      data: {
        sessionId: 'session', teamAName: 'A', teamBName: 'B', status: 'final' as const,
        sets: [], matchTiebreak: null, version: 1, updatedBy: 'host',
      },
      createdBy: 'host',
      recordId: 'score-1',
    }
    expect(canRead(matchScoresSchema, 'member', record, 'player')).toBe(true)
    expect(canCreate(matchScoresSchema, 'member')).toBe(false)
    expect(canCreate(matchScoresSchema, 'admin')).toBe(false)
    expect(canUpdate(matchScoresSchema, 'member', record, 'host')).toBe(false)
    expect(canUpdate(matchScoresSchema, 'admin', record, 'host')).toBe(false)
    expect(canDelete(matchScoresSchema, 'member', record, 'host')).toBe(false)
  })
})
