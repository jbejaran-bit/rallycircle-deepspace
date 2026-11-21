/**
 * Backend package 8 — load / performance benchmarks on PR #22 (e6ff2d9).
 *
 * LABELING — read before quoting any number below:
 * Every figure here is a LOCAL MOCK-HARNESS measurement: in-memory
 * RecordRoom, 1 ms artificial latency per record fetch, single Node
 * process, 1.5-CPU shared VM. NOT production latency, NOT a product SLA,
 * NOT a Cloudflare Workers measurement. Wall times are recorded, never
 * asserted (VM load varies run to run); the asserted bounds are
 * structural: session-GET counts, exact tallies, exact fan-out counts,
 * exact row counts.
 *
 * Bounds that FAILED on the unfixed head are findings, not flakes. On the
 * unfixed head they used `it.fails` and named the sibling branch that
 * already fixed them:
 * - stats N-GET scan (item 1, N >= 50): fixed on
 *   feature/muse-pr22-stats-aggregation @ bc1fc68 (write-side `status`
 *   column; 0 GETs at 65 and 300 results).
 * - poll tally undercount past 500 votes (item 4): fixed on
 *   feature/muse-pr22-port-fixes @ 9c44dd4 (paging in refreshPollTally).
 * - cancel fan-out capped at 100 notices (item 5): fixed on
 *   feature/muse-pr22-port-fixes @ 9c44dd4 (paging in notifyRsvpHolders).
 * In the combined branch (feature/muse-pr22-combined-fixes) those fixes
 * are all present, so the five bounds are ordinary passing `it` tests
 * here — if any of them fails, the combination regressed a fix.
 *
 * Prior measurements NOT repeated here: K03 1000/1000 rapid RSVPs in
 * ~8.1 s on unfixed PR #20; R-S9b 5 s timeout artifact under parallel
 * load (passes alone); stats-aggregation GET counts 65 -> 0, 300 -> 0.
 */

import { describe, expect, it } from 'vitest'
import { parsePollTally } from '../lib/polls.js'
import { createStatsHarness } from './pr22-perf-stats-harness.js'
import { createRoomHarness } from './pr22-perf-room-harness.js'

/** Wall-clock milliseconds around an awaited step; recorded, never asserted. */
async function timed<T>(label: string, step: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now()
  const result = await step()
  const ms = performance.now() - start
  console.log(`[PERF] ${label}: ${ms.toFixed(1)} ms`)
  return { result, ms }
}

/** Deterministic win pattern: 60% wins (i % 5 < 3). */
const wonAt = (i: number) => i % 5 < 3

describe('PR22-PERF getPlayerStats wall time + session GETs', () => {
  it('stats N=0: exact empty totals, 0 session GETs', async () => {
    const h = createStatsHarness()
    h.seedProfile('alice')
    const { result: stats, ms } = await timed('getPlayerStats N=0', () => h.readStats('alice', 'alice'))
    expect(stats.singles).toMatchObject({ wins: 0, losses: 0, matchesPlayed: 0 })
    expect(h.counters.sessionGets).toBe(0)
    expect(ms).toBeGreaterThanOrEqual(0)
  })

  it('stats N=50: exact totals with 0 session GETs', { timeout: 60_000 }, async () => {
    const h = createStatsHarness()
    h.seedProfile('alice')
    for (let i = 0; i < 50; i++) h.seedFinalMatch('alice', 'bob', i, { won: wonAt(i) })
    const { result: stats } = await timed('getPlayerStats N=50', () => h.readStats('alice', 'alice'))
    expect(stats.singles).toMatchObject({ wins: 30, losses: 20, matchesPlayed: 50, provisional: false })
    expect(h.counters.sessionGets).toBe(0)
  })

  it('stats N=200: exact totals with 0 session GETs', { timeout: 60_000 }, async () => {
    const h = createStatsHarness()
    h.seedProfile('alice')
    for (let i = 0; i < 200; i++) h.seedFinalMatch('alice', 'bob', i, { won: wonAt(i) })
    const { result: stats } = await timed('getPlayerStats N=200', () => h.readStats('alice', 'alice'))
    expect(stats.singles).toMatchObject({ wins: 120, losses: 80, matchesPlayed: 200, provisional: false })
    expect(h.counters.sessionGets).toBe(0)
  })

  it('stats N=500 (old syncPlayerStats failure threshold): exact totals with 0 session GETs', { timeout: 60_000 }, async () => {
    const h = createStatsHarness()
    h.seedProfile('alice')
    for (let i = 0; i < 500; i++) h.seedFinalMatch('alice', 'bob', i, { won: wonAt(i) })
    const { result: stats } = await timed('getPlayerStats N=500', () => h.readStats('alice', 'alice'))
    expect(stats.singles).toMatchObject({ wins: 300, losses: 200, matchesPlayed: 500, provisional: false })
    expect(h.counters.sessionGets).toBe(0)
  })
})

