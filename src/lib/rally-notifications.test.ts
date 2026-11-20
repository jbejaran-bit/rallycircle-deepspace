import { describe, expect, it } from 'vitest'
import {
  isNotificationEnabled,
  NOTIFICATION_RETENTION_CAP,
  parseNotificationPreferences,
  pollCreatedKey,
  resultConfirmedKey,
  resultDisputedKey,
  scheduleChangedKey,
  serializeNotificationPreferences,
  sessionCancelledKey,
  waitlistPromotedKey,
} from './rally-notifications'

describe('idempotency keys', () => {
  it('are deterministic per event and distinct per genuinely new event', () => {
    expect(waitlistPromotedKey('rsvp-1')).toBe(waitlistPromotedKey('rsvp-1'))
    expect(waitlistPromotedKey('rsvp-1')).not.toBe(waitlistPromotedKey('rsvp-2'))
    expect(sessionCancelledKey('s1', 'alice')).toBe('session_cancelled:s1:alice')
    expect(sessionCancelledKey('s1', 'alice')).not.toBe(sessionCancelledKey('s1', 'bob'))
    // A second schedule change to a different time is a new event, not a retry.
    expect(scheduleChangedKey('s1', '2026-10-24T18:00:00.000Z', 'alice'))
      .not.toBe(scheduleChangedKey('s1', '2026-10-25T18:00:00.000Z', 'alice'))
    expect(pollCreatedKey('p1', 'alice')).toBe('poll_created:p1:alice')
    expect(resultConfirmedKey('s1', 12, 'alice')).not.toBe(resultDisputedKey('s1', 12, 'alice'))
    expect(resultConfirmedKey('s1', 12, 'alice')).not.toBe(resultConfirmedKey('s1', 13, 'alice'))
  })
})

describe('notification preferences', () => {
  it('defaults to all on and keeps stored values for omitted fields', () => {
    expect(parseNotificationPreferences(undefined)).toEqual({ results: true, polls: true })
    expect(parseNotificationPreferences('not json')).toEqual({ results: true, polls: true })
    expect(parseNotificationPreferences('{"results": false}')).toEqual({ results: false, polls: true })
    expect(parseNotificationPreferences(serializeNotificationPreferences({ results: false, polls: true })))
      .toEqual({ results: false, polls: true })
  })

  it('never opts out of essential notices', () => {
    const optedOut = { results: false, polls: false }
    expect(isNotificationEnabled('session_cancelled', optedOut)).toBe(true)
    expect(isNotificationEnabled('schedule_changed', optedOut)).toBe(true)
    expect(isNotificationEnabled('waitlist_promoted', optedOut)).toBe(true)
    expect(isNotificationEnabled('result_confirmed', optedOut)).toBe(false)
    expect(isNotificationEnabled('poll_created', optedOut)).toBe(false)
    expect(isNotificationEnabled('result_confirmed', { results: true, polls: false })).toBe(true)
    expect(isNotificationEnabled('poll_created', { results: false, polls: true })).toBe(true)
  })

  it('bounds retention', () => {
    expect(NOTIFICATION_RETENTION_CAP).toBe(100)
  })
})
