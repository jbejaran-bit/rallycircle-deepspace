import { canCreate, canDelete, canUpdate } from 'deepspace/worker'
import type { ActionTools } from 'deepspace/worker'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../worker.js'
import {
  availabilityWindowsSchema,
  chatModerationSchema,
  favoriteCourtsSchema,
  matchNotesSchema,
  sessionTemplatesSchema,
} from '../schemas/extensions-schema.js'
import type { RallyRSVP, RallySession } from '../lib/rally.js'
import { awardPoint, createMatchScore } from '../lib/rally-score.js'
import { extensionActions } from './extensions-actions.js'

type Row = { recordId: string; data: Record<string, unknown>; createdAt: string; updatedAt: string }

const COLLECTIONS = [
  'sessions', 'rsvps', 'waitlists',
  'sessionTemplates', 'favoriteCourts', 'availabilityWindows', 'matchNotes', 'chatModeration',
]

function createHarness() {
  const store = new Map<string, Map<string, Row>>()
  for (const name of COLLECTIONS) store.set(name, new Map())
  let nextId = 0
  const now = Date.now()
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

  function seedSession(recordId: string, hostId: string, overrides: Partial<RallySession> = {}): Row {
    const row: Row = {
      recordId,
      data: {
        title: 'Test rally',
        court: 'Schenley Park',
        location: 'Pittsburgh',
        startsAt: '2030-06-08T14:00:00.000Z',
        durationMinutes: 90,
        targetPlayers: 4,
        level: 'All levels',
        notes: '',
        hostId,
        chatChannelId: '',
        status: 'open',
        ...overrides,
      },
      createdAt: stamp(),
      updatedAt: stamp(),
    }
    store.get('sessions')!.set(recordId, row)
    return row
  }

  /** A finalized 6-0, 6-0 win for side 0, approved by both players. */
  function finalScore(): string {
    let score = createMatchScore([['alice'], ['bob']])
    for (let point = 0; point < 48; point++) score = awardPoint(score, 0)
    return JSON.stringify({ ...score, approvals: ['alice', 'bob'] })
  }

  function disputedScore(): string {
    let score = createMatchScore([['alice'], ['bob']])
    for (let point = 0; point < 48; point++) score = awardPoint(score, 0)
    return JSON.stringify({ ...score, disputed: true })
  }

  function toolsFor(userId: string): ActionTools {
    const match = (row: Row, where: Record<string, unknown>) =>
      Object.entries(where).every(([key, value]) => row.data[key] === value)
    const sorted = (rows: Row[], orderBy = 'createdAt', orderDir: 'asc' | 'desc' = 'desc') => {
      const copy = [...rows]
      if (orderBy === 'createdAt' || orderBy === 'updatedAt') {
        copy.sort((a, b) => orderDir === 'asc'
          ? (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)
          : (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        return copy
      }
      copy.sort((a, b) => {
        const av = String((a.data as Record<string, unknown>)[orderBy] ?? '')
        const bv = String((b.data as Record<string, unknown>)[orderBy] ?? '')
        return orderDir === 'asc' ? (av < bv ? -1 : av > bv ? 1 : 0) : (av < bv ? 1 : av > bv ? -1 : 0)
      })
      return copy
    }
    return {
      create: async (collection: string, data: Record<string, unknown>) => {
        const row = seed(collection, data)
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
    action: keyof typeof extensionActions,
    userId: string,
    params: Record<string, unknown> = {},
  ) {
    return extensionActions[action]({
      userId,
      params,
      tools: toolsFor(userId),
      env: {} as Env,
      callerJwt: 'test-token',
    } as never)
  }

  return { call, seed, seedSession, finalScore, disputedScore, store }
}

const validTemplate = {
  format: 'Doubles',
  court: 'Schenley Park',
  location: 'Pittsburgh',
  durationMinutes: 90,
  targetPlayers: 4,
  level: 'Intermediate',
  notes: '',
  timeOfDay: '19:00',
}

describe('extension schemas close direct client writes', () => {
  it.each([
    ['sessionTemplates', sessionTemplatesSchema],
    ['favoriteCourts', favoriteCourtsSchema],
    ['availabilityWindows', availabilityWindowsSchema],
    ['matchNotes', matchNotesSchema],
    ['chatModeration', chatModerationSchema],
  ])('%s: member cannot create, update, or delete directly', (_name, schema) => {
    expect(canCreate(schema, 'member')).toBe(false)
    expect(canUpdate(schema, 'member', { data: {}, createdBy: 'alice' }, 'alice')).toBe(false)
    expect(canDelete(schema, 'member', { data: {}, createdBy: 'alice' }, 'alice')).toBe(false)
    expect(canCreate(schema, 'admin')).toBe(false)
  })
})

describe('searchSessions (L01)', () => {
  it('finds open future sessions by text and carries apiVersion', async () => {
    const h = createHarness()
    h.seedSession('s1', 'host', { title: 'Morning doubles', startsAt: '2030-06-08T09:00:00.000Z' })
    h.seedSession('s2', 'host', { title: 'Evening singles', startsAt: '2030-06-07T19:00:00.000Z' })
    h.seedSession('s3', 'host', { title: 'Cancelled one', status: 'cancelled' })
    h.seedSession('s4', 'host', { title: 'Past one', startsAt: '2020-01-01T00:00:00.000Z' })

    const result = await h.call('searchSessions', 'player', { q: 'singles' })
    expect(result.success).toBe(true)
    if (!result.success) return
    const data = result.data as { sessions: { recordId: string }[]; truncated: boolean; apiVersion: string }
    expect(data.apiVersion).toBe('1')
    expect(data.sessions.map(s => s.recordId)).toEqual(['s2'])
    expect(data.truncated).toBe(false)

    const all = await h.call('searchSessions', 'player', {})
    expect(all.success).toBe(true)
    if (!all.success) return
    expect((all.data as { sessions: { recordId: string }[] }).sessions.map(s => s.recordId)).toEqual(['s2', 's1'])
  })

  it('rejects bad filters', async () => {
    const h = createHarness()
    await expect(h.call('searchSessions', 'player', { format: 'squash' })).resolves.toMatchObject({ success: false })
    await expect(h.call('searchSessions', 'player', { limit: 0 })).resolves.toMatchObject({ success: false })
    await expect(h.call('searchSessions', 'player', { limit: 51 })).resolves.toMatchObject({ success: false })
    await expect(h.call('searchSessions', 'player', { fromDate: 'June 8' })).resolves.toMatchObject({ success: false })
  })
})

describe('session templates (L02)', () => {
  it('saves, lists, and deletes only the caller’s own templates', async () => {
    const h = createHarness()
    const saved = await h.call('saveSessionTemplate', 'alice', { template: validTemplate })
    expect(saved.success).toBe(true)
    if (!saved.success) return
    const recordId = (saved.data as { recordId: string }).recordId

    const listed = await h.call('listSessionTemplates', 'alice', {})
    expect(listed.success).toBe(true)
    if (!listed.success) return
    expect((listed.data as { templates: { recordId: string }[] }).templates).toHaveLength(1)

    // Another user sees none of alice's templates and cannot delete them.
    const otherList = await h.call('listSessionTemplates', 'bob', {})
    expect((otherList.data as { templates: unknown[] }).templates).toHaveLength(0)
    await expect(h.call('deleteSessionTemplate', 'bob', { recordId })).resolves.toMatchObject({
      success: false,
      error: 'This template is unavailable.',
    })
    expect(h.store.get('sessionTemplates')!.size).toBe(1)

    const deleted = await h.call('deleteSessionTemplate', 'alice', { recordId })
    expect(deleted.success).toBe(true)
    expect((deleted.data as { deleted: boolean }).deleted).toBe(true)
    // Deleting again is an idempotent no-op, not an error.
    const again = await h.call('deleteSessionTemplate', 'alice', { recordId })
    expect(again.success).toBe(true)
    expect((again.data as { deleted: boolean }).deleted).toBe(false)
  })

  it('rejects invalid templates and enforces the 20-template cap', async () => {
    const h = createHarness()
    await expect(h.call('saveSessionTemplate', 'alice', { template: { ...validTemplate, timeOfDay: '7pm' } }))
      .resolves.toMatchObject({ success: false })
    for (let i = 0; i < 20; i++) {
      h.seed('sessionTemplates', { userId: 'alice', ...validTemplate })
    }
    await expect(h.call('saveSessionTemplate', 'alice', { template: validTemplate })).resolves.toMatchObject({
      success: false,
      error: 'You can save up to 20 session templates.',
    })
  })
})

describe('favourite courts (L03)', () => {
  const court = { placeId: 'osm:way/123', name: 'Schenley Oval', lat: 40.434, lng: -79.948, locality: 'Pittsburgh' }

  it('saves idempotently, lists own only, and removes own only', async () => {
    const h = createHarness()
    const first = await h.call('saveFavoriteCourt', 'alice', { court })
    expect(first.success).toBe(true)
    if (!first.success) return
    const recordId = (first.data as { recordId: string }).recordId
    expect((first.data as { alreadySaved: boolean }).alreadySaved).toBe(false)

    const second = await h.call('saveFavoriteCourt', 'alice', { court })
    expect(second.success).toBe(true)
    expect((second.data as { alreadySaved: boolean }).alreadySaved).toBe(true)
    expect((second.data as { recordId: string }).recordId).toBe(recordId)
    expect(h.store.get('favoriteCourts')!.size).toBe(1)

    await expect(h.call('removeFavoriteCourt', 'bob', { recordId })).resolves.toMatchObject({ success: false })
    const removed = await h.call('removeFavoriteCourt', 'alice', { recordId })
    expect((removed.data as { removed: boolean }).removed).toBe(true)
  })

  it('rejects invented courts', async () => {
    const h = createHarness()
    await expect(h.call('saveFavoriteCourt', 'alice', {
      court: { ...court, placeId: 'my-driveway' },
    })).resolves.toMatchObject({ success: false, error: 'Choose a court from the court search results.' })
  })
})

describe('availability windows (L04)', () => {
  it('adds, lists, and removes windows; duplicates are idempotent', async () => {
    const h = createHarness()
    const window = { dayOfWeek: 6, startMinutes: 540, endMinutes: 720 }
    const first = await h.call('addAvailabilityWindow', 'alice', { window })
    expect(first.success).toBe(true)
    if (!first.success) return
    const recordId = (first.data as { recordId: string }).recordId
    const second = await h.call('addAvailabilityWindow', 'alice', { window })
    expect((second.data as { alreadyExists: boolean }).alreadyExists).toBe(true)
    expect(h.store.get('availabilityWindows')!.size).toBe(1)

    const removed = await h.call('removeAvailabilityWindow', 'alice', { recordId })
    expect((removed.data as { removed: boolean }).removed).toBe(true)
    await expect(h.call('addAvailabilityWindow', 'alice', {
      window: { dayOfWeek: 1, startMinutes: 600, endMinutes: 600 },
    })).resolves.toMatchObject({ success: false })
  })
})

describe('upcoming reminders (L05)', () => {
  it('returns going sessions within 24 hours, computed from live data', async () => {
    const h = createHarness()
    // The harness clock is real time; seed sessions relative to now.
    const soon = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
    const later = new Date(Date.now() + 30 * 60 * 60 * 1000).toISOString()
    h.seedSession('soon', 'host', { startsAt: soon })
    h.seedSession('later', 'host', { startsAt: later })
    h.seed('rsvps', { sessionId: 'soon', userId: 'player', status: 'going' })
    h.seed('rsvps', { sessionId: 'later', userId: 'player', status: 'going' })

    const result = await h.call('upcomingReminders', 'player', {})
    expect(result.success).toBe(true)
    if (!result.success) return
    const data = result.data as { reminders: { sessionId: string; minutesUntilStart: number }[] }
    expect(data.reminders.map(r => r.sessionId)).toEqual(['soon'])
    expect(data.reminders[0].minutesUntilStart).toBeGreaterThan(300)
    expect(data.reminders[0].minutesUntilStart).toBeLessThanOrEqual(360)
  })
})

describe('exportMyData (L06) and myMatchAudits (L07)', () => {
  it('exports only the caller’s own records and only finalized results', async () => {
    const h = createHarness()
    h.seedSession('final', 'alice', { matchScore: h.finalScore(), title: 'Final match' })
    h.seedSession('disputed', 'alice', { matchScore: h.disputedScore(), title: 'Disputed match' })
    h.seedSession('other', 'bob', { title: 'Not mine' })
    h.seed('rsvps', { sessionId: 'final', userId: 'alice', status: 'going' })
    h.seed('rsvps', { sessionId: 'final', userId: 'bob', status: 'going' })
    h.seed('rsvps', { sessionId: 'other', userId: 'alice', status: 'going' })

    const exported = await h.call('exportMyData', 'alice', {})
    expect(exported.success).toBe(true)
    if (!exported.success) return
    const data = exported.data as {
      sessions: { recordId: string }[]
      rsvps: { recordId: string }[]
      results: { sessionId: string }[]
    }
    expect(data.sessions.map(s => s.recordId).sort()).toEqual(['disputed', 'final'])
    expect(data.results.map(r => r.sessionId)).toEqual(['final'])
    expect(data.rsvps).toHaveLength(2)

    const bobExport = await h.call('exportMyData', 'bob', {})
    expect(bobExport.success).toBe(true)
    if (!bobExport.success) return
    const bobData = bobExport.data as { sessions: { recordId: string }[]; results: { sessionId: string }[] }
    expect(bobData.sessions.map(s => s.recordId)).toEqual(['other'])
    // Bob played the final match but did not host it; the export still
    // includes it because he was a recorded participant.
    expect(bobData.results.map(r => r.sessionId)).toEqual(['final'])
  })

  it('shows match audits only to recorded participants', async () => {
    const h = createHarness()
    h.seedSession('final', 'host', { matchScore: h.finalScore() })
    h.seed('rsvps', { sessionId: 'final', userId: 'alice', status: 'going' })
    h.seed('rsvps', { sessionId: 'final', userId: 'bob', status: 'going' })

    const alice = await h.call('myMatchAudits', 'alice', {})
    expect((alice.data as { audits: { status: string }[] }).audits).toHaveLength(1)
    expect((alice.data as { audits: { status: string }[] }).audits[0].status).toBe('final')
    const stranger = await h.call('myMatchAudits', 'stranger', {})
    expect((stranger.data as { audits: unknown[] }).audits).toHaveLength(0)
  })
})

describe('match notes (L08)', () => {
  it('lets only the host add notes, and only on finalized matches', async () => {
    const h = createHarness()
    h.seedSession('final', 'host', { matchScore: h.finalScore() })
    h.seedSession('open', 'host', {})
    h.seed('rsvps', { sessionId: 'final', userId: 'alice', status: 'going' })

    await expect(h.call('addMatchNote', 'alice', { sessionId: 'final', note: 'Well played.' }))
      .resolves.toMatchObject({ success: false, error: 'Only the session host can add a match note.' })
    await expect(h.call('addMatchNote', 'host', { sessionId: 'open', note: 'Well played.' }))
      .resolves.toMatchObject({ success: false, error: 'Match notes are only available on finalized matches.' })
    const added = await h.call('addMatchNote', 'host', { sessionId: 'final', note: 'Well played.' })
    expect(added.success).toBe(true)

    // Participants read; strangers do not.
    const listed = await h.call('listMatchNotes', 'alice', { sessionId: 'final' })
    expect((listed.data as { notes: unknown[] }).notes).toHaveLength(1)
    await expect(h.call('listMatchNotes', 'stranger', { sessionId: 'final' })).resolves.toMatchObject({
      success: false,
      error: 'Match notes are only visible to participants.',
    })
  })
})

describe('chat moderation (L09)', () => {
  it('lets only the host pin/remove, idempotently, and lists to participants', async () => {
    const h = createHarness()
    h.seedSession('s1', 'host', { chatChannelId: 'chan-1' })
    h.seed('rsvps', { sessionId: 's1', userId: 'alice', status: 'going' })

    await expect(h.call('pinChatMessage', 'alice', { channelId: 'chan-1', messageId: 'msg-1' }))
      .resolves.toMatchObject({ success: false, error: 'Only the session host can moderate its chat.' })
    const pinned = await h.call('pinChatMessage', 'host', { channelId: 'chan-1', messageId: 'msg-1' })
    expect(pinned.success).toBe(true)
    const again = await h.call('pinChatMessage', 'host', { channelId: 'chan-1', messageId: 'msg-1' })
    expect((again.data as { alreadyApplied: boolean }).alreadyApplied).toBe(true)
    expect(h.store.get('chatModeration')!.size).toBe(1)

    const removed = await h.call('removeChatMessage', 'host', { channelId: 'chan-1', messageId: 'msg-2' })
    expect(removed.success).toBe(true)
    const listed = await h.call('listChatModeration', 'alice', { channelId: 'chan-1' })
    expect((listed.data as { moderation: { action: string }[] }).moderation.map(m => m.action).sort())
      .toEqual(['pinned', 'removed'])
    await expect(h.call('listChatModeration', 'stranger', { channelId: 'chan-1' }))
      .resolves.toMatchObject({ success: false })

    const cleared = await h.call('clearChatModeration', 'host', { channelId: 'chan-1', messageId: 'msg-1', action: 'pinned' })
    expect((cleared.data as { cleared: boolean }).cleared).toBe(true)
    expect(h.store.get('chatModeration')!.size).toBe(1)
  })
})

describe('waitlist position (L10)', () => {
  it('returns only the caller’s own position, never the queue length or others’ spots', async () => {
    const h = createHarness()
    h.seedSession('s1', 'host', { capacity: 2 })
    h.seed('waitlists', { sessionId: 's1', userId: 'first' }, '2030-01-01T00:00:00.000Z')
    h.seed('waitlists', { sessionId: 's1', userId: 'second' }, '2030-01-01T00:01:00.000Z')
    h.seed('waitlists', { sessionId: 's1', userId: 'third' }, '2030-01-01T00:02:00.000Z')

    const second = await h.call('waitlistPosition', 'second', { sessionId: 's1' })
    expect(second.success).toBe(true)
    expect((second.data as { queued: boolean; position: number }).queued).toBe(true)
    expect((second.data as { queued: boolean; position: number }).position).toBe(2)
    // The response carries no queue length and no other user id.
    expect(JSON.stringify(second.data)).not.toContain('first')
    expect(JSON.stringify(second.data)).not.toContain('third')

    const outsider = await h.call('waitlistPosition', 'outsider', { sessionId: 's1' })
    expect((outsider.data as { queued: boolean; position: number | null }).queued).toBe(false)
    expect((outsider.data as { queued: boolean; position: number | null }).position).toBeNull()
  })
})

describe('duplicate detection (L12) and app status (L15)', () => {
  it('flags an advisory duplicate for the host’s own session', async () => {
    const h = createHarness()
    h.seedSession('orig', 'host', { startsAt: '2030-06-08T14:00:00.000Z' })
    const result = await h.call('findDuplicateSession', 'host', {
      court: 'Schenley Park',
      location: 'Pittsburgh',
      startsAt: '2030-06-08T14:03:00.000Z',
    })
    expect(result.success).toBe(true)
    expect((result.data as { duplicate: boolean; sessionId: string }).duplicate).toBe(true)
    expect((result.data as { duplicate: boolean; sessionId: string }).sessionId).toBe('orig')

    const other = await h.call('findDuplicateSession', 'someone-else', {
      court: 'Schenley Park',
      location: 'Pittsburgh',
      startsAt: '2030-06-08T14:03:00.000Z',
    })
    expect((other.data as { duplicate: boolean }).duplicate).toBe(false)
  })

  it('reports the capability status with apiVersion', async () => {
    const h = createHarness()
    const result = await h.call('appStatus', 'player', {})
    expect(result.success).toBe(true)
    if (!result.success) return
    const data = result.data as { apiVersion: string; features: Record<string, boolean> }
    expect(data.apiVersion).toBe('1')
    expect(data.features.sessionSearch).toBe(true)
    expect(data.features.waitlist).toBe(true)
    expect(data.features.chatModeration).toBe(true)
  })
})
