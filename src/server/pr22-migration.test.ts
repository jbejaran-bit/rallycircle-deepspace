/**
 * Backend package 7 — legacy schema + migration compatibility on PR #22.
 *
 * Test-first reproductions for migration scenarios NOT covered by the
 * PR #19 migration port (16 tests, src/lib/migration-compat.test.ts),
 * the integrated branch's migration-compat suite, or the stats branch's
 * migration checks. All fixtures are disposable local records in an
 * in-memory harness — no production data, no live RecordRoom.
 *
 * Fixture shapes are PRE-TRACK records: fields added by later tracks are
 * absent (notes, scheduleRevision, capacity, matchScore, format) or hold
 * legacy values (unknown poll status, notification rows without readAt /
 * idempotencyKey). Every read path must handle them with a sensible
 * default — never a crash, never a wrong derived value.
 *
 * How to read the verdicts:
 * - PASS on unfixed e6ff2d9 = disproven (regression lock).
 * - FAIL on unfixed e6ff2d9 = confirmed defect; a fix commit follows.
 */
import { describe, expect, it } from 'vitest'
import type { ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker.js'
import { validateSession, type RallySession } from '../lib/rally.js'
import { buildCalendarEvent } from '../lib/rally-calendar.js'
import { parseSeriesTemplate, validateSeries, type SeriesTemplate } from '../lib/recurrence.js'
import { readMatchScore } from '../lib/rally-score.js'
import { createRallyAction } from './create-rally-action.js'
import {
  rallyCommandAction,
  RallyCommandRoom,
  schedulingAction,
} from './rally-command-room.js'
import { getMatchHistoryAction, getPlayerStatsAction } from './profile-actions.js'
import { notificationsAction } from './notification-actions.js'

type Row = { recordId: string; createdBy: string; seq: number; data: Record<string, unknown> }

const COLLECTIONS = [
  'sessions', 'rsvps', 'waitlists', 'polls', 'pollVotes', 'notifications',
  'notificationPreferences', 'recurringSeries', 'profiles', 'matchResults',
  'playerStats', 'resultAudits',
] as const

const USER_BOUND = new Set(['profiles', 'playerStats', 'matchResults', 'resultAudits'])

function createHarness() {
  const stores = new Map<string, Map<string, Row>>()
  for (const name of COLLECTIONS) stores.set(name, new Map())
  let nextRecordId = 0
  let nextSeq = 0
  const storeOf = (name: string) => stores.get(name)!

  function queryRows(collection: string, params: Record<string, unknown>): Row[] {
    const where = (params.where ?? {}) as Record<string, unknown>
    let records = [...storeOf(collection).values()].filter(row =>
      Object.entries(where).every(([key, value]) => row.data[key] === value))
    const orderBy = params.orderBy as string | undefined
    if (orderBy === 'createdAt') {
      records = [...records].sort((a, b) => params.orderDir === 'asc' ? a.seq - b.seq : b.seq - a.seq)
    } else if (orderBy) {
      const dir = params.orderDir === 'desc' ? -1 : 1
      records = [...records].sort((a, b) => {
        const av = String(a.data[orderBy] ?? '')
        const bv = String(b.data[orderBy] ?? '')
        return av < bv ? -dir : av > bv ? dir : 0
      })
    }
    const offset = Number(params.offset ?? 0)
    const limit = Number(params.limit ?? records.length)
    const page = records.slice(offset, offset + limit)
    return page
  }

  const recordRoom = {
    async fetch(request: Request) {
      const { tool, params } = await request.json() as { tool: string; params: Record<string, unknown> }
      await new Promise(resolve => setTimeout(resolve, 1))
      const userId = request.headers.get('X-User-Id') ?? ''
      const collection = String(params.collection ?? '')

      if (tool === 'records.get') {
        const record = storeOf(collection).get(String(params.recordId))
        return record
          ? Response.json({ success: true, data: { record } })
          : Response.json({ success: false, error: 'Record not found' })
      }

      if (tool === 'records.query') {
        const all = [...storeOf(collection).values()].filter(row =>
          Object.entries((params.where ?? {}) as Record<string, unknown>)
            .every(([key, value]) => row.data[key] === value))
        const ordered = queryRows(collection, params)
        const offset = Number(params.offset ?? 0)
        const limit = Number(params.limit ?? all.length)
        return Response.json({
          success: true,
          data: {
            records: ordered,
            count: ordered.length,
            nextOffset: all.length > offset + limit ? offset + limit : undefined,
          },
        })
      }

      if (tool === 'records.create') {
        const data = { ...(params.data as Record<string, unknown>) }
        if (collection === 'rsvps' || collection === 'waitlists' || collection === 'pollVotes') {
          data.userId = userId
        }
        if (collection === 'notifications') data.recipientId = userId
        if (USER_BOUND.has(collection)) data.userId = userId
        if (collection === 'polls' || collection === 'recurringSeries') data.hostId = userId
        if (collection === 'rsvps') {
          const dup = [...storeOf('rsvps').values()].some(r =>
            r.data.sessionId === data.sessionId && r.data.userId === data.userId)
          if (dup) return Response.json({ success: false, error: 'Duplicate RSVP' })
        }
        if (collection === 'pollVotes') {
          const dup = [...storeOf('pollVotes').values()].some(r =>
            r.data.pollId === data.pollId && r.data.optionId === data.optionId && r.data.userId === data.userId)
          if (dup) return Response.json({ success: false, error: 'Duplicate: vote already exists' })
        }
        if (collection === 'notifications') {
          const dup = [...storeOf('notifications').values()].some(r =>
            r.data.recipientId === data.recipientId && r.data.idempotencyKey === data.idempotencyKey)
          if (dup) return Response.json({ success: false, error: 'Duplicate: notification already exists' })
        }
        if (collection === 'polls') {
          const dup = [...storeOf('polls').values()].some(r => r.data.sessionId === data.sessionId)
          if (dup) return Response.json({ success: false, error: 'Duplicate: a poll already exists for this session' })
        }
        const recordId = typeof params.recordId === 'string' && params.recordId
          ? params.recordId
          : `${collection}-${++nextRecordId}`
        storeOf(collection).set(recordId, { recordId, createdBy: userId, seq: ++nextSeq, data })
        return Response.json({ success: true, data: { recordId } })
      }

      if (tool === 'records.update') {
        const record = storeOf(collection).get(String(params.recordId))
        if (!record) return Response.json({ success: false, error: 'Record not found' })
        Object.assign(record.data, params.data as Record<string, unknown>)
        return Response.json({ success: true, data: { recordId: record.recordId } })
      }

      if (tool === 'records.delete') {
        const deleted = storeOf(collection).delete(String(params.recordId))
        return Response.json(deleted
          ? { success: true, data: { recordId: String(params.recordId) } }
          : { success: false, error: 'Not found' })
      }

      return Response.json({ success: false, error: 'Unexpected tool request' })
    },
  }

  const env = {
    DEEPSPACE_APP_ID: 'test-app',
    RECORD_ROOMS: { idFromName: (name: string) => name, get: () => recordRoom },
  } as unknown as Env
  const storage = new Map<string, unknown>()
  const state = { storage: {
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
    put: async (key: string, value: unknown) => { storage.set(key, value) },
    get: async (key: string) => storage.get(key),
    delete: async (key: string) => { storage.delete(key) },
  } } as unknown as DurableObjectState
  const commandNamespace = {
    idFromName: (name: string) => name,
    get: (id: string) => ({ fetch: (request: Request) => (id.includes(':series:') ? seriesRoom : room).fetch(request) }),
  }
  const actionEnv = { ...env, RALLY_COMMAND_ROOMS: commandNamespace } as unknown as Env
  let room = new RallyCommandRoom(state, actionEnv)
  const seriesRoom = new RallyCommandRoom(state, actionEnv)

  function toolFetch(tool: string, params: Record<string, unknown>, userId: string) {
    return recordRoom.fetch(new Request('https://internal/api/tools/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': userId, 'X-App-Action': 'true' },
      body: JSON.stringify({ tool, params }),
    })).then(response => response.json())
  }

  const toolsFor = (callerId: string) => ({
    get: (collection: string, recordId: string) => toolFetch('records.get', { collection, recordId }, callerId),
    query: (collection: string, options: Record<string, unknown>) => toolFetch('records.query', { collection, ...options }, callerId),
    update: (collection: string, recordId: string, data: Record<string, unknown>) => toolFetch('records.update', { collection, recordId, data }, callerId),
    create: (collection: string, data: Record<string, unknown>, recordId?: string) => toolFetch('records.create', { collection, data, recordId }, callerId),
    remove: (collection: string, recordId: string) => toolFetch('records.delete', { collection, recordId }, callerId),
  }) as unknown as ActionTools

  async function command(userId: string, params: Record<string, unknown>) {
    return rallyCommandAction({
      userId, params, env: actionEnv, callerJwt: 'test-token',
      tools: {
        get: async (_collection: string, recordId: string) => {
          const record = storeOf('sessions').get(recordId)
          return record
            ? { success: true as const, data: { record: { ...record, createdAt: '', updatedAt: '' } } }
            : { success: false as const, error: 'Record not found' }
        },
      } as ActionTools,
    })
  }

  async function schedule(userId: string, params: Record<string, unknown>) {
    return schedulingAction({ userId, params, env: actionEnv, callerJwt: 'test-token', tools: {} as ActionTools })
  }

  async function createRally(userId: string, params: Record<string, unknown>) {
    return createRallyAction({ userId, params, env: actionEnv, callerJwt: 'test-token', tools: toolsFor(userId) })
  }

  async function profile(
    action: (ctx: { userId: string; params: Record<string, unknown>; tools: ActionTools; env: Env; callerJwt: string }) => Promise<unknown>,
    userId: string, params: Record<string, unknown> = {},
  ) {
    return action({ userId, params, tools: toolsFor(userId), env: {} as Env, callerJwt: 'test-token' })
  }

  async function notify(userId: string, params: Record<string, unknown>) {
    return notificationsAction({ userId, params, env: actionEnv, callerJwt: 'test-token', tools: toolsFor(userId) })
  }

  /** Seed a session in an exact legacy shape: pass the full stored data,
   *  omitting any field the legacy record predates. */
  function addSession(recordId: string, data: Record<string, unknown>) {
    storeOf('sessions').set(recordId, { recordId, createdBy: String(data.hostId ?? 'host'), seq: ++nextSeq, data })
    return recordId
  }

  function legacySession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      title: 'Legacy rally',
      court: 'Frick Park',
      location: 'Pittsburgh, PA',
      startsAt: '2030-06-06T14:00:00.000Z',
      durationMinutes: 90,
      targetPlayers: 4,
      level: 'Intermediate',
      notes: '',
      hostId: 'host',
      chatChannelId: '',
      status: 'open',
      ...overrides,
    }
  }

  function seedRow(collection: string, data: Record<string, unknown>, ownerId = 'host') {
    const recordId = `${collection}-seed-${++nextRecordId}`
    storeOf(collection).set(recordId, { recordId, createdBy: ownerId, seq: ++nextSeq, data })
    return recordId
  }

  /** Finalize a match through the real room path: startMatch, award the
   *  points for 6-0, 6-0, both players approve. Returns the session id. */
  async function finalizeMatch(sessionId: string) {
    const started = await command('host', { operation: 'startMatch', sessionId, teams: [['alice'], ['bob']] })
    expect(started.success).toBe(true)
    for (let point = 0; point < 48; point++) {
      const current = readMatchScore(String(storeOf('sessions').get(sessionId)?.data.matchScore ?? ''))
      const scored = await command('host', { operation: 'scorePoint', sessionId, side: 0, revision: current?.revision ?? 0 })
      expect(scored.success).toBe(true)
    }
    const approved1 = await command('alice', { operation: 'reviewResult', sessionId, decision: 'approve' })
    expect(approved1.success).toBe(true)
    const approved2 = await command('bob', { operation: 'reviewResult', sessionId, decision: 'approve' })
    expect(approved2.success).toBe(true)
    return sessionId
  }

  return {
    command, schedule, createRally, profile, notify, addSession, legacySession, seedRow, finalizeMatch,
    sessions: storeOf('sessions'), rsvps: storeOf('rsvps'), waitlists: storeOf('waitlists'),
    polls: storeOf('polls'), notifications: storeOf('notifications'), recurringSeries: storeOf('recurringSeries'),
    matchResults: storeOf('matchResults'),
  }
}