describe('PR22-PERF getMatchHistory wall time + session GETs (limit 50)', () => {
  // Finding (package 8): on unfixed e6ff2d9 this failed at N=200 with 60
  // session GETs for 50 entries — loadVerifiedResults checked the second
  // 30-row page in full although only 20 more verified rows were needed
  // (page-granular over-fetch, worst case limit + 29). Fixed by slicing
  // each page to the rows still needed in loadVerifiedResults. Combiner
  // note: carry this slice into whichever loadVerifiedResults wins the
  // merge — the stats-aggregation branch replaces this function outright.
  it.each([0, 50, 200])('history N=%i: at most 50 entries, session GETs bounded by the history limit', { timeout: 60_000 }, async (n) => {
    const h = createStatsHarness()
    h.seedProfile('alice')
    for (let i = 0; i < n; i++) h.seedFinalMatch('alice', 'bob', i, { won: wonAt(i) })
    const { result: entries } = await timed(`getMatchHistory N=${n}`, () => h.readHistory('alice', 'alice'))
    expect(entries).toHaveLength(Math.min(n, 50))
    expect(h.counters.sessionGets).toBeLessThanOrEqual(50)
    console.log(`[PERF] getMatchHistory N=${n}: ${h.counters.sessionGets} session GETs for ${entries.length} entries`)
  })
})

describe('PR22-PERF RSVP/waitlist burst', () => {
  it('100 concurrent joins at capacity 10: exactly 10 going + 90 waitlisted, no duplicates', { timeout: 60_000 }, async () => {
    const h = createRoomHarness()
    h.addSession('burst', 'host', { capacity: 10 })
    const users = Array.from({ length: 100 }, (_, i) => `u${i}`)
    const { result: outcomes } = await timed('100 concurrent rsvp going', () =>
      Promise.all(users.map((user) => h.command(user, { operation: 'rsvp', sessionId: 'burst', status: 'going' }))),
    )
    const refused = users.filter((_, i) => !outcomes[i].success)
    expect(h.going('burst')).toHaveLength(10)
    expect(refused).toHaveLength(90)
    const { result: waitOutcomes } = await timed('90 concurrent joinWaitlist', () =>
      Promise.all(refused.map((user) => h.command(user, { operation: 'joinWaitlist', sessionId: 'burst' }))),
    )
    expect(waitOutcomes.every((outcome) => outcome.success)).toBe(true)
    expect(h.going('burst')).toHaveLength(10)
    expect(h.queued('burst')).toHaveLength(90)
    // No user in both places; every user accounted for exactly once.
    const goingUsers = new Set(h.going('burst').map((row) => row.data.userId))
    const queuedUsers = h.queued('burst')
    expect(queuedUsers.filter((user) => goingUsers.has(user))).toHaveLength(0)
    expect(new Set([...goingUsers, ...queuedUsers]).size).toBe(100)
    // No duplicate RSVP rows for any user.
    const rsvpCounts = new Map<string, number>()
    for (const row of h.rsvps.values()) {
      if (row.data.sessionId !== 'burst') continue
      rsvpCounts.set(row.data.userId, (rsvpCounts.get(row.data.userId) ?? 0) + 1)
    }
    expect([...rsvpCounts.values()].every((count) => count === 1)).toBe(true)
  })
})

describe('PR22-PERF poll tally at scale', () => {
  it('600 votes across 2 options: exact 300/300 tally', { timeout: 120_000 }, async () => {
    const h = createRoomHarness()
    h.addSession('poll-sess', 'host', { capacity: 1000 })
    const created = await h.command('host', {
      operation: 'createPoll',
      sessionId: 'poll-sess',
      options: [
        { id: 'opt-a', startsAt: '2030-01-02T18:00:00.000Z' },
        { id: 'opt-b', startsAt: '2030-01-03T18:00:00.000Z' },
      ],
    })
    expect(created.success).toBe(true)
    const pollId = (created.data as { recordId: string }).recordId
    // Seed 600 participants directly: castVote only needs an RSVP row.
    for (let i = 0; i < 600; i++) {
      const userId = `v${i}`
      h.rsvps.set(`rsvp-seed-${i}`, {
        recordId: `rsvp-seed-${i}`,
        createdBy: userId,
        createdAt: i + 1,
        data: { sessionId: 'poll-sess', userId, status: 'maybe' },
      })
    }
    const votes = Array.from({ length: 600 }, (_, i) => ({ user: `v${i}`, optionId: i < 300 ? 'opt-a' : 'opt-b' }))
    const { ms } = await timed('600 castVote commands', () =>
      Promise.all(votes.map(({ user, optionId }) =>
        h.command(user, { operation: 'castVote', sessionId: 'poll-sess', pollId, optionId }))),
    )
    const poll = [...h.polls.values()].find((row) => row.recordId === pollId)!
    const tally = parsePollTally(poll.data.tally)
    console.log(`[PERF] poll tally after 600 votes (${ms.toFixed(1)} ms): ${JSON.stringify(tally)}`)
    expect(tally).toEqual({ 'opt-a': 300, 'opt-b': 300 })
  })
})

