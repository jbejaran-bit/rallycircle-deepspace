import { canCreate, canDelete, canUpdate } from 'deepspace/worker'
import type { ActionTools } from 'deepspace/worker'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../worker.js'
import { blocksSchema, discoveryPreferencesSchema, followsSchema, reportsSchema } from '../schemas/social-schema.js'
import type { RallyRSVP, RallySession } from '../lib/rally.js'
import { socialActions } from './social-actions.js'

type Row = { recordId: string; data: Record<string, unknown>; createdAt: string; updatedAt: string }

const OWNER_FIELD: Record<string, string> = {
  follows: 'followerId',
  blocks: 'blockerId',
  reports: 'reporterId',
  discoveryPreferences: 'userId',
}
const UNIQUE_ON: Record<string, string[]> = {
  follows: ['followerId', 'followeeId'],
  blocks: ['blockerId', 'blockedId'],
  discoveryPreferences: ['userId'],
}

function createHarness() {
  const store = new Map<string, Map<string, Row>>()
  for (const name of ['follows', 'blocks', 'reports', 'discoveryPreferences', 'sessions', 'rsvps']) {
    store.set(name, new Map())
  }
  let nextId = 0
  // The handlers rate-limit against the real clock (Date.now()), so the
  // harness clock must track real time too — a faked future clock would make
  // every record look "recent" forever.
  let now = Date.now()

  const stamp = () => new Date(now).toISOString()

  function seed(collection: string, data: Record<string, unknown>, createdAt?: string): Row {
    const row: Row = {
      recordId: `${collection}-${++nextId}`,
      data: { ...data },
      createdAt: createdAt ?? stamp(),
      updatedAt: createdAt ?? stamp(),
    }
    store.get(collection)!.set(row.recordId, row)
    return row
  }

  function seedSession(recordId: string, hostId: string, overrides: Partial<RallySession> = {}, createdAt?: string): Row {
    const row: Row = {
      recordId,
      data: {
        title: 'Test rally',
        court: 'Schenley Park',
        location: 'Pittsburgh',
        startsAt: '2030-06-01T14:00:00.000Z',
        durationMinutes: 90,
        targetPlayers: 4,
        level: 'All levels',
        notes: '',
        hostId,
        chatChannelId: '',
        status: 'open',
        ...overrides,
      },
      createdAt: createdAt ?? stamp(),
      updatedAt: createdAt ?? stamp(),
    }
    store.get('sessions')!.set(recordId, row)
    return row
  }

  function toolsFor(userId: string): ActionTools {
    const match = (row: Row, where: Record<string, unknown>) =>
      Object.entries(where).every(([key, value]) => row.data[key] === value)
    const sorted = (rows: Row[], orderBy = 'createdAt', orderDir: 'asc' | 'desc' = 'desc') =>
      [...rows].sort((a, b) => {
        const av = String((a.data as Record<string, unknown>)[orderBy] ?? a[orderBy as 'createdAt'])
        const bv = String((b.data as Record<string, unknown>)[orderBy] ?? b[orderBy as 'createdAt'])
        if (orderBy === 'createdAt' || orderBy === 'updatedAt') {
          return orderDir === 'asc' ? (a.createdAt < b.createdAt ? -1 : 1) : a.createdAt < b.createdAt ? 1 : -1
        }
        return orderDir === 'asc' ? (av < bv ? -1 : 1) : av < bv ? 1 : -1
      })
    return {
      create: async (collection: string, data: Record<string, unknown>) => {
        const ownerField = OWNER_FIELD[collection]
        const full = ownerField ? { ...data, [ownerField]: userId } : { ...data }
        const unique = UNIQUE_ON[collection]
        if (unique) {
          const clash = [...store.get(collection)!.values()].some(row =>
            unique.every(key => row.data[key] === full[key]),
          )
          if (clash) return { success: false as const, error: 'Duplicate record' }
        }
        const row = seed(collection, full)
        return { success: true as const, data: { recordId: row.recordId } }
      },
      update: async (collection: string, recordId: string, data: Record<string, unknown>) => {
        const row = store.get(collection)!.get(recordId)
        if (!row) return { success: false as const, error: 'Record not found' }
        Object.assign(row.data, data)
        row.updatedAt = stamp()
        return { success: true as const, data: { recordId } }
      },
      remove: async (collection: string, recordId: string) => {
        const deleted = store.get(collection)!.delete(recordId)
        return deleted
          ? { success: true as const, data: { recordId } }
          : { success: false as const, error: 'Record not found' }
      },
      deleteWhere: async (collection: string, where: Record<string, unknown>, limit?: number) => {
        let deleted = 0
        for (const row of [...store.get(collection)!.values()]) {
          if (deleted >= (limit ?? 100)) break
          if (match(row, where)) {
            store.get(collection)!.delete(row.recordId)
            deleted += 1
          }
        }
        return { success: true as const, data: { deleted } }
      },
      get: async (collection: string, recordId: string) => {
        const row = store.get(collection)!.get(recordId)
        return row
          ? { success: true as const, data: { record: row } }
          : { success: false as const, error: 'Record not found' }
      },
      query: async (collection: string, options: Record<string, unknown>) => {
        const where = (options.where ?? {}) as Record<string, unknown>
        const rows = sorted(
          [...store.get(collection)!.values()].filter(row => match(row, where)),
          String(options.orderBy ?? 'createdAt'),
          (options.orderDir as 'asc' | 'desc') ?? 'desc',
        ).slice(0, Number(options.limit ?? 50))
        return { success: true as const, data: { records: rows, count: rows.length } }
      },
      integration: async () => ({ success: false as const, error: 'Not used here' }),
      registerUser: async () => ({ success: false as const, error: 'Not used here' }),
    } as unknown as ActionTools
  }

  async function call(
    action: keyof typeof socialActions,
    userId: string,
    params: Record<string, unknown> = {},
  ) {
    return socialActions[action]({
      userId,
      params,
      tools: toolsFor(userId),
      env: {} as Env,
      callerJwt: 'test-token',
    } as never)
  }

  return { call, seed, seedSession, store }
}

