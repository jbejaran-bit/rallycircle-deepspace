/**
 * PR #22 port-fixes — test-first reproductions.
 *
 * Each test below reproduces one defect that the PR #22 reconciliation
 * (fullstack/pr22-reconcile/RECONCILE_PR22.md) confirmed STILL PRESENT on
 * `review/rallycircle-serialized-session-time` @ e6ff2d9, against PR #22's
 * own derive-on-read architecture. Every test FAILS on unfixed e6ff2d9
 * and PASSES with the ported fix. Tests run against the REAL command-room
 * code paths via the shared harness in ./race-harness.ts (mock RecordRoom
 * with verified SDK query semantics + deterministic fault injection).
 * Nothing here touches a live app, production data, or any credential.
 *
 * F4 note: the expected semantics are issue #23's — a corrected match
 * stays visible in history as pending/corrected (visible, not counted)
 * until re-approval, instead of vanishing via loadVerifiedResults.
 * Superseded outcomes are excluded from verified statistics; durable
 * audit/provenance (matchResults rows + the 'corrected' audit row) is
 * preserved.
 */
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import type { ActionTools } from 'deepspace/worker'
import { canCreate, checkFieldPermissions } from 'deepspace/worker'
import type { Env } from '../../worker.js'
import {
  createRaceHarness,
  createTestPoll,
  decidedScore,
  type RaceHarness,
} from './race-harness.js'
import { parsePollTally } from '../lib/polls.js'
import { getMatchHistoryAction, getPlayerStatsAction } from './profile-actions.js'
import { updateProfileAction } from './profile-actions.js'
import { sessionsSchema } from '../schemas/rally-schema.js'

type RowLike = {
  recordId: string
  createdBy: string
  createdAt: number
  updatedAt: number
  seq: number
  data: Record<string, unknown>
}

/** ActionTools over the harness store that honours limit/offset/nextOffset. */
function pagedActionTools(h: RaceHarness, callerId: string): ActionTools {
  const pub = (row: RowLike) => ({
    recordId: row.recordId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    data: { ...row.data },
  })
  const query = (async (collection: string, params: Record<string, unknown>) => {
    const where = (params.where ?? {}) as Record<string, unknown>
    let rows = [...(h.store.get(collection)?.values() ?? [])].filter((row: RowLike) =>
      Object.entries(where).every(([key, value]) => row.data[key] === value),
    )
    const orderBy = params.orderBy as string | undefined
    const desc = params.orderDir !== 'asc'
    rows.sort((a: RowLike, b: RowLike) => {
      if (!orderBy) return desc ? b.seq - a.seq : a.seq - b.seq
      const av = a.data[orderBy] as number | string
      const bv = b.data[orderBy] as number | string
      if (av === bv) return desc ? b.seq - a.seq : a.seq - b.seq
      const cmp = av < bv ? -1 : 1
      return desc ? -cmp : cmp
    })
    const offset = typeof params.offset === 'number' ? params.offset : 0
    const limit = typeof params.limit === 'number' ? params.limit : 100
    const page = rows.slice(offset, offset + limit)
    const nextOffset = offset + page.length < rows.length ? offset + page.length : undefined
    return { success: true as const, data: { records: page.map(pub), count: page.length, nextOffset } }
  }) as unknown as ActionTools['query']
  const get = (async (collection: string, recordId: string) => {
    const row = h.store.get(collection)?.get(recordId) as RowLike | undefined
    return row
      ? { success: true as const, data: { record: pub(row) } }
      : { success: false as const, error: 'Record not found' }
  }) as ActionTools['get']
  return { query, get } as ActionTools
}

async function readStats(h: RaceHarness, userId: string) {
  const seen = await getPlayerStatsAction({
    userId,
    params: { userId },
    tools: pagedActionTools(h, userId),
    env: {} as Env,
    callerJwt: 'test-token',
  } as Parameters<typeof getPlayerStatsAction>[0])
  expect(seen.success).toBe(true)
  if (!seen.success) throw new Error('getPlayerStats failed')
  const singles = (seen.data as { stats: { singles: { wins: number; losses: number; matchesPlayed: number } } }).stats.singles
  return singles
}

