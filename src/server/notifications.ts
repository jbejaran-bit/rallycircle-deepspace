/**
 * In-app notification emitter — best-effort, idempotent, bounded.
 *
 * Called from the command room AFTER the primary write has succeeded.
 * This module never throws into the caller: a failed emission is logged
 * (idempotency key only, no tokens or personal data) and the primary
 * command still succeeds. There is no background retry queue — a lost
 * notification stays lost until the next event (see DESIGN.md §8).
 *
 * Identity note: `recipientId` is a `userBound` column, so the RecordRoom
 * stamps it from the tool call's `X-User-Id`. The emitter therefore passes
 * the RECIPIENT's id as the tool's `userId` and omits `recipientId` from
 * `data` — exactly the pattern the existing RSVP code uses
 * (`save(player, …)` in `rally-command-room.ts`).
 */

import type { ActionResult } from 'deepspace/worker'
import {
  isNotificationEnabled,
  NOTIFICATION_MAX_PRUNE_PER_EMIT,
  NOTIFICATION_RETENTION_CAP,
  parseNotificationPreferences,
  type NotificationPreferences,
  type NotificationType,
} from '../lib/rally-notifications.js'

export type NotificationRecordTool = <T>(
  tool: string,
  params: Record<string, unknown>,
  userId: string,
) => Promise<ActionResult<T>>

export interface EmitNotificationInput {
  recipientId: string
  type: NotificationType
  sessionId?: string
  title: string
  body: string
  link?: string
  idempotencyKey: string
}

export type EmitResult = 'sent' | 'skipped-opt-out' | 'duplicate' | 'failed'

interface NotificationRecord {
  recordId: string
  data: { recipientId: string; idempotencyKey: string; readAt: string }
  createdAt: string
}

interface QueryResult<T> {
  records: { recordId: string; data: T; createdAt: string }[]
}

async function loadPreferences(
  tool: NotificationRecordTool,
  userId: string,
): Promise<NotificationPreferences | null> {
  try {
    const result = await tool<QueryResult<{ userId: string; preferences: string }>>(
      'records.query',
      { collection: 'notificationPreferences', where: { userId }, limit: 1 },
      userId,
    )
    if (!result.success) return null
    const row = result.data.records[0]
    return row ? parseNotificationPreferences(row.data.preferences) : null
  } catch {
    return null
  }
}

async function pruneOldest(
  tool: NotificationRecordTool,
  recipientId: string,
): Promise<void> {
  try {
    const result = await tool<QueryResult<{ recipientId: string }>>(
      'records.query',
      {
        collection: 'notifications',
        where: { recipientId },
        limit: NOTIFICATION_RETENTION_CAP + 1,
        orderBy: 'createdAt',
        orderDir: 'asc',
      },
      recipientId,
    )
    if (!result.success) return
    const records = result.data.records
    if (records.length <= NOTIFICATION_RETENTION_CAP) return
    const excess = records.slice(0, records.length - NOTIFICATION_RETENTION_CAP)
      .slice(0, NOTIFICATION_MAX_PRUNE_PER_EMIT)
    for (const record of excess) {
      await tool('records.delete', { collection: 'notifications', recordId: record.recordId }, recipientId)
    }
  } catch {
    // Pruning is best-effort; a failure must not affect the caller.
  }
}

/**
 * Emit one notification. Returns whether it was sent, skipped by opt-out,
 * recognised as a duplicate, or failed (logged, not thrown).
 */
export async function emitNotification(
  tool: NotificationRecordTool,
  input: EmitNotificationInput,
): Promise<EmitResult> {
  try {
    // Essential notices skip the preferences lookup entirely.
    if (input.type !== 'waitlist_promoted' && input.type !== 'session_cancelled' && input.type !== 'schedule_changed') {
      const prefs = await loadPreferences(tool, input.recipientId)
      if (prefs && !isNotificationEnabled(input.type, prefs)) return 'skipped-opt-out'
    }

    const existing = await tool<QueryResult<NotificationRecord['data']>>(
      'records.query',
      {
        collection: 'notifications',
        where: { recipientId: input.recipientId, idempotencyKey: input.idempotencyKey },
        limit: 1,
      },
      input.recipientId,
    )
    if (existing.success && existing.data.records.length > 0) return 'duplicate'

    const created = await tool<{ recordId: string }>(
      'records.create',
      {
        collection: 'notifications',
        data: {
          type: input.type,
          sessionId: input.sessionId ?? '',
          title: input.title.slice(0, 200),
          body: input.body.slice(0, 500),
          link: (input.link ?? '').slice(0, 500),
          idempotencyKey: input.idempotencyKey,
          readAt: '',
        },
      },
      input.recipientId,
    )
    if (!created.success) {
      // The composite uniqueOn is the backstop: a duplicate that raced
      // the check above lands here and is still a duplicate, not an error.
      const again = await tool<QueryResult<NotificationRecord['data']>>(
        'records.query',
        {
          collection: 'notifications',
          where: { recipientId: input.recipientId, idempotencyKey: input.idempotencyKey },
          limit: 1,
        },
        input.recipientId,
      )
      if (again.success && again.data.records.length > 0) return 'duplicate'
      console.error(`[notifications] emit failed key=${JSON.stringify(input.idempotencyKey)}`)
      return 'failed'
    }

    await pruneOldest(tool, input.recipientId)
    return 'sent'
  } catch {
    console.error(`[notifications] emit failed key=${JSON.stringify(input.idempotencyKey)}`)
    return 'failed'
  }
}