describe('social schemas close direct client writes', () => {
  it.each([
    ['follows', followsSchema],
    ['blocks', blocksSchema],
    ['reports', reportsSchema],
    ['discoveryPreferences', discoveryPreferencesSchema],
  ])('%s: member cannot create, update, or delete directly', (_name, schema) => {
    expect(canCreate(schema, 'member')).toBe(false)
    expect(canUpdate(schema, 'member', { data: {}, createdBy: 'alice' }, 'alice')).toBe(false)
    expect(canDelete(schema, 'member', { data: {}, createdBy: 'alice' }, 'alice')).toBe(false)
  })
})

describe('followUser / unfollowUser', () => {
  it('creates a follow with a Track H notification draft, and repeats are idempotent', async () => {
    const h = createHarness()
    const first = await h.call('followUser', 'alice', { followeeId: 'bob' })
    expect(first.success).toBe(true)
    if (!first.success) return
    const data = first.data as { recordId: string; alreadyFollowing: boolean; notification: unknown }
    expect(data.alreadyFollowing).toBe(false)
    expect(data.notification).toMatchObject({ type: 'follow', recipientId: 'bob', actorId: 'alice' })
    const second = await h.call('followUser', 'alice', { followeeId: 'bob' })
    expect(second.success).toBe(true)
    expect((second.data as { recordId: string; alreadyFollowing: boolean }).alreadyFollowing).toBe(true)
    expect((second.data as { recordId: string }).recordId).toBe(data.recordId)
    expect(h.store.get('follows')!.size).toBe(1)
  })

  it('ignores a forged userId in params and uses the verified caller', async () => {
    const h = createHarness()
    const result = await h.call('followUser', 'bob', { followeeId: 'carol', userId: 'alice' })
    expect(result.success).toBe(true)
    const row = [...h.store.get('follows')!.values()][0]
    expect(row.data.followerId).toBe('bob')
  })

  it('rejects self-follows and invalid ids', async () => {
    const h = createHarness()
    await expect(h.call('followUser', 'alice', { followeeId: 'alice' })).resolves.toMatchObject({
      success: false,
      error: 'You cannot follow yourself.',
    })
    await expect(h.call('followUser', 'alice', { followeeId: '' })).resolves.toMatchObject({ success: false })
    await expect(h.call('followUser', 'alice', {})).resolves.toMatchObject({ success: false })
  })

  it('enforces the 30-follows-per-minute rate limit', async () => {
    const h = createHarness()
    for (let i = 0; i < 30; i++) {
      await expect(h.call('followUser', 'alice', { followeeId: `user-${i}` })).resolves.toMatchObject({ success: true })
    }
    await expect(h.call('followUser', 'alice', { followeeId: 'user-30' })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('too quickly'),
    })
  })

  it('allows follows again once the rate window has passed', async () => {
    const h = createHarness()
    // Seed 30 follows created 61 seconds ago: outside the rolling window.
    const old = new Date(Date.now() - 61_000).toISOString()
    for (let i = 0; i < 30; i++) {
      h.seed('follows', { followerId: 'alice', followeeId: `user-${i}` }, old)
    }
    await expect(h.call('followUser', 'alice', { followeeId: 'user-30' })).resolves.toMatchObject({ success: true })
  })

  it('enforces the 500-follow total cap', async () => {
    const h = createHarness()
    // Seed long ago so the per-minute rate limit does not fire first.
    for (let i = 0; i < 500; i++) {
      h.seed('follows', { followerId: 'alice', followeeId: `user-${i}` }, '2020-01-01T00:00:00.000Z')
    }
    await expect(h.call('followUser', 'alice', { followeeId: 'user-500' })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('follow limit'),
    })
  })

  it('unfollow is idempotent and removes the row', async () => {
    const h = createHarness()
    await h.call('followUser', 'alice', { followeeId: 'bob' })
    await expect(h.call('unfollowUser', 'alice', { followeeId: 'bob' })).resolves.toMatchObject({ success: true })
    await expect(h.call('unfollowUser', 'alice', { followeeId: 'bob' })).resolves.toMatchObject({ success: true })
    expect(h.store.get('follows')!.size).toBe(0)
  })
})