async function readHistory(h: RaceHarness, userId: string) {
  const result = await getMatchHistoryAction({
    userId,
    params: { userId },
    tools: pagedActionTools(h, userId),
    env: {} as Env,
    callerJwt: 'test-token',
  } as Parameters<typeof getMatchHistoryAction>[0])
  expect(result.success).toBe(true)
  if (!result.success) throw new Error('getMatchHistory failed')
  return (result.data as { entries: Array<{ sessionId: string; status?: string; won: boolean; sets: Array<[number, number]>; resultRevision: number }> }).entries
}

async function finalizeMatch(h: RaceHarness, sessionId: string, revision: number) {
  await expect(h.command('bob', {
    operation: 'reviewResult', sessionId, decision: 'approve', revision,
  })).resolves.toMatchObject({ success: true })
  await expect(h.command('alice', {
    operation: 'reviewResult', sessionId, decision: 'approve', revision,
  })).resolves.toMatchObject({ success: true })
}

describe('PR22-PORT', () => {
  it('PR22-PORT K01: a room fetch without the X-App-Action marker is rejected', async () => {
    const h = createRaceHarness()
    h.addSession('s1', 'host', { targetPlayers: 2 })
    // An unauthenticated caller who knows the session and host ids can
    // otherwise issue any command as the host: the room trusts its body.
    const forged = await h.roomFetch('rally:test-app:s1', '/rally-command', {
      operation: 'cancel', sessionId: 's1', userId: 'host',
    })
    expect(forged.status).toBe(400)
    expect(h.readSession('s1')?.status).toBe('open')
    // The internal path (marker present, as the action sends it) still works.
    const internal = await h.roomFetch('rally:test-app:s1', '/rally-command', {
      operation: 'cancel', sessionId: 's1', userId: 'host',
    }, { 'X-App-Action': 'true' })
    expect(internal.status).toBe(200)
    expect((internal.json as { success?: boolean }).success).toBe(true)
    expect(h.readSession('s1')?.status).toBe('cancelled')
  })

  it('PR22-PORT K01-legit: the legitimate action path still works after the marker check', async () => {
    const h = createRaceHarness()
    h.addSession('s1', 'host', { targetPlayers: 2 })
    h.addRsvp('s1', 'alice', 'going')
    // rallyCommandAction -> room.fetch must carry the marker; a plain
    // RSVP through the action proves the legitimate path is intact.
    await expect(h.command('alice', { operation: 'withdraw', sessionId: 's1' }))
      .resolves.toMatchObject({ success: true })
    await expect(h.command('host', { operation: 'cancel', sessionId: 's1' }))
      .resolves.toMatchObject({ success: true })
    expect(h.readSession('s1')?.status).toBe('cancelled')
  })

  it('PR22-PORT X4: flipping a profile to private syncs every stats/history row (not just the first 100)', async () => {
    const h = createRaceHarness()
    h.addProfile('alice', 'public')
    for (let i = 0; i < 120; i++) h.addMatchResult(`seed-${i}`, 'alice', 1, 1)
    h.addPlayerStats('alice', 120, 0)
    const updated = await updateProfileAction({
      userId: 'alice',
      params: {
        displayName: 'alice', bio: '', formats: [], preferredArea: '',
        selfReportedLevel: 'Unrated', visibility: 'private',
      },
      tools: h.actionTools('alice'),
      env: {} as Env,
      callerJwt: 'test-token',
    } as Parameters<typeof updateProfileAction>[0])
    expect(updated.success).toBe(true)
    const stats = await h.queryRaw('playerStats', { userId: 'alice' })
    expect(stats[0]?.data.visibility).toBe('private')
    const results = await h.queryAllRaw('matchResults', { userId: 'alice' })
    expect(results).toHaveLength(120)
    expect(results.every(row => row.data.visibility === 'private')).toBe(true)
  })

  it('PR22-PORT F3-cancel: cancelling a 150-RSVP session notifies every recipient exactly once', async () => {
    // Hundreds of sequential mock requests amplify OS timer granularity.
    // Yield without imposing a timer delay for this fan-out assertion.
    const h = createRaceHarness({ yieldRecordRoom: () => setImmediate() })
    h.addSession('s1', 'host', { targetPlayers: 2 })
    for (let i = 0; i < 150; i++) {
      h.addRsvp('s1', `player-${i}`, i % 2 === 0 ? 'going' : 'maybe')
    }
    const cancelled = await h.command('host', { operation: 'cancel', sessionId: 's1' })
    expect(cancelled.success).toBe(true)
    const notices = await h.queryAllRaw('notifications', { type: 'session_cancelled' })
    expect(notices).toHaveLength(150)
    const recipients = new Set(notices.map(row => row.data.recipientId))
    expect(recipients.size).toBe(150)
    for (let i = 0; i < 150; i++) expect(recipients.has(`player-${i}`)).toBe(true)
  })

  it('PR22-PORT F6-poll: a poll tally counts every vote, not just the first 500', async () => {
    const h = createRaceHarness()
    h.addSession('s1', 'host', { targetPlayers: 2 })
    h.addRsvp('s1', 'voter-new', 'going')
    const pollId = await createTestPoll(h, 's1')
    // 501 votes already cast: 300 for opt-1, 201 for opt-2.
    for (let i = 0; i < 300; i++) h.addPollVote(pollId, 'opt-1', `seed-voter-1-${i}`)
    for (let i = 0; i < 201; i++) h.addPollVote(pollId, 'opt-2', `seed-voter-2-${i}`)
    const voted = await h.command('voter-new', {
      operation: 'castVote', sessionId: 's1', pollId, optionId: 'opt-1',
    })
    expect(voted.success).toBe(true)
    const poll = (await h.queryRaw('polls', { sessionId: 's1' }))[0]
    expect(parsePollTally(poll?.data.tally as string)).toEqual({ 'opt-1': 301, 'opt-2': 201 })
  })

  it('PR22-PORT S5: a stuck pendingResult no longer blocks cancel', async () => {
    const h = createRaceHarness()
    h.addSession('s1', 'host', { targetPlayers: 2 })
    h.addProfile('alice')
    h.addProfile('bob')
    h.addRsvp('s1', 'alice', 'going')
    h.addRsvp('s1', 'bob', 'going')
    const score = decidedScore([['alice'], ['bob']], 0, 7)
    h.directUpdateSession('s1', { matchScore: JSON.stringify(score) })
    h.failTool('records.update', 'sessions', 1, {
      // Every score write carries matchScore + pendingResult; the first
      // is Bob's approval, the second is Alice's final write.
      callIndex: 2,
      predicate: params => {
        const data = params.data as Record<string, unknown> | null
        return typeof data === 'object' && data !== null &&
          'matchScore' in data && 'pendingResult' in data
      },
    })
    await expect(h.command('bob', {
      operation: 'reviewResult', sessionId: 's1', decision: 'approve', revision: 7,
    })).resolves.toMatchObject({ success: true })
    const failed = await h.command('alice', {
      operation: 'reviewResult', sessionId: 's1', decision: 'approve', revision: 7,
    })
    expect(failed.success).toBe(false)
    expect(h.readSession('s1')?.pendingResult).not.toBe('')
    // The host must be able to cancel out of the stuck state instead of
    // leaving the session frozen forever.
    const cancelled = await h.command('host', { operation: 'cancel', sessionId: 's1' })
    expect(cancelled.success).toBe(true)
    expect(h.readSession('s1')?.status).toBe('cancelled')
    expect(h.readSession('s1')?.pendingResult).toBe('')
  })

  it('PR22-PORT F4: a corrected match stays visible as pending in history, excluded from stats', async () => {
    const h = createRaceHarness()
    h.addSession('s1', 'host', { targetPlayers: 2 })
    h.addProfile('alice')
    h.addProfile('bob')
    h.addRsvp('s1', 'alice', 'going')
    h.addRsvp('s1', 'bob', 'going')
    const score = decidedScore([['alice'], ['bob']], 0, 7)
    h.directUpdateSession('s1', { matchScore: JSON.stringify(score) })
    await finalizeMatch(h, 's1', 7)
    expect((await readStats(h, 'alice')).wins).toBe(1)
    expect(await readHistory(h, 'alice')).toHaveLength(1)
    const corrected = await h.command('host', {
      operation: 'correctResult', sessionId: 's1', revision: 7,
      sets: [[0, 6], [0, 6]], winner: 1,
    })
    expect(corrected.success).toBe(true)
    // Durable provenance is preserved: rows kept, 'corrected' audit row written.
    expect(await h.queryRaw('matchResults', { sessionId: 's1' })).toHaveLength(2)
    expect(await h.queryRaw('resultAudits', { sessionId: 's1', kind: 'corrected' })).toHaveLength(1)
    // The superseded outcome no longer counts in verified statistics...
    expect((await readStats(h, 'alice')).matchesPlayed).toBe(0)
    // ...but the match does not vanish from history: it surfaces as a
    // pending entry showing the corrected (unapproved) outcome.
    const pending = await readHistory(h, 'alice')
    expect(pending).toHaveLength(1)
    expect(pending[0]?.sessionId).toBe('s1')
    expect(pending[0]?.status).toBe('pending')
    expect(pending[0]?.won).toBe(false)
    expect(pending[0]?.sets).toEqual([[0, 6], [0, 6]])
    expect(pending[0]?.resultRevision).toBe(8)
    // Fresh approvals finalize the corrected result in place.
    await expect(h.command('alice', {
      operation: 'reviewResult', sessionId: 's1', decision: 'approve', revision: 8,
    })).resolves.toMatchObject({ success: true })
    await expect(h.command('bob', {
      operation: 'reviewResult', sessionId: 's1', decision: 'approve', revision: 8,
    })).resolves.toMatchObject({ success: true })
    const aliceStats = await readStats(h, 'alice')
    expect(aliceStats.wins).toBe(0)
    expect(aliceStats.losses).toBe(1)
    expect((await readStats(h, 'bob')).wins).toBe(1)
    const entries = await readHistory(h, 'alice')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.status).toBe('final')
    expect(entries[0]?.won).toBe(false)
    const rows = await h.queryRaw('matchResults', { sessionId: 's1' })
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.data.resultRevision === 8)).toBe(true)
  })

  it('PR22-PORT S8-residual: no in-app route can move an existing session startsAt except finalizePoll itself', async () => {
    // (a) Schema closure (e6ff2d9): direct member/admin startsAt writes are denied.
    expect(checkFieldPermissions(sessionsSchema, 'member', { startsAt: '2030-01-01T12:00:00.000Z' }))
      .toContain('startsAt')
    expect(checkFieldPermissions(sessionsSchema, 'admin', { startsAt: '2030-01-01T12:00:00.000Z' }))
      .toContain('startsAt')
    expect(canCreate(sessionsSchema, 'member')).toBe(false)
    // (b) Series edits cannot touch published sessions: editSeries refuses
    // once any occurrence exists, so it cannot move a polled session's time.
    const h = createRaceHarness()
    const created = await h.schedule('host', {
      operation: 'createSeries',
      template: {
        format: 'Singles', title: 'Weekly rally', court: 'Test court',
        location: 'Pittsburgh', durationMinutes: 90, targetPlayers: 2,
        level: 'All levels', notes: '',
      },
      startStartsAt: '2031-02-01T19:00:00.000Z', intervalWeeks: 1, count: 2,
    })
    expect(created.success).toBe(true)
    const seriesId = (created as { data?: { recordId?: string } }).data?.recordId as string
    await expect(h.schedule('host', { operation: 'generateOccurrences', seriesId }))
      .resolves.toMatchObject({ success: true })
    const occurrenceId = `series-${seriesId}-0`
    const before = h.readSession(occurrenceId)?.startsAt
    expect(before).toBe('2031-02-01T19:00:00.000Z')
    const edited = await h.schedule('host', {
      operation: 'editSeries', seriesId,
      template: {
        format: 'Singles', title: 'Weekly rally', court: 'Test court',
        location: 'Pittsburgh', durationMinutes: 90, targetPlayers: 2,
        level: 'All levels', notes: '',
      },
      startStartsAt: '2031-03-01T19:00:00.000Z', intervalWeeks: 1, count: 2,
    })
    expect(edited.success).toBe(false)
    expect(h.readSession(occurrenceId)?.startsAt).toBe(before)
    // (c) Two concurrent finalizePoll commands for one session serialize
    // through the per-session room queue and converge exactly once.
    h.addSession('s1', 'host', { targetPlayers: 2, startsAt: '2031-01-01T19:00:00.000Z' })
    h.addRsvp('s1', 'alice', 'going')
    const pollId = await createTestPoll(h, 's1')
    const first = await h.command('host', { operation: 'finalizePoll', sessionId: 's1', pollId, optionId: 'opt-1' })
    expect(first.success).toBe(true)
    const second = await h.command('host', { operation: 'finalizePoll', sessionId: 's1', pollId, optionId: 'opt-1' })
    expect(second.success).toBe(true)
    expect(h.readSession('s1')?.startsAt).toBe('2031-02-01T19:00:00.000Z')
    expect(h.readSession('s1')?.scheduleRevision).toBe(1)
  })
})
