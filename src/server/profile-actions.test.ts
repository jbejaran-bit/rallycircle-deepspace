/**
 * Profile action tests — mock ActionTools over in-memory maps.
 *
 * The mock reproduces the two properties the handlers rely on:
 *  - tools are bound to the verified caller (userBound columns are stamped
 *    from the caller, never from params), and
 *  - tools run RBAC-off (queries see every row), so privacy is enforced by
 *    the handlers themselves, exactly as in production.
 * Direct record permissions are covered separately in
 * profile-permissions.test.ts (SDK helpers against the schemas).
 */

import { describe, expect, it } from 'vitest'
import type { ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker.js'
import {
  deleteProfileAction,
  getMatchHistoryAction,
  getPlayerStatsAction,
  updateProfileAction,
} from './profile-actions.js'

type Row = { recordId: string; createdBy: string; data: Record<string, unknown> }

function createToolsHarness() {
  const collections = new Map<string, Map<string, Row>>()
  let nextId = 0
  const getCollection = (name: string) => {
    let collection = collections.get(name)
    if (!collection) {
      collection = new Map()
      collections.set(name, collection)
    }
    return collection
  }
  const userBoundCollections = new Set(['profiles', 'playerStats', 'matchResults', 'resultAudits'])

  // Tools are built per caller, as in production (createActionTools binds
  // the verified caller id); the maps are shared across callers.
  const toolsFor = (callerId: string) => ({
    create: async (collection: string, data: Record<string, unknown>) => {
      const rows = getCollection(collection)
      if (collection === 'profiles') {
        const duplicate = [...rows.values()].some((row) => row.data.userId === callerId)
        if (duplicate) return { success: false as const, error: 'Duplicate profile' }
      }
      const recordId = `row-${++nextId}`
      const stored: Row = {
        recordId,
        createdBy: callerId,
        data: userBoundCollections.has(collection) ? { ...data, userId: callerId } : { ...data },
      }
      rows.set(recordId, stored)
      return { success: true as const, data: { recordId } }
    },
    update: async (collection: string, recordId: string, data: Record<string, unknown>) => {
      const row = getCollection(collection).get(recordId)
      if (!row) return { success: false as const, error: 'Not found' }
      Object.assign(row.data, data)
      return { success: true as const, data: { recordId } }
    },
    remove: async (collection: string, recordId: string) => {
      return getCollection(collection).delete(recordId)
        ? { success: true as const, data: { recordId } }
        : { success: false as const, error: 'Not found' }
    },
    get: async (collection: string, recordId: string) => {
      const row = getCollection(collection).get(recordId)
      return row
        ? { success: true as const, data: { record: row } }
        : { success: false as const, error: 'Record not found' }
    },
    query: async (collection: string, options: Record<string, unknown>) => {
      const where = (options.where ?? {}) as Record<string, unknown>
      let records = [...getCollection(collection).values()].filter((row) =>
        Object.entries(where).every(([key, value]) => row.data[key] === value),
      )
      const orderBy = options.orderBy as string | undefined
      if (orderBy) {
        const dir = options.orderDir === 'desc' ? -1 : 1
        records = [...records].sort((a, b) => {
          const av = String(a.data[orderBy] ?? '')
          const bv = String(b.data[orderBy] ?? '')
          return av < bv ? -dir : av > bv ? dir : 0
        })
      }
      records = records.slice(0, Number(options.limit ?? 100))
      return { success: true as const, data: { records, count: records.length } }
    },
  }) as unknown as ActionTools

  const call = (
    action: (ctx: { userId: string; params: Record<string, unknown>; tools: ActionTools; env: Env; callerJwt: string }) => Promise<unknown>,
    userId: string,
    params: Record<string, unknown> = {},
  ) => action({ userId, params, tools: toolsFor(userId), env: {} as Env, callerJwt: 'test-token' })

  const seed = (collection: string, data: Record<string, unknown>, ownerId: string) => {
    const rows = getCollection(collection)
    const recordId = `seed-${++nextId}`
    rows.set(recordId, { recordId, createdBy: ownerId, data: { ...data, userId: ownerId } })
    return recordId
  }

  return { call, seed, collections }
}

const validProfile = {
  displayName: 'Alice',
  bio: 'Weekend doubles player.',
  formats: ['Doubles'],
  preferredArea: 'Pittsburgh, PA',
  selfReportedLevel: 'Intermediate',
  visibility: 'public',
}

describe('updateProfile', () => {
  it('creates a profile under the verified caller, ignoring a forged userId in params', async () => {
    const harness = createToolsHarness()
    const result = await harness.call(updateProfileAction, 'alice', {
      ...validProfile,
      userId: 'bob',
    })
    expect(result).toMatchObject({ success: true, data: { unchanged: false } })
    const profiles = [...harness.collections.get('profiles')!.values()]
    expect(profiles).toHaveLength(1)
    expect(profiles[0].data).toMatchObject({ userId: 'alice', displayName: 'Alice' })
  })

  it('rejects invalid input with a stable code and writes nothing', async () => {
    const harness = createToolsHarness()
    const result = await harness.call(updateProfileAction, 'alice', {
      ...validProfile,
      preferredArea: '40.44, -79.99',
    })
    expect(result).toMatchObject({ success: false, code: 'invalid_profile' })
    expect(harness.collections.get('profiles')?.size ?? 0).toBe(0)
  })

  it('treats an identical re-save as an idempotent no-op', async () => {
    const harness = createToolsHarness()
    await harness.call(updateProfileAction, 'alice', validProfile)
    const again = await harness.call(updateProfileAction, 'alice', validProfile)
    expect(again).toMatchObject({ success: true, data: { unchanged: true } })
    expect(harness.collections.get('profiles')!.size).toBe(1)
  })

  it('syncs visibility to owned stats rows when a profile goes private', async () => {
    const harness = createToolsHarness()
    await harness.call(updateProfileAction, 'alice', validProfile)
    harness.seed('playerStats', { format: 'singles', wins: 2, losses: 1, matchesPlayed: 3, visibility: 'public' }, 'alice')
    const result = await harness.call(updateProfileAction, 'alice', { ...validProfile, visibility: 'private' })
    expect(result).toMatchObject({ success: true })
    const stats = [...harness.collections.get('playerStats')!.values()]
    expect(stats[0].data.visibility).toBe('private')
  })
})

describe('deleteProfile', () => {
  it('deletes the own profile, privatizes owned rows, and is idempotent', async () => {
    const harness = createToolsHarness()
    await harness.call(updateProfileAction, 'alice', validProfile)
    harness.seed('playerStats', { format: 'singles', wins: 1, losses: 0, matchesPlayed: 1, visibility: 'public' }, 'alice')
    await expect(harness.call(deleteProfileAction, 'alice')).resolves.toMatchObject({
      success: true,
      data: { deleted: true },
    })
    expect(harness.collections.get('profiles')!.size).toBe(0)
    const stats = [...harness.collections.get('playerStats')!.values()]
    expect(stats[0].data.visibility).toBe('private')
    await expect(harness.call(deleteProfileAction, 'alice')).resolves.toMatchObject({
      success: true,
      data: { deleted: false },
    })
  })
})

describe('getPlayerStats and getMatchHistory privacy gates', () => {
  it('keeps history private when a profile is absent even if a stored row was public', async () => {
    const harness = createToolsHarness()
    harness.seed('matchResults', { sessionId: 'old', visibility: 'public' }, 'alice')
    await expect(harness.call(getMatchHistoryAction, 'bob', { userId: 'alice' })).resolves.toEqual({
      success: true, data: { userId: 'alice', public: false, entries: [] },
    })
    await expect(harness.call(getPlayerStatsAction, 'bob', { userId: 'alice' })).resolves.toEqual({
      success: true, data: { userId: 'alice', public: false },
    })
  })

  it('hides a private profile and its stats from other callers but not its owner', async () => {
    const harness = createToolsHarness()
    await harness.call(updateProfileAction, 'alice', { ...validProfile, visibility: 'private' })
    await expect(harness.call(getPlayerStatsAction, 'bob', { userId: 'alice' })).resolves.toMatchObject({
      success: true,
      data: { userId: 'alice', public: false },
    })
    const own = await harness.call(getPlayerStatsAction, 'alice', { userId: 'alice' })
    expect(own).toMatchObject({ success: true, data: { public: true } })
  })

  it('returns public stats with completeness and per-format summaries', async () => {
    const harness = createToolsHarness()
    await harness.call(updateProfileAction, 'alice', validProfile)
    harness.seed('playerStats', { format: 'singles', wins: 3, losses: 2, matchesPlayed: 5, visibility: 'public' }, 'alice')
    const result = await harness.call(getPlayerStatsAction, 'bob', { userId: 'alice' })
    expect(result).toMatchObject({
      success: true,
      data: {
        public: true,
        completeness: { percent: 100, complete: true },
        stats: {
          singles: { wins: 3, losses: 2, matchesPlayed: 5, winRate: 0.6, provisional: false },
          doubles: { wins: 0, matchesPlayed: 0, winRate: null, provisional: true },
        },
      },
    })
  })

  it('returns newest-first history with the limit clamped to 1..50', async () => {
    const harness = createToolsHarness()
    await harness.call(updateProfileAction, 'alice', validProfile)
    for (const [index, date] of ['2026-11-01T18:00:00.000Z', '2026-11-18T18:00:00.000Z'].entries()) {
      harness.seed('matchResults', {
        sessionId: `s${index}`,
        format: 'singles',
        won: index,
        sets: index === 0 ? JSON.stringify([[6, 4], [6, 3]]) : [[6, 4], [6, 3]],
        resultRevision: index + 1,
        finalizedAt: date,
        visibility: 'public',
      }, 'alice')
    }
    const result = await harness.call(getMatchHistoryAction, 'bob', { userId: 'alice', limit: 500 })
    expect(result).toMatchObject({
      success: true,
      data: { public: true },
    })
    const data = (result as { data: { entries: Array<{ sessionId: string }> } }).data
    expect(data.entries.map((entry) => entry.sessionId)).toEqual(['s1', 's0'])
    await expect(harness.call(getMatchHistoryAction, 'bob', { userId: '' })).resolves.toMatchObject({
      success: false,
      code: 'invalid_user',
    })
  })
})