const FINAL_SCORE = JSON.stringify({
  revision: 2,
  teams: [['alice'], ['bob']],
  points: [0, 0],
  games: [0, 0],
  sets: [[6, 4], [6, 3]],
  winner: 0,
  approvals: ['alice', 'bob'],
})

function legacyTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'Singles',
    title: 'Weekly rally',
    court: 'Frick Park',
    location: 'Pittsburgh, PA',
    durationMinutes: 90,
    targetPlayers: 4,
    level: 'Intermediate',
    notes: '',
    ...overrides,
  }
}

describe('S1 — pre-notes session templates at every entry point (F7)', () => {
  it('1a: validateSession accepts a session without notes', () => {
    const session = {
      title: 'Legacy rally', court: 'Frick Park', location: 'Pittsburgh, PA',
      startsAt: '2030-06-06T14:00:00.000Z', durationMinutes: 90, targetPlayers: 4,
      level: 'Intermediate',
    } as unknown as Omit<RallySession, 'hostId' | 'chatChannelId' | 'status'>
    expect(() => validateSession(session, Date.parse('2030-01-01T00:00:00.000Z'))).not.toThrow()
    expect(validateSession(session, Date.parse('2030-01-01T00:00:00.000Z'))).toBeNull()
  })

  it('1b: validateSeries accepts a template without notes', () => {
    const template = legacyTemplate()
    delete template.notes
    expect(validateSeries({
      template: template as unknown as SeriesTemplate,
      startStartsAt: '2030-06-06T14:00:00.000Z', intervalWeeks: 1, count: 2,
    }, Date.parse('2030-01-01T00:00:00.000Z'))).toBeNull()
  })

  it('1c: parseSeriesTemplate accepts a stored template without notes as empty notes', () => {
    const raw = JSON.stringify({ ...legacyTemplate(), notes: undefined })
    const parsed = parseSeriesTemplate(raw)
    expect(parsed).not.toBeNull()
    expect(parsed!.notes).toBe('')
  })

  it('1d: createRallyAction accepts a draft without notes', async () => {
    const harness = createHarness()
    const created = await harness.createRally('host', {
      format: 'Singles', title: 'No-notes rally', court: 'Frick Park', location: 'Pittsburgh, PA',
      startsAt: '2030-06-06T14:00:00.000Z', durationMinutes: 90, targetPlayers: 4, level: 'Intermediate',
    })
    expect(created.success).toBe(true)
    if (created.success) {
      const stored = harness.sessions.get((created.data as { recordId: string }).recordId)
      expect(stored?.data.notes).toBe('')
    }
  })

  it('1e: a session without notes still exports a calendar event', () => {
    const session = {
      title: 'Legacy rally', court: 'Frick Park', location: 'Pittsburgh, PA',
      startsAt: '2030-06-06T14:00:00.000Z', durationMinutes: 90,
      status: 'open',
    } as unknown as RallySession
    const ics = buildCalendarEvent(session, 'https://rally.example/rallies?session=old', new Date('2030-01-01T00:00:00.000Z'))
    expect(ics).not.toBeNull()
    expect(ics!).not.toContain('NaN')
  })

  it('1f: generateOccurrences works for a legacy series whose template has no notes', async () => {
    const harness = createHarness()
    const template = legacyTemplate()
    delete template.notes
    const created = await harness.schedule('host', {
      operation: 'createSeries', seriesId: 'legacy-series', template,
      startStartsAt: '2030-06-06T14:00:00.000Z', intervalWeeks: 1, count: 2,
    })
    expect(created.success).toBe(true)
    const generated = await harness.schedule('host', { operation: 'generateOccurrences', seriesId: 'legacy-series' })
    expect(generated.success).toBe(true)
    const occurrences = [...harness.sessions.values()].filter(s => s.data.seriesId === 'legacy-series')
    expect(occurrences).toHaveLength(2)
    expect(occurrences.every(s => s.data.notes === '')).toBe(true)
  })
})

