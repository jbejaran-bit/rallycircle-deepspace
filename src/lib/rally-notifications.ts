/**
 * In-app notifications — types, categories, opt-out preferences,
 * idempotency keys and retention bounds.
 *
 * Pure logic only. The server emitter lives in
 * `src/server/notifications.ts`; the inbox action in
 * `src/server/notification-actions.ts`. Delivery semantics (see DESIGN.md):
 * at-least-once emission with deterministic idempotency keys =
 * effectively-once delivery per event. A failed emission never fails the
 * primary command.
 */

export const NOTIFICATION_TYPES = [
  'waitlist_promoted',
  'session_cancelled',
  'schedule_changed',
  'poll_created',
  'poll_finalized',
  'result_confirmed',
  'result_disputed',
] as const

export type NotificationType = typeof NOTIFICATION_TYPES[number]

/**
 * Categories decide opt-out. `essential` notices change the recipient's
 * own status (a cancellation, a new time, a promotion) and cannot be
 * opted out of. `results` and `polls` are informational and opt-out-able.
 */
export type NotificationCategory = 'essential' | 'results' | 'polls'

export const NOTIFICATION_CATEGORY: Record<NotificationType, NotificationCategory> = {
  waitlist_promoted: 'essential',
  session_cancelled: 'essential',
  schedule_changed: 'essential',
  poll_created: 'polls',
  poll_finalized: 'polls',
  result_confirmed: 'results',
  result_disputed: 'results',
}

export interface NotificationPreferences {
  results: boolean
  polls: boolean
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  results: true,
  polls: true,
}

/** Parse the JSON preferences column. Malformed or partial input falls back to defaults. */
export function parseNotificationPreferences(raw: string | undefined): NotificationPreferences {
  if (!raw) return { ...DEFAULT_NOTIFICATION_PREFERENCES }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ...DEFAULT_NOTIFICATION_PREFERENCES }
    }
    const prefs = parsed as Record<string, unknown>
    return {
      results: typeof prefs.results === 'boolean' ? prefs.results : true,
      polls: typeof prefs.polls === 'boolean' ? prefs.polls : true,
    }
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES }
  }
}

export function serializeNotificationPreferences(prefs: NotificationPreferences): string {
  return JSON.stringify({ results: prefs.results, polls: prefs.polls })
}

/** Essential notices are always delivered; the rest honour the recipient's preferences. */
export function isNotificationEnabled(type: NotificationType, prefs: NotificationPreferences): boolean {
  const category = NOTIFICATION_CATEGORY[type]
  if (category === 'essential') return true
  if (category === 'results') return prefs.results
  return prefs.polls
}

/**
 * Deterministic idempotency keys. The key must identify the event, not the
 * attempt: a retry reuses the key and is recognised as a duplicate, while a
 * genuinely new event (a second promotion after rejoining, a second
 * schedule change) gets a different key because it names a different
 * underlying record or instant.
 */
export function waitlistPromotedKey(rsvpRecordId: string): string {
  return `waitlist_promoted:${rsvpRecordId}`
}

export function sessionCancelledKey(sessionId: string, recipientId: string): string {
  return `session_cancelled:${sessionId}:${recipientId}`
}

export function scheduleChangedKey(sessionId: string, startsAt: string, recipientId: string): string {
  return `schedule_changed:${sessionId}:${startsAt}:${recipientId}`
}

export function pollCreatedKey(pollId: string, recipientId: string): string {
  return `poll_created:${pollId}:${recipientId}`
}

export function resultConfirmedKey(sessionId: string, revision: number, recipientId: string): string {
  return `result_confirmed:${sessionId}:${revision}:${recipientId}`
}

export function resultDisputedKey(sessionId: string, revision: number, recipientId: string): string {
  return `result_disputed:${sessionId}:${revision}:${recipientId}`
}

/** Retention bound (H09): at most this many notifications are kept per user. */
export const NOTIFICATION_RETENTION_CAP = 100
/** At most this many stale rows are pruned in a single emission. */
export const NOTIFICATION_MAX_PRUNE_PER_EMIT = 5

export interface RallyNotification {
  recipientId: string
  type: NotificationType
  sessionId: string
  title: string
  body: string
  link: string
  idempotencyKey: string
  readAt: string
}