describe('blockUser / unblockUser', () => {
  it('blocks, severs follows in both directions, and hides the player from follow attempts', async () => {
    const h = createHarness()
    await h.call('followUser', 'alice', { followeeId: 'bob' })
    await h.call('followUser', 'bob', { followeeId: 'alice' })
    await expect(h.call('blockUser', 'alice', { blockedId: 'bob' })).resolves.toMatchObject({ success: true })
    expect(h.store.get('follows')!.size).toBe(0)
    await expect(h.call('followUser', 'alice', { followeeId: 'bob' })).resolves.toMatchObject({
      success: false,
      error: 'This player is not available.',
    })
    await expect(h.call('followUser', 'bob', { followeeId: 'alice' })).resolves.toMatchObject({
      success: false,
      error: 'This player is not available.',
    })
    await expect(h.call('blockUser', 'alice', { blockedId: 'alice' })).resolves.toMatchObject({
      success: false,
      error: 'You cannot block yourself.',
    })
    await expect(h.call('unblockUser', 'alice', { blockedId: 'bob' })).resolves.toMatchObject({ success: true })
    await expect(h.call('followUser', 'alice', { followeeId: 'bob' })).resolves.toMatchObject({ success: true })
  })
})

describe('getFollowers / getFollowing / getMutualFollows', () => {
  it('paginates newest-first with a createdAt cursor', async () => {
    const h = createHarness()
    h.seed('follows', { followerId: 'u1', followeeId: 'bob' }, '2030-01-01T00:00:00.000Z')
    h.seed('follows', { followerId: 'u2', followeeId: 'bob' }, '2030-01-02T00:00:00.000Z')
    h.seed('follows', { followerId: 'u3', followeeId: 'bob' }, '2030-01-03T00:00:00.000Z')
    const first = await h.call('getFollowers', 'alice', { userId: 'bob', limit: 2 })
    expect(first.success).toBe(true)
    const firstData = first.data as { users: { userId: string }[]; nextCursor: string | null; hidden: boolean }
    expect(firstData.users.map(user => user.userId)).toEqual(['u3', 'u2'])
    expect(firstData.nextCursor).toBe('2030-01-02T00:00:00.000Z')
    expect(firstData.hidden).toBe(false)
    const second = await h.call('getFollowers', 'alice', { userId: 'bob', limit: 2, before: firstData.nextCursor })
    expect((second.data as { users: { userId: string }[] }).users.map(user => user.userId)).toEqual(['u1'])
    expect((second.data as { nextCursor: string | null }).nextCursor).toBeNull()
  })

  it('hides lists across a block without leaking the block direction', async () => {
    const h = createHarness()
    await h.call('followUser', 'carol', { followeeId: 'alice' })
    await h.call('blockUser', 'alice', { blockedId: 'bob' })
    const blocked = await h.call('getFollowers', 'bob', { userId: 'alice' })
    expect(blocked.data).toMatchObject({ users: [], hidden: true })
    const own = await h.call('getFollowers', 'alice', { userId: 'alice' })
    expect((own.data as { users: unknown[] }).users).toHaveLength(1)
  })

  it('computes mutual follows as the intersection of both following lists', async () => {
    const h = createHarness()
    await h.call('followUser', 'alice', { followeeId: 'carol' })
    await h.call('followUser', 'alice', { followeeId: 'dave' })
    await h.call('followUser', 'bob', { followeeId: 'carol' })
    await h.call('followUser', 'bob', { followeeId: 'erin' })
    const mutual = await h.call('getMutualFollows', 'alice', { userId: 'bob' })
    expect((mutual.data as { users: { userId: string }[] }).users.map(user => user.userId)).toEqual(['carol'])
  })
})