describe('S2 — pre-scheduleRevision sessions through poll finalize + calendar export', () => {
  const options = [
    { id: 'sat', startsAt: '2030-06-08T18:00:00.000Z' },
    { id: 'sun', startsAt: '2030-06-09T18:00:00.000Z' },
  ]

  it('2a: poll finalize works on a session without scheduleRevision and bumps it to 1', async () => {
    const harness = createHarness()
    harness.addSession('poll-session', harness.legacySession())
    for (const user of ['host', 'alice', 'bob']) {
      await harness.command(user, { operation: 'rsvp', sessionId: 'poll-session', status: 'going' })
    }
    const created = await harness.command('host', { operation: 'createPoll', sessionId: 'poll-session', options })
    expect(created.success).toBe(true)
    const pollId = (created.data as { recordId: string }).recordId
    const finalized = await harness.command('host', { operation: 'finalizePoll', sessionId: 'poll-session', pollId, optionId: 'sat' })
    expect(finalized.success).toBe(true)
    const session = harness.sessions.get('poll-session')!.data
    expect(session.startsAt).toBe('2030-06-08T18:00:00.000Z')
    expect(session.scheduleRevision).toBe(1)
  })

  it('2b: calendar export omits SEQUENCE while revision is 0, shows SEQUENCE:1 after finalize, and CANCEL reuses the same UID', async () => {
    const harness = createHarness()
    const data = harness.legacySession()
    const url = 'https://rally.example/rallies?session=poll-session'
    const before = buildCalendarEvent(
      data as unknown as RallySession, url, new Date('2030-01-01T00:00:00.000Z'))
    expect(before).not.toBeNull()
    expect(before!).not.toContain('SEQUENCE')
    expect(before!).not.toContain('NaN')
    harness.addSession('poll-session', data)
    for (const user of ['host', 'alice', 'bob']) {
      await harness.command(user, { operation: 'rsvp', sessionId: 'poll-session', status: 'going' })
    }
    const created = await harness.command('host', { operation: 'createPoll', sessionId: 'poll-session', options })
    const pollId = (created.data as { recordId: string }).recordId
    await harness.command('host', { operation: 'finalizePoll', sessionId: 'poll-session', pollId, optionId: 'sat' })
    const after = harness.sessions.get('poll-session')!.data as unknown as RallySession
    const exported = buildCalendarEvent(after, url, new Date('2030-01-01T00:00:00.000Z'))
    expect(exported).not.toBeNull()
    expect(exported!).toContain('SEQUENCE:1')
    expect(exported!).not.toContain('NaN')
    const cancelled = buildCalendarEvent(
      { ...after, status: 'cancelled' }, url, new Date('2030-01-01T00:00:00.000Z'), { method: 'CANCEL' })
    expect(cancelled).not.toBeNull()
    expect(cancelled!).toContain('METHOD:CANCEL')
    expect(cancelled!).toContain('STATUS:CANCELLED')
    expect(cancelled!).toContain('UID:https://rally.example/rallies?session=poll-session')
    expect(exported!).toContain('UID:https://rally.example/rallies?session=poll-session')
  })
})

