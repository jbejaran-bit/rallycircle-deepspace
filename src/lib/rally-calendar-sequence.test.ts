import { describe, expect, it } from 'vitest'
import { buildCalendarEvent } from './rally-calendar'

const session = {
  status: 'open', startsAt: '2027-04-11T19:30:00-04:00', durationMinutes: 90,
  title: 'Doubles practice', court: 'Court 2', location: 'Pittsburgh, PA',
  scheduleRevision: 2,
} as const
const invite = 'https://rally.example/rallies?session=a%2Fb'
const now = new Date('2027-04-01T13:00:00Z')

describe('calendar SEQUENCE (G09)', () => {
  it('omits SEQUENCE on the initial export and includes it after a schedule change', () => {
    const initial = buildCalendarEvent({ ...session, scheduleRevision: 0 }, invite, now)!
    expect(initial).not.toContain('SEQUENCE:')
    const updated = buildCalendarEvent(session, invite, now, { sequence: session.scheduleRevision })!
    expect(updated).toContain('SEQUENCE:2\r\n')
    expect(updated).toContain(`UID:${invite}\r\n`)
    expect(updated).toContain('DTSTART:20270411T233000Z')
  })

  it('keeps the default output byte-identical to the no-options call', () => {
    const a = buildCalendarEvent(session, invite, now)!
    const b = buildCalendarEvent(session, invite, now, {})!
    expect(a).toBe(b)
  })
})

describe('calendar cancellation (G09)', () => {
  it('emits METHOD:CANCEL with the same UID and STATUS:CANCELLED for a cancelled session', () => {
    const cancelled = buildCalendarEvent(
      { ...session, status: 'cancelled' },
      invite,
      now,
      { method: 'CANCEL', sequence: 3 },
    )!
    expect(cancelled).toContain('METHOD:CANCEL\r\n')
    expect(cancelled).toContain(`UID:${invite}\r\n`)
    expect(cancelled).toContain('STATUS:CANCELLED\r\n')
    expect(cancelled).toContain('SEQUENCE:3\r\n')
    expect(cancelled).toContain('DTSTART:20270411T233000Z')
  })

  it('still omits plain exports for cancelled sessions', () => {
    expect(buildCalendarEvent({ ...session, status: 'cancelled' }, invite, now)).toBeNull()
  })
})