describe('reportContent', () => {
  it('stores a validated report and enforces the hourly cap', async () => {
    const h = createHarness()
    const result = await h.call('reportContent', 'alice', { targetType: 'user', targetId: 'bob', reason: 'Harassing messages' })
    expect(result.success).toBe(true)
    const row = [...h.store.get('reports')!.values()][0]
    expect(row.data).toMatchObject({ reporterId: 'alice', targetType: 'user', targetId: 'bob', status: 'open' })
    await expect(h.call('reportContent', 'alice', { targetType: 'post', targetId: 'bob', reason: 'x' })).resolves.toMatchObject({ success: false })
    await expect(h.call('reportContent', 'alice', { targetType: 'user', targetId: 'bob', reason: '' })).resolves.toMatchObject({ success: false })
    await expect(
      h.call('reportContent', 'alice', { targetType: 'user', targetId: 'bob', reason: 'x'.repeat(501) }),
    ).resolves.toMatchObject({ success: false })
    for (let i = 0; i < 19; i++) {
      await h.call('reportContent', 'alice', { targetType: 'user', targetId: `user-${i}`, reason: 'spam' })
    }
    await expect(
      h.call('reportContent', 'alice', { targetType: 'user', targetId: 'last', reason: 'spam' }),
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('too many reports') })
  })
})

describe('discovery preferences', () => {
  const valid = {
    formats: ['doubles'],
    level: 'Intermediate',
    area: 'Schenley',
    radiusMiles: 10,
    timeStart: '12:00',
    timeEnd: '18:00',
    days: [6],
  }
  it('saves and loads the caller’s own preferences, and rejects invalid ones', async () => {
    const h = createHarness()
    const before = await h.call('getDiscoveryPreferences', 'alice', {})
    expect(before.data).toMatchObject({ saved: false })
    await expect(h.call('saveDiscoveryPreferences', 'alice', { preferences: { ...valid, radiusMiles: 500 } })).resolves.toMatchObject({ success: false })
    const saved = await h.call('saveDiscoveryPreferences', 'alice', { preferences: valid })
    expect(saved.success).toBe(true)
    const loaded = await h.call('getDiscoveryPreferences', 'alice', {})
    expect(loaded.data).toMatchObject({ saved: true, preferences: valid })
    // A forged userId in params cannot save for someone else.
    await h.call('saveDiscoveryPreferences', 'bob', { preferences: valid, userId: 'alice' })
    const aliceLoaded = await h.call('getDiscoveryPreferences', 'alice', {})
    expect(aliceLoaded.data).toMatchObject({ preferences: valid })
    const bobLoaded = await h.call('getDiscoveryPreferences', 'bob', {})
    expect(bobLoaded.data).toMatchObject({ saved: true, preferences: valid })
  })
})

describe('getPlayedWith', () => {
  it('derives shared sessions and finalized matches, and hides blocked players', async () => {
    const h = createHarness()
    h.seedSession('s1', 'alice')
    h.seedSession('s2', 'bob', {
      matchScore: JSON.stringify({
        revision: 5,
        teams: [['alice', 'carol'], ['bob', 'dave']],
        points: [0, 0],
        games: [0, 0],
        sets: [[6, 2], [6, 3]],
        winner: 0,
        approvals: ['alice', 'carol', 'bob', 'dave'],
        disputed: false,
      }),
    })
    for (const [sessionId, userId] of [
      ['s1', 'alice'], ['s1', 'bob'],
      ['s2', 'alice'], ['s2', 'bob'], ['s2', 'carol'], ['s2', 'dave'],
    ] as const) {
      h.seed('rsvps', { sessionId, userId, status: 'going' })
    }
    const result = await h.call('getPlayedWith', 'alice', {})
    expect(result.success).toBe(true)
    const players = (result.data as { players: { userId: string; sharedSessions: number; matchesTogether: number }[] }).players
    expect(players.find(entry => entry.userId === 'bob')).toMatchObject({ sharedSessions: 2, matchesTogether: 0 })
    expect(players.find(entry => entry.userId === 'carol')).toMatchObject({ sharedSessions: 1, matchesTogether: 1 })
    await h.call('blockUser', 'alice', { blockedId: 'dave' })
    const afterBlock = await h.call('getPlayedWith', 'alice', {})
    expect(
      ((afterBlock.data as { players: { userId: string }[] }).players).some(entry => entry.userId === 'dave'),
    ).toBe(false)
  })
})