describe('S3 — pre-capacity sessions through RSVP + waitlist flows', () => {
  it('3a: a session without capacity accepts unlimited going RSVPs and has no waitlist', async () => {
    const harness = createHarness()
    harness.addSession('open-session', harness.legacySession())
    for (const user of ['u1', 'u2', 'u3', 'u4', 'u5']) {
      const joined = await harness.command(user, { operation: 'rsvp', sessionId: 'open-session', status: 'going' })
      expect(joined.success).toBe(true)
    }
    expect([...harness.rsvps.values()].filter(r => r.data.status === 'going')).toHaveLength(5)
    const waitlisted = await harness.command('u6', { operation: 'joinWaitlist', sessionId: 'open-session' })
    expect(waitlisted.success).toBe(false)
    expect((waitlisted as { error: string }).error).toContain('no waitlist')
  })

  it('3b: a legacy session WITH capacity caps joins, waitlists, and promotes on withdrawal', async () => {
    const harness = createHarness()
    harness.addSession('capped-session', harness.legacySession({ capacity: 2 }))
    for (const user of ['u1', 'u2']) {
      expect((await harness.command(user, { operation: 'rsvp', sessionId: 'capped-session', status: 'going' })).success).toBe(true)
    }
    const full = await harness.command('u3', { operation: 'rsvp', sessionId: 'capped-session', status: 'going' })
    expect(full.success).toBe(false)
    expect((full as { error: string }).error).toContain('full')
    const queued = await harness.command('u3', { operation: 'joinWaitlist', sessionId: 'capped-session' })
    expect(queued.success).toBe(true)
    const withdrawn = await harness.command('u1', { operation: 'withdraw', sessionId: 'capped-session' })
    expect(withdrawn.success).toBe(true)
    const promoted = [...harness.rsvps.values()].find(r => r.data.userId === 'u3')
    expect(promoted?.data.status).toBe('going')
    expect(harness.waitlists.size).toBe(0)
  })

  it('3c: a legacy session with an invalid capacity fails joins closed but still allows withdrawal', async () => {
    const harness = createHarness()
    harness.addSession('bad-capacity', harness.legacySession({ capacity: 1 }))
    const joined = await harness.command('u1', { operation: 'rsvp', sessionId: 'bad-capacity', status: 'going' })
    expect(joined.success).toBe(false)
    expect((joined as { error: string }).error).toContain('invalid capacity')
    const withdrawn = await harness.command('u1', { operation: 'withdraw', sessionId: 'bad-capacity' })
    expect(withdrawn.success).toBe(true)
  })
})