describe('PR22-PERF notification fan-out on cancel', () => {
  it('150 RSVP holders cancelled: 150 session_cancelled notices', { timeout: 60_000 }, async () => {
    const h = createRoomHarness()
    h.addSession('fanout', 'host')
    for (let i = 0; i < 150; i++) {
      const userId = `f${i}`
      h.rsvps.set(`rsvp-seed-${i}`, {
        recordId: `rsvp-seed-${i}`,
        createdBy: userId,
        createdAt: i + 1,
        data: { sessionId: 'fanout', userId, status: 'going' },
      })
    }
    const { ms } = await timed('cancel session with 150 RSVP holders', () =>
      h.command('host', { operation: 'cancel', sessionId: 'fanout' }),
    )
    const notices = [...h.notifications.values()].filter(
      (row) => row.data.type === 'session_cancelled' && row.data.sessionId === 'fanout',
    )
    console.log(`[PERF] cancel fan-out (${ms.toFixed(1)} ms): ${notices.length} session_cancelled notices for 150 holders`)
    expect(notices).toHaveLength(150)
  })
})

describe('PR22-PERF series generation', () => {
  it('12-occurrence series: 12 sessions + 12 host RSVPs + generatedCount 12', { timeout: 60_000 }, async () => {
    const h = createRoomHarness()
    const template = {
      format: 'Doubles' as const,
      title: 'Weekly doubles',
      court: 'Schenley Park',
      location: 'Pittsburgh, PA',
      durationMinutes: 90,
      targetPlayers: 2,
      capacity: 2,
      level: 'Intermediate' as const,
      notes: '',
    }
    const created = await h.scheduleCommand('host', {
      operation: 'createSeries', template, startStartsAt: '2030-01-05T18:00:00.000Z', intervalWeeks: 1, count: 12,
    })
    expect(created.success).toBe(true)
    const seriesId = (created.data as { recordId: string }).recordId
    const sessionsBefore = h.sessions.size
    const rsvpsBefore = h.rsvps.size
    const { ms } = await timed('generateOccurrences count=12', () =>
      h.scheduleCommand('host', { operation: 'generateOccurrences', seriesId }),
    )
    const instances = [...h.sessions.values()].filter((row) => row.data.seriesId === seriesId)
    const hostRsvps = [...h.rsvps.values()].filter(
      (row) => row.data.userId === 'host' && instances.some((s) => s.recordId === row.data.sessionId),
    )
    const series = h.recurringSeries.get(seriesId)!
    console.log(`[PERF] generateOccurrences count=12 (${ms.toFixed(1)} ms): +${h.sessions.size - sessionsBefore} sessions, +${h.rsvps.size - rsvpsBefore} rsvps`)
    expect(instances).toHaveLength(12)
    expect(hostRsvps).toHaveLength(12)
    expect(series.data.generatedCount).toBe(12)
  })
})

describe('PR22-PERF K03 limiter overhead probe', () => {
  it('100 sequential attendance commands from 100 distinct users on an uncapped session', { timeout: 60_000 }, async () => {
    const h = createRoomHarness()
    h.addSession('overhead', 'host')
    const users = Array.from({ length: 100 }, (_, i) => `k${i}`)
    const { ms } = await timed('100 sequential rsvp commands (distinct users)', async () => {
      for (const user of users) {
        const outcome = await h.command(user, { operation: 'rsvp', sessionId: 'overhead', status: 'going' })
        expect(outcome.success).toBe(true)
      }
    })
    expect(h.going('overhead')).toHaveLength(100)
    console.log(`[PERF] K03 overhead probe: 100 commands in ${ms.toFixed(1)} ms (${(ms / 100).toFixed(2)} ms/command)`)
  })
})