describe('getActivityFeed', () => {
  it('shows followed players’ public events and finalized matches, never cancelled or blocked ones', async () => {
    const h = createHarness()
    h.seedSession('s1', 'alice', {}, '2030-01-01T00:00:00.000Z')
    h.seedSession('s2', 'bob', {
      matchScore: JSON.stringify({
        revision: 5,
        teams: [['bob'], ['carol']],
        points: [0, 0],
        games: [0, 0],
        sets: [[6, 2], [6, 3]],
        winner: 1,
        approvals: ['bob', 'carol'],
        disputed: false,
      }),
    }, '2030-01-02T00:00:00.000Z')
    h.seedSession('s3', 'dave', { status: 'cancelled' }, '2030-01-03T00:00:00.000Z')
    h.seedSession('s4', 'erin', {}, '2030-01-04T00:00:00.000Z')
    await h.call('followUser', 'alice', { followeeId: 'bob' })
    await h.call('blockUser', 'alice', { blockedId: 'erin' })
    const feed = await h.call('getActivityFeed', 'alice', {})
    expect(feed.success).toBe(true)
    const events = (feed.data as { events: { type: string; sessionId: string }[] }).events
    expect(events.map(event => `${event.type}:${event.sessionId}`)).toEqual([
      'session-created:s2',
      'match-finalized:s2',
      'session-created:s1',
    ])
  })
})

describe('discoverGames', () => {
  it('ranks by preferences with understandable reasons and marks capacity state', async () => {
    const h = createHarness()
    h.seedSession('s1', 'host-a', { format: 'Doubles', level: 'Intermediate', startsAt: '2030-06-01T14:00:00.000Z' })
    h.seedSession('s2', 'host-b', { format: 'Singles', level: 'Advanced', capacity: 2, startsAt: '2030-06-01T15:00:00.000Z' })
    h.seed('rsvps', { sessionId: 's2', userId: 'p1', status: 'going' })
    h.seed('rsvps', { sessionId: 's2', userId: 'p2', status: 'going' })
    await h.call('saveDiscoveryPreferences', 'alice', {
      preferences: {
        formats: ['doubles'],
        level: 'Intermediate',
        area: 'Schenley',
        radiusMiles: 10,
        timeStart: '12:00',
        timeEnd: '18:00',
        days: [6],
      },
    })
    const result = await h.call('discoverGames', 'alice', {
      filters: {},
      knownCourts: [{ name: 'Schenley Park', lat: 40.434, lng: -79.948 }],
      userLocation: { lat: 40.44, lng: -79.95 },
    })
    expect(result.success).toBe(true)
    const data = result.data as { games: { recordId: string; score: number; reasons: string[]; status: string }[]; truncated: boolean; appliedPreferences: boolean }
    expect(data.appliedPreferences).toBe(true)
    expect(data.truncated).toBe(false)
    expect(data.games.map(game => game.recordId)).toEqual(['s1', 's2'])
    expect(data.games[0].reasons).toContain('level-match')
    expect(data.games[1]).toMatchObject({ status: 'full' })
    expect(data.games[1].reasons).toContain('session-full')
  })

  it('excludes cancelled and past sessions and never fabricates a distance', async () => {
    const h = createHarness()
    h.seedSession('s1', 'host-a', { status: 'cancelled' })
    h.seedSession('s2', 'host-b', { startsAt: '2020-01-01T14:00:00.000Z' })
    h.seedSession('s3', 'host-c', { court: 'Mystery Courts', location: 'Nowhere' })
    const result = await h.call('discoverGames', 'alice', {
      filters: {},
      userLocation: { lat: 40.44, lng: -79.95 },
    })
    expect(result.success).toBe(true)
    const data = result.data as { games: { recordId: string; distanceMiles: number | null }[] }
    expect(data.games.map(game => game.recordId)).toEqual(['s3'])
    expect(data.games[0].distanceMiles).toBeNull()
  })

  it('reports truncation when the bounded windows are exceeded', async () => {
    const h = createHarness()
    for (let i = 0; i < 201; i++) h.seedSession(`s-${i}`, 'host')
    const result = await h.call('discoverGames', 'alice', { filters: {} })
    expect(result.success).toBe(true)
    expect((result.data as { truncated: boolean }).truncated).toBe(true)
  })
})
