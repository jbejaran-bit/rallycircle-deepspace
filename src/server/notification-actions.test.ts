import { describe, expect, it } from 'vitest'
import type { ActionTools } from 'deepspace/worker'
import { notificationsAction } from './notification-actions.js'

function stubTools() {
  const prefs = new Map<string, { recordId: string; data: { userId: string; preferences: string } }>()
  const notes = new Map<string, { recordId: string; data: { recipientId: string; readAt: string } }>()
  // The stub emulates the platform's userBound stamping: the action's
  // create call carries no userId, so the RecordRoom stamps it from the
  // tool call identity. The test sets it per call, below.
  let currentUser = ''
  return {
    prefs, notes,
    setUser: (userId: string) => { currentUser = userId },
    tools: {
      get: async (collection: string, recordId: string) => {
        const record = collection === 'notifications' ? notes.get(recordId) : undefined
        return record
          ? { success: true as const, data: { record } }
          : { success: false as const, error: 'Record not found' }
      },
      query: async (collection: string, options: Record<string, unknown>) => {
        const where = options.where as Record<string, unknown>
        if (collection === 'notificationPreferences') {
          const records = [...prefs.values()].filter(row => row.data.userId === where.userId)
          return { success: true as const, data: { records } }
        }
        const records = [...notes.values()].filter(row =>
          Object.entries(where).every(([key, value]) => (row.data as Record<string, unknown>)[key] === value))
        return { success: true as const, data: { records } }
      },
      update: async (collection: string, recordId: string, data: Record<string, unknown>) => {
        const target = collection === 'notificationPreferences' ? prefs.get(recordId) : notes.get(recordId)
        if (!target) return { success: false as const, error: 'Record not found' }
        Object.assign(target.data, data)
        return { success: true as const, data: { recordId } }
      },
      create: async (collection: string, data: Record<string, unknown>) => {
        const recordId = `${collection}-${Math.random().toString(36).slice(2)}`
        if (collection === 'notificationPreferences') {
          prefs.set(recordId, { recordId, data: { userId: currentUser, preferences: data.preferences as string } })
        }
        return { success: true as const, data: { recordId } }
      },
    } as unknown as ActionTools,
  }
}

describe('notificationsAction preferences', () => {
  it('merges partial updates over stored preferences instead of resetting them', async () => {
    const { prefs, tools, setUser } = stubTools()
    const call = (userId: string, params: Record<string, unknown>) => {
      setUser(userId)
      return notificationsAction({ userId, params, tools, env: {} as never, callerJwt: 'test-token' })
    }
    await expect(call('alice', { operation: 'setPreferences', preferences: { polls: false } }))
      .resolves.toMatchObject({ success: true })
    expect(JSON.parse([...prefs.values()][0].data.preferences)).toEqual({ results: true, polls: false })
    await expect(call('alice', { operation: 'setPreferences', preferences: { results: false } }))
      .resolves.toMatchObject({ success: true })
    expect(JSON.parse([...prefs.values()][0].data.preferences)).toEqual({ results: false, polls: false })
    await expect(call('alice', { operation: 'setPreferences', preferences: { polls: 'yes' } }))
      .resolves.toMatchObject({ success: false })
    await expect(call('alice', { operation: 'markRead', recordId: 'missing' }))
      .resolves.toMatchObject({ success: false })
  })
})

describe('notificationsAction markRead', () => {
  it('returns the same error for a nonexistent notification and another user\'s notification (no existence/ownership oracle)', async () => {
    const { notes, tools, setUser } = stubTools()
    notes.set('n1', { recordId: 'n1', data: { recipientId: 'alice', readAt: '' } })
    const call = (userId: string, params: Record<string, unknown>) => {
      setUser(userId)
      return notificationsAction({ userId, params, tools, env: {} as never, callerJwt: 'test-token' })
    }
    const missing = await call('alice', { operation: 'markRead', recordId: 'no-such-notification' })
    const others = await call('bob', { operation: 'markRead', recordId: 'n1' })
    expect(missing).toMatchObject({ success: false, error: 'Notification not found.' })
    expect(others).toMatchObject({ success: false, error: 'Notification not found.' })
    expect((missing as { error: string }).error).toBe((others as { error: string }).error)
    await expect(call('alice', { operation: 'markRead', recordId: 'n1' }))
      .resolves.toMatchObject({ success: true })
  })
})