describe('S4 — pre-matchScore sessions through the scoreboard + result flows', () => {
  it('4a: a legacy Singles session without matchScore starts, scores, finalizes, and counts exactly once', async () => {
    const harness = createHarness()
    harness.addSession('legacy-match', harness.legacySession({ format: 'Singles' }))
    for (const user of ['alice', 'bob']) {
      expect((await harness.command(user, { operation: 'rsvp', sessionId: 'legacy-match', status: 'going' })).success).toBe(true)
    }
    await harness.finalizeMatch('legacy-match')
    const rows = [...harness.matchResults.values()].filter(r => r.data.sessionId === 'legacy-match')
    expect(rows).toHaveLength(2)
    const stats = await harness.profile(getPlayerStatsAction, 'alice', { userId: 'alice' }) as {
      success: boolean; data: { stats: { singles: { wins: number; losses: number; played: number } } }
    }
    expect(stats.success).toBe(true)
    expect(stats.data.stats.singles).toEqual(expect.objectContaining({ wins: 1, losses: 0, matchesPlayed: 1 }))
    const history = await harness.profile(getMatchHistoryAction, 'alice', { userId: 'alice' }) as {
      success: boolean; data: { entries: unknown[] }
    }
    expect(history.success).toBe(true)
    expect(history.data.entries).toHaveLength(1)
  })

  it('4b: a legacy session without a format fails startMatch cleanly instead of crashing', async () => {
    const harness = createHarness()
    harness.addSession('no-format', harness.legacySession())
    for (const user of ['alice', 'bob']) {
      await harness.command(user, { operation: 'rsvp', sessionId: 'no-format', status: 'going' })
    }
    const started = await harness.command('host', { operation: 'startMatch', sessionId: 'no-format', teams: [['alice'], ['bob']] })
    expect(started.success).toBe(false)
    expect((started as { error: string }).error).toContain('session format')
  })
})

