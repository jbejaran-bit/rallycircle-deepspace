/**
 * `notifications` server action — inbox read state and preferences.
 *
 * The client can never write notification records directly (member
 * create/update/delete are all closed in the schema). Every operation
 * here loads the record first and checks `recipientId === userId` before
 * touching it — the action is the authorization boundary, per the
 * trust model in `src/server/action-routes.ts`.
 */

import type { ActionHandler, ActionResult } from 'deepspace/worker'
import type { Env } from '../../worker.js'
import {
  parseNotificationPreferences,
  serializeNotificationPreferences,
  type NotificationPreferences,
} from '../lib/rally-notifications.js'

type NotificationsResult = ActionResult<{ recordId: string; count?: number }>

function failure(error: string): NotificationsResult {
  return { success: false, error }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface NotificationRow {
  recipientId: string
  readAt: string
}

export const notificationsAction: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const operation = params.operation
  const now = new Date().toISOString()

  if (operation === 'markRead') {
    if (typeof params.recordId !== 'string' || !params.recordId) return failure('Notification not found.')
    const found = await tools.get('notifications', params.recordId)
    if (!found.success) return failure('Notification not found.')
    const record = found.data.record as unknown as { data: NotificationRow }
    // Same message as the not-found case: distinguishing "exists but not
    // yours" from "does not exist" is an existence/ownership oracle
    // (PR #20 adv-inputs item 2, ported to the PR #22 line). Record ids
    // are unguessable, so this was low severity, but the uniform string
    // costs nothing.
    if (record.data.recipientId !== userId) return failure('Notification not found.')
    if (record.data.readAt) return { success: true, data: { recordId: params.recordId } }
    const updated = await tools.update('notifications', params.recordId, { readAt: now })
    return updated.success
      ? { success: true, data: { recordId: params.recordId } }
      : failure('The notification could not be marked as read.')
  }

  if (operation === 'markAllRead') {
    // Legacy rows predate the readAt column: filtering on readAt: ''
    // never matches a row without the field, so it stayed unread forever.
    // Query by recipient only (bounded by the 100-per-user retention cap)
    // and skip already-read rows in code.
    const found = await tools.query('notifications', {
      where: { recipientId: userId },
      limit: 100,
    })
    if (!found.success) return failure('Notifications could not be loaded.')
    const records = (found.data as { records: { recordId: string; data?: { readAt?: unknown } }[] }).records
    let count = 0
    for (const record of records) {
      if (record.data?.readAt) continue
      const updated = await tools.update('notifications', record.recordId, { readAt: now })
      if (updated.success) count++
    }
    return { success: true, data: { recordId: userId, count } }
  }

  if (operation === 'setPreferences') {
    if (!isRecord(params.preferences)) return failure('Invalid notification preferences.')
    // Reject anything that is not a boolean (omitted fields keep their stored value).
    if (
      (params.preferences.results !== undefined && typeof params.preferences.results !== 'boolean') ||
      (params.preferences.polls !== undefined && typeof params.preferences.polls !== 'boolean')
    ) {
      return failure('Invalid notification preferences.')
    }
    const patch: Partial<NotificationPreferences> = {}
    if (typeof params.preferences.results === 'boolean') patch.results = params.preferences.results
    if (typeof params.preferences.polls === 'boolean') patch.polls = params.preferences.polls
    const existing = await tools.query('notificationPreferences', {
      where: { userId },
      limit: 1,
    })
    if (!existing.success) return failure('Preferences could not be loaded.')
    const rows = (existing.data as unknown as { records: { recordId: string; data: { preferences: string } }[] }).records
    const stored = serializeNotificationPreferences({
      ...parseNotificationPreferences(rows[0]?.data.preferences),
      ...patch,
    })
    if (rows[0]) {
      const updated = await tools.update('notificationPreferences', rows[0].recordId, { preferences: stored })
      return updated.success
        ? { success: true, data: { recordId: rows[0].recordId } }
        : failure('Preferences could not be saved.')
    }
    const created = await tools.create('notificationPreferences', { preferences: stored })
    return created.success
      ? { success: true, data: { recordId: created.data.recordId } }
      : failure('Preferences could not be saved.')
  }

  return failure('Invalid notification operation.')
}
