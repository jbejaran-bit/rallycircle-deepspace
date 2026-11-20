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
