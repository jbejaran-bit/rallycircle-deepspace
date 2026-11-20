/**
 * In-memory mock of the SDK `ActionTools` for server-action tests.
 *
 * Faithful where it matters for these tracks:
 * - `userBound` columns are stamped from the caller id on create (the
 *   caller is supplied per tools instance, as `createActionTools` binds
 *   it in production).
 * - `create` with an explicit `recordId` upserts against that key (the
 *   SDK documents recordId creates as upserts), so deterministic ids are
 *   idempotent by construction.
 * - `query` supports equality `where`, `orderBy`/`orderDir`, and `limit`.
 * - `deleteWhere` deletes at most `limit` matching rows per call.
 * - `createdAt` is a monotonic ISO timestamp, so createdAt ordering is
 *   deterministic.
 *
 * It does NOT enforce schema permissions, uniqueness constraints, or
 * select-option validation — those are the live RecordRoom's job and are
 * recorded as unverified in the implementation log.
 */

import type { ActionResult, ActionTools } from 'deepspace/worker'

export interface MockRow {
  recordId: string
  createdAt: string
  updatedAt: string
  createdBy: string
  data: Record<string, unknown>
}

export type MockStore = Map<string, Map<string, MockRow>>

export function createMockStore(): MockStore {
  return new Map()
}

const USER_BOUND_COLUMNS: Record<string, string[]> = {
  groups: ['hostId'],
  groupMembers: ['userId'],
  sessions: ['hostId'],
  tournaments: ['hostId'],
}

let globalCounter = 0

export function mockToolsFor(store: MockStore, callerId: string): ActionTools {
  // Module-level so ids and timestamps stay unique across tools instances
  // bound to different callers (each action call builds its own instance).
  const nextCreatedAt = () => {
    globalCounter++
    return `2026-01-01T00:00:00.${String(globalCounter).padStart(3, '0')}Z`
  }
  const collection = (name: string): Map<string, MockRow> => {
    let rows = store.get(name)
    if (!rows) {
      rows = new Map()
      store.set(name, rows)
    }
    return rows
  }
  const stamp = (name: string, data: Record<string, unknown>): Record<string, unknown> => {
    const stamped = { ...data }
    for (const column of USER_BOUND_COLUMNS[name] ?? []) stamped[column] = callerId
    return stamped
  }
  const matches = (row: MockRow, where?: Record<string, unknown>): boolean =>
    !where || Object.entries(where).every(([key, value]) => row.data[key] === value)
  const sortRows = (rows: MockRow[], orderBy?: string, orderDir?: 'asc' | 'desc'): MockRow[] => {
    if (!orderBy) return rows
    const dir = orderDir === 'desc' ? -1 : 1
    return [...rows].sort((a, b) => {
      const av = orderBy === 'createdAt' ? a.createdAt : a.data[orderBy]
      const bv = orderBy === 'createdAt' ? b.createdAt : b.data[orderBy]
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
  }

  const tools = {
    create: async (name: string, data: Record<string, unknown>, recordId?: string) => {
      const rows = collection(name)
      const id = recordId ?? `rec-${++globalCounter}`
      const createdAt = nextCreatedAt()
      const row: MockRow = {
        recordId: id,
        createdAt,
        updatedAt: createdAt,
        createdBy: callerId,
        data: stamp(name, data as Record<string, unknown>),
      }
      rows.set(id, row)
      return { success: true, data: { recordId: id } } as ActionResult<{ recordId: string }>
    },
    update: async (name: string, recordId: string, data: Record<string, unknown>) => {
      const rows = collection(name)
      const row = rows.get(recordId)
      if (!row) return { success: false, error: 'Record not found' } as ActionResult<{ recordId: string }>
      Object.assign(row.data, data)
      return { success: true, data: { recordId } } as ActionResult<{ recordId: string }>
    },
    remove: async (name: string, recordId: string) => {
      const deleted = collection(name).delete(recordId)
      return deleted
        ? ({ success: true, data: { recordId } } as ActionResult<{ recordId: string }>)
        : ({ success: false, error: 'Record not found' } as ActionResult<{ recordId: string }>)
    },
    deleteWhere: async (name: string, where: Record<string, unknown>, limit = 100) => {
      const rows = collection(name)
      let deleted = 0
      for (const [id, row] of [...rows.entries()]) {
        if (deleted >= limit) break
        if (matches(row, where)) {
          rows.delete(id)
          deleted++
        }
      }
      return { success: true, data: { deleted } } as ActionResult<{ deleted: number }>
    },
    get: async (name: string, recordId: string) => {
      const row = collection(name).get(recordId)
      if (!row) return { success: false, error: 'Record not found' } as ActionResult<never>
      return { success: true, data: { record: row } } as ActionResult<{ record: MockRow }>
    },
    query: async (name: string, options?: { where?: Record<string, unknown>; orderBy?: string; orderDir?: 'asc' | 'desc'; limit?: number }) => {
      const rows = sortRows(
        [...collection(name).values()].filter(row => matches(row, options?.where)),
        options?.orderBy,
        options?.orderDir,
      )
      const limited = options?.limit !== undefined ? rows.slice(0, options.limit) : rows
      return {
        success: true,
        data: { records: limited, count: limited.length },
      } as ActionResult<{ records: MockRow[]; count: number }>
    },
    integration: async () => ({ success: false, error: 'Integrations are not available in tests' }),
    registerUser: async () => ({ success: false, error: 'User registration is not available in tests' }),
  }
  return tools as unknown as ActionTools
}

/** Seed a session row directly (fixture setup, bypassing actions). */
export function seedSession(
  store: MockStore,
  recordId: string,
  data: Record<string, unknown>,
): void {
  let rows = store.get('sessions')
  if (!rows) {
    rows = new Map()
    store.set('sessions', rows)
  }
  rows.set(recordId, {
    recordId,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: (data.hostId as string) ?? '',
    data,
  })
}