describe('S5 — legacy matchResults rows through stats + history', () => {
  function seedFinalRow(
    harness: ReturnType<typeof createHarness>,
    sessionOverrides: Record<string, unknown> = {},
    rowOverrides: Record<string, unknown> = {},
  ) {
    const sessionId = harness.addSession('legacy-result', harness.legacySession({
      format: 'Singles', matchScore: FINAL_SCORE, ...sessionOverrides,
    }))
    // Rows are seeded complete, exactly as finalization writes them
    // (format/won/sets/status): the combined read path trusts stored final
    // rows without fetching the session, so an incomplete row is dropped,
    // not derived. A missing status is the only legacy gap — it counts as
    // 'final', as pre-status rows were written only on finalization.
    harness.seedRow('matchResults', {
      sessionId, format: 'singles', won: 1, sets: JSON.stringify([[6, 4], [6, 3]]),
      resultRevision: 2, finalizedAt: '2030-06-06T15:00:00.000Z', userId: 'alice', ...rowOverrides,
    }, 'alice')
    return sessionId
  }

  it('5a: a legacy row without a status column counts as final', async () => {
    const harness = createHarness()
    seedFinalRow(harness, {})
    const stats = await harness.profile(getPlayerStatsAction, 'alice', { userId: 'alice' }) as {
      success: boolean; data: { stats: { singles: { wins: number; played: number } } }
    }
    expect(stats.success).toBe(true)
    expect(stats.data.stats.singles).toEqual(expect.objectContaining({ wins: 1, matchesPlayed: 1 }))
  })

  it('5b: a row flipped to pending by a correction (stale revision) does not count, and history shows the corrected outcome', async () => {
    // Write-side form of the migration-branch 5b: the correction flip (not
    // a read-side revision check) is what excludes the superseded outcome
    // now. Legacy gap, documented in the implementation log: a pre-status
    // row whose session was corrected before the status column shipped has
    // no flip to observe and counts as final; the backfill sweep in the
    // migration plan covers that shape.
    const harness = createHarness()
    const correctedScore = JSON.stringify({
      revision: 3, teams: [['alice'], ['bob']], points: [0, 0], games: [0, 0],
      sets: [[4, 6], [6, 4], [2, 6]], winner: 1, approvals: [], correctionCount: 1,
    })
    seedFinalRow(harness, { matchScore: correctedScore }, { status: 'pending' })
    const stats = await harness.profile(getPlayerStatsAction, 'alice', { userId: 'alice' }) as {
      success: boolean; data: { stats: { singles: { matchesPlayed: number } } }
    }
    expect(stats.success).toBe(true)
    expect(stats.data.stats.singles.matchesPlayed).toBe(0)
    const history = await harness.profile(getMatchHistoryAction, 'alice', { userId: 'alice' }) as {
      success: boolean; data: { entries: { status: string; won: boolean; resultRevision: number; sets: unknown[] }[] }
    }
    expect(history.data.entries).toHaveLength(1)
    expect(history.data.entries[0]).toMatchObject({
      status: 'pending', won: false, resultRevision: 3, sets: [[4, 6], [6, 4], [2, 6]],
    })
  })

  it('5c: a row flipped to cancelled at session cancellation does not count', async () => {
    const harness = createHarness()
    seedFinalRow(harness, { status: 'cancelled' }, { status: 'cancelled' })
    const stats = await harness.profile(getPlayerStatsAction, 'alice', { userId: 'alice' }) as {
      success: boolean; data: { stats: { singles: { matchesPlayed: number } } }
    }
    expect(stats.success).toBe(true)
    expect(stats.data.stats.singles.matchesPlayed).toBe(0)
    const history = await harness.profile(getMatchHistoryAction, 'alice', { userId: 'alice' }) as {
      success: boolean; data: { entries: unknown[] }
    }
    expect(history.data.entries).toHaveLength(0)
  })

  it('5c2 (combined): cancelling a session through the room flips its rows to cancelled so they stop counting', async () => {
    const harness = createHarness()
    harness.addSession('legacy-match', harness.legacySession({ format: 'Singles' }))
    for (const user of ['alice', 'bob']) {
      expect((await harness.command(user, { operation: 'rsvp', sessionId: 'legacy-match', status: 'going' })).success).toBe(true)
    }
    await harness.finalizeMatch('legacy-match')
    const before = await harness.profile(getPlayerStatsAction, 'alice', { userId: 'alice' }) as {
      success: boolean; data: { stats: { singles: { matchesPlayed: number } } }
    }
    expect(before.data.stats.singles.matchesPlayed).toBe(1)
    const cancelled = await harness.command('host', { operation: 'cancel', sessionId: 'legacy-match' })
    expect(cancelled.success).toBe(true)
    const rows = [...harness.matchResults.values()].filter(r => r.data.sessionId === 'legacy-match')
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.data.status === 'cancelled')).toBe(true)
    const stats = await harness.profile(getPlayerStatsAction, 'alice', { userId: 'alice' }) as {
      success: boolean; data: { stats: { singles: { matchesPlayed: number } } }
    }
    expect(stats.success).toBe(true)
    expect(stats.data.stats.singles.matchesPlayed).toBe(0)
    const history = await harness.profile(getMatchHistoryAction, 'alice', { userId: 'alice' }) as {
      success: boolean; data: { entries: unknown[] }
    }
    expect(history.data.entries).toHaveLength(0)
  })

  it('5d: a complete row whose session is missing is trusted (counts) and the call still succeeds', async () => {
    // Write-side trade, documented in the implementation log: the read path
    // trusts stored final rows without fetching each session (0 GETs), so an
    // orphaned complete row counts — the read-side loader dropped it. Sessions
    // are never deleted in normal operation (deletion is a DO-recovery edge
    // case), and a maintenance sweep can flip orphaned rows to 'cancelled'.
    // The call must never fail.
    const harness = createHarness()
    harness.seedRow('matchResults', {
      sessionId: 'gone-session', format: 'singles', won: 1, sets: JSON.stringify([[6, 4], [6, 3]]),
      resultRevision: 2, finalizedAt: '2030-06-06T15:00:00.000Z', userId: 'alice',
    }, 'alice')
    const stats = await harness.profile(getPlayerStatsAction, 'alice', { userId: 'alice' }) as {
      success: boolean; data: { stats: { singles: { matchesPlayed: number } } }
    }
    expect(stats.success).toBe(true)
    expect(stats.data.stats.singles.matchesPlayed).toBe(1)
  })
})

