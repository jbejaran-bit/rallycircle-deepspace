/**
 * In-app notification client helpers.
 *
 * The inbox itself is an ordinary DeepSpace subscription:
 * `useQuery('notifications', { where: { recipientId: userId },
 * orderBy: 'createdAt', orderDir: 'desc' })`. These helpers work over
 * those records: unread counts, stale-target resolution, and the
 * recipient-checked server actions for read state and preferences.
 * The client never writes notification records directly.
 */

import { getAuthToken } from 'deepspace'
import type { NotificationPreferences, RallyNotification } from './rally-notifications'

export interface NotificationRecord {
  recordId: string
  data: RallyNotification
  createdAt: string
}

export function isUnread(record: NotificationRecord): boolean {
  return record.data.readAt === ''
}

export function unreadCount(records: readonly NotificationRecord[]): number {
  return records.filter(isUnread).length
}

export function unreadByType(
  records: readonly NotificationRecord[],
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const record of records) {
    if (!isUnread(record)) continue
    counts[record.data.type] = (counts[record.data.type] ?? 0) + 1
  }
  return counts
}

/**
 * Resolve a notification's link target against the sessions the client can
 * see. Sessions are never hard-deleted (cancel preserves the record), so a
 * missing session means the client cannot see it — render "unavailable"
 * and never leak anything about it.
 */
export function resolveNotificationTarget(
  notification: RallyNotification,
  visibleSessionIds: ReadonlySet<string>,
): { kind: 'session'; sessionId: string } | { kind: 'unavailable' } | { kind: 'none' } {
  if (!notification.sessionId) return { kind: 'none' }
  return visibleSessionIds.has(notification.sessionId)
    ? { kind: 'session', sessionId: notification.sessionId }
    : { kind: 'unavailable' }
}

type NotificationAction =
  | { operation: 'markRead'; recordId: string }
  | { operation: 'markAllRead' }
  | { operation: 'setPreferences'; preferences: Partial<NotificationPreferences> }

interface NotificationActionResponse {
  success: boolean
  data?: { recordId: string; count?: number }
  error?: string
}

export async function runNotificationAction(action: NotificationAction): Promise<{ recordId: string; count?: number }> {
  const token = await getAuthToken()
  if (!token) throw new Error('Sign in before updating notifications.')

  const response = await fetch('/api/actions/notifications', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(action),
  })
  if (response.status === 401) throw new Error('Sign in before updating notifications.')
  const result: unknown = await response.json().catch(() => null)
  if (
    typeof result !== 'object' || result === null || Array.isArray(result) ||
    (result as Record<string, unknown>).success !== true ||
    typeof (result as Record<string, unknown>).data !== 'object' ||
    (result as Record<string, unknown>).data === null
  ) {
    const error = (result as { error?: unknown } | null)?.error
    throw new Error(typeof error === 'string' ? error : 'The notification update could not be completed. Try again.')
  }
  return (result as NotificationActionResponse).data as { recordId: string; count?: number }
}
