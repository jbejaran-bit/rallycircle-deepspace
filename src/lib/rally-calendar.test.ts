import { expect, it } from 'vitest'
import { buildCalendarEvent } from './rally-calendar'

const session = {
  status: 'open', startsAt: '2027-04-11T19:30:00-04:00', durationMinutes: 90,
  title: 'Doubles; practice\nBring balls', court: 'Court 2', location: 'Pittsburgh, PA',
} as const
const invite = 'https://rally.example/rallies?session=a%2Fb'
const now = new Date('2027-04-01T13:00:00Z')

it('exports UTC times across midnight and escapes event text', () => {
  const data = buildCalendarEvent(session, invite, now)
  expect(data).toContain('DTSTART:20270411T233000Z\r\nDTEND:20270412T010000Z')
  expect(data).toContain('DTSTAMP:20270401T130000Z')
  expect(data).toContain('SUMMARY:Doubles\\; practice\\nBring balls')
  expect(data).toContain('LOCATION:Court 2\\, Pittsburgh\\, PA')
  expect(data).toContain(`UID:${invite}\r\n`)
})

it('folds lines by UTF-8 byte length without splitting characters', () => {
  const title = '🎾'.repeat(72)
  const data = buildCalendarEvent({ ...session, title }, invite, now)!
  expect(data.split('\r\n').every(line => new TextEncoder().encode(line).length <= 75)).toBe(true)
  expect(data.replace(/\r\n /g, '')).toContain(`SUMMARY:${title}\r\n`)
})

it('omits events for cancelled sessions and unusable times', () => {
  expect(buildCalendarEvent({ ...session, status: 'cancelled' }, invite)).toBeNull()
  expect(buildCalendarEvent({ ...session, startsAt: 'invalid' }, invite)).toBeNull()
  expect(buildCalendarEvent({ ...session, durationMinutes: -1 }, invite)).toBeNull()
})

it('can be encoded as a download when a title contains an unpaired surrogate', () => {
  const data = buildCalendarEvent({ ...session, title: 'Practice \uD800' }, invite, now)!
  expect(() => encodeURIComponent(data)).not.toThrow()
  expect(data).toContain('SUMMARY:Practice \uFFFD')
})

it('A13: the UID is stable across exports while DTSTAMP follows the export time', () => {
  const first = buildCalendarEvent(session, invite, new Date('2027-04-01T13:00:00Z'))!
  const second = buildCalendarEvent(session, invite, new Date('2027-04-02T09:30:00Z'))!
  expect(first).toContain(`UID:${invite}\r\n`)
  expect(second).toContain(`UID:${invite}\r\n`)
  expect(first).toContain('DTSTAMP:20270401T130000Z')
  expect(second).toContain('DTSTAMP:20270402T093000Z')
  // Only the stamp differs: a calendar client treats both as the same event.
  expect(first.replace('DTSTAMP:20270401T130000Z', 'DTSTAMP:X'))
    .toBe(second.replace('DTSTAMP:20270402T093000Z', 'DTSTAMP:X'))
})

it('A13: an event spanning a daylight-saving transition keeps its absolute duration', () => {
  // US spring forward 2026-03-08 07:00 UTC: 06:30Z + 90 min = 08:00Z.
  const spring = buildCalendarEvent({ ...session, startsAt: '2026-03-08T06:30:00Z', durationMinutes: 90 }, invite, now)!
  expect(spring).toContain('DTSTART:20260308T063000Z\r\nDTEND:20260308T080000Z')
  // US fall back 2026-11-01 06:00 UTC: 05:30Z + 90 min = 07:00Z.
  const fall = buildCalendarEvent({ ...session, startsAt: '2026-11-01T05:30:00Z', durationMinutes: 90 }, invite, now)!
  expect(fall).toContain('DTSTART:20261101T053000Z\r\nDTEND:20261101T070000Z')
})

it('A13: a zero-length session produces no event', () => {
  expect(buildCalendarEvent({ ...session, durationMinutes: 0 }, invite)).toBeNull()
})