describe('S6 — legacy poll rows with an unknown status', () => {
  function seedWeirdPoll(harness: ReturnType<typeof createHarness>) {
    harness.addSession('poll-session', harness.legacySession())
    return harness.seedRow('polls', {
      sessionId: 'poll-session',
      options: JSON.stringify([
        { id: 'sat', startsAt: '2030-06-08T18:00:00.000Z' },
        { id: 'sun', startsAt: '2030-06-09T18:00:00.000Z' },
      ]),
      status: 'weird',
      baseStartsAt: '2030-06-06T14:00:00.000Z',
      finalizedOptionId: '',
      tally: '{}',
    }, 'host')
  }

  it('6a: finalizePoll on an unknown-status poll fails cleanly', async () => {
    const harness = createHarness()
    const pollId = seedWeirdPoll(harness)
    const finalized = await harness.command('host', { operation: 'finalizePoll', sessionId: 'poll-session', pollId, optionId: 'sat' })
    expect(finalized.success).toBe(false)
    expect((finalized as { error: string }).error).toContain('not open')
  })

  it('6b: cancelPoll on an unknown-status poll succeeds; a replacement poll stays blocked by the one-poll-per-session schema rule', async () => {
    const harness = createHarness()
    const pollId = seedWeirdPoll(harness)
    const cancelled = await harness.command('host', { operation: 'cancelPoll', sessionId: 'poll-session', pollId })
    expect(cancelled.success).toBe(true)
    expect(harness.polls.get(pollId)?.data.status).toBe('cancelled')
    // The session itself is not bricked: RSVPs still work after the cancel.
    const joined = await harness.command('alice', { operation: 'rsvp', sessionId: 'poll-session', status: 'going' })
    expect(joined.success).toBe(true)
    // A replacement poll is refused with a clear error, not a crash:
    // polls carry uniqueOn: ['sessionId'] (one poll per session ever, by
    // design in Track G+H), so re-polling would need a schema decision,
    // not a migration fix. The cancelled poll no longer blocks anything
    // except a second poll.
    const recreated = await harness.command('host', {
      operation: 'createPoll', sessionId: 'poll-session',
      options: [
        { id: 'sat', startsAt: '2030-06-08T18:00:00.000Z' },
        { id: 'sun', startsAt: '2030-06-09T18:00:00.000Z' },
      ],
    })
    expect(recreated.success).toBe(false)
    expect((recreated as { error: string }).error).toContain('already has a poll')
  })

  it('6c: castVote on an unknown-status poll fails cleanly', async () => {
    const harness = createHarness()
    const pollId = seedWeirdPoll(harness)
    await harness.command('alice', { operation: 'rsvp', sessionId: 'poll-session', status: 'going' })
    const voted = await harness.command('alice', { operation: 'castVote', sessionId: 'poll-session', pollId, optionId: 'sat' })
    expect(voted.success).toBe(false)
    expect((voted as { error: string }).error).toContain('not open')
  })

  it('6d: a poll with malformed options JSON fails cleanly on every operation', async () => {
    const harness = createHarness()
    harness.addSession('poll-session', harness.legacySession())
    const pollId = harness.seedRow('polls', {
      sessionId: 'poll-session', options: 'not json at all', status: 'open',
      baseStartsAt: '2030-06-06T14:00:00.000Z', finalizedOptionId: '', tally: '{}',
    }, 'host')
    const finalized = await harness.command('host', { operation: 'finalizePoll', sessionId: 'poll-session', pollId, optionId: 'sat' })
    expect(finalized.success).toBe(false)
    expect((finalized as { error: string }).error).toContain('unavailable')
  })

  it('6e: finalizePoll works on a legacy poll without baseStartsAt', async () => {
    const harness = createHarness()
    harness.addSession('poll-session', harness.legacySession())
    for (const user of ['host', 'alice', 'bob']) {
      await harness.command(user, { operation: 'rsvp', sessionId: 'poll-session', status: 'going' })
    }
    const pollId = harness.seedRow('polls', {
      sessionId: 'poll-session',
      options: JSON.stringify([
        { id: 'sat', startsAt: '2030-06-08T18:00:00.000Z' },
        { id: 'sun', startsAt: '2030-06-09T18:00:00.000Z' },
      ]),
      status: 'open', finalizedOptionId: '', tally: '{}',
    }, 'host')
    const finalized = await harness.command('host', { operation: 'finalizePoll', sessionId: 'poll-session', pollId, optionId: 'sat' })
    expect(finalized.success).toBe(true)
    expect(harness.sessions.get('poll-session')!.data.startsAt).toBe('2030-06-08T18:00:00.000Z')
  })
})

describe('S7 — legacy notification rows without readAt / idempotencyKey', () => {
  it('7a: markRead works on a legacy row without readAt', async () => {
    const harness = createHarness()
    const recordId = harness.seedRow('notifications', {
      recipientId: 'alice', type: 'session_cancelled', sessionId: 's1',
      title: 'Cancelled', body: 'x', link: '/rallies?session=s1',
    }, 'alice')
    const marked = await harness.notify('alice', { operation: 'markRead', recordId })
    expect(marked.success).toBe(true)
    expect(harness.notifications.get(recordId)?.data.readAt).toBeTruthy()
  })

  it('7b: markAllRead marks legacy rows without readAt too', async () => {
    const harness = createHarness()
    const withEmpty = harness.seedRow('notifications', {
      recipientId: 'alice', type: 'session_cancelled', sessionId: 's1',
      title: 'A', body: 'x', link: '/rallies?session=s1', readAt: '', idempotencyKey: 'k1',
    }, 'alice')
    const withoutField = harness.seedRow('notifications', {
      recipientId: 'alice', type: 'poll_created', sessionId: 's1',
      title: 'B', body: 'x', link: '/rallies?session=s1',
    }, 'alice')
    const marked = await harness.notify('alice', { operation: 'markAllRead' }) as {
      success: boolean; data: { count: number }
    }
    expect(marked.success).toBe(true)
    expect(marked.data.count).toBe(2)
    expect(harness.notifications.get(withEmpty)?.data.readAt).toBeTruthy()
    expect(harness.notifications.get(withoutField)?.data.readAt).toBeTruthy()
  })

  it('7c: markRead on a legacy row without recipientId fails closed', async () => {
    const harness = createHarness()
    const recordId = harness.seedRow('notifications', {
      type: 'session_cancelled', sessionId: 's1',
      title: 'Orphan', body: 'x', link: '/rallies?session=s1', readAt: '',
    }, 'alice')
    const marked = await harness.notify('alice', { operation: 'markRead', recordId })
    expect(marked.success).toBe(false)
    expect((marked as { error: string }).error).toContain('your own notifications')
    expect(harness.notifications.get(recordId)?.data.readAt).toBe('')
  })

  it('7d: markAllRead never touches another user\'s rows', async () => {
    const harness = createHarness()
    harness.seedRow('notifications', {
      recipientId: 'alice', type: 'session_cancelled', sessionId: 's1',
      title: 'A', body: 'x', link: '/rallies?session=s1', readAt: '',
    }, 'alice')
    const bobs = harness.seedRow('notifications', {
      recipientId: 'bob', type: 'session_cancelled', sessionId: 's1',
      title: 'B', body: 'x', link: '/rallies?session=s1', readAt: '',
    }, 'bob')
    const marked = await harness.notify('alice', { operation: 'markAllRead' }) as {
      success: boolean; data: { count: number }
    }
    expect(marked.success).toBe(true)
    expect(marked.data.count).toBe(1)
    expect(harness.notifications.get(bobs)?.data.readAt).toBe('')
  })
})

describe('S8 — forward compatibility: e6ff2d9 records read by older readers', () => {
  it('8a: a matchResults row carrying an unknown extra column is ignored, not crashed on', async () => {
    const harness = createHarness()
    const sessionId = harness.addSession('legacy-result', harness.legacySession({
      format: 'Singles', matchScore: FINAL_SCORE,
    }))
    harness.seedRow('matchResults', {
      sessionId, resultRevision: 2, finalizedAt: '2030-06-06T15:00:00.000Z',
      status: 'final', userId: 'alice', format: 'singles', won: 1, sets: JSON.stringify([[6, 4], [6, 3]]),
    }, 'alice')
    const stats = await harness.profile(getPlayerStatsAction, 'alice', { userId: 'alice' }) as {
      success: boolean; data: { stats: { singles: { wins: number; played: number } } }
    }
    expect(stats.success).toBe(true)
    expect(stats.data.stats.singles).toEqual(expect.objectContaining({ wins: 1, matchesPlayed: 1 }))
  })

  it('8b: e6ff2d9-shaped sessions validate under the PR #19-era migration expectations', () => {
    const session = {
      format: 'Singles', title: 'Modern rally', court: 'Frick Park', location: 'Pittsburgh, PA',
      startsAt: '2030-06-06T14:00:00.000Z', durationMinutes: 90, targetPlayers: 4,
      capacity: 4, level: 'Intermediate', notes: 'Bring balls.',
      scheduleRevision: 2, pendingResult: '', seriesId: '',
    } as unknown as Omit<RallySession, 'hostId' | 'chatChannelId' | 'status'>
    expect(validateSession(session, Date.parse('2030-01-01T00:00:00.000Z'))).toBeNull()
    expect(readMatchScore(undefined)).toBeNull()
  })
})
